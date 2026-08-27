// LIVE-INSTANCE TIER: deploy
// See docs/live-instance-operations.md for what this tier permits.
//
// Highest tier comes from `provisionClientInstance`, which runs `railway
// up` -- a one-shot snapshot upload from the local working tree,
// unconnected to any git push or PR merge. The two update functions below
// are a tier lower (restart-or-redeploy-triggering) and carry their own
// markers. On the credential axis the module is not uniform:
// `provisionClientInstance` both requires and returns secrets -- it
// generates and reads back SETUP_PASSWORD and OPENCLAW_GATEWAY_TOKEN and
// returns both to its caller. The two update functions write a non-secret
// ref variable but do read SETUP_PASSWORD back, purely to authenticate
// their own post-redeploy readiness check; they never return it or place
// it on a command line.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  approveOwnDevicePairing,
  describeDeviceApprovalStatus,
  type ApproveOwnDeviceStatus
} from "./approve-own-device.js";
import {
  createSecret,
  ensureDomainPort,
  findTemplateService,
  listDomains,
  listServices,
  mergeEnv,
  pollServiceUntilSuccess,
  waitForSetupReady,
  DEFAULT_SETUP_USERNAME,
  writeLocalText,
  type InstallerDependencies,
  type InstallerService,
  type SetupAuth
} from "./index.js";
import { patchAllowedOrigins, type PatchAllowedOriginsStatus, describePatchAllowedOriginsStatus } from "./patch-allowed-origins.js";
import { readRailwayVariable, writeRailwayVariable } from "./railway-variables.js";
import { readTemplateLock } from "./template-lock.js";

// Issue #16: deploy this repo's own Dockerfile per client via `railway up`
// (a one-shot snapshot, not continuously tracked), with a per-client
// `OPENCLAW_TEMPLATE_REF` service variable overriding the Dockerfile's
// `ARG` default. Ordering is load-bearing: variables must be written
// *before* the build that's allowed to succeed, because `railway up`
// doesn't apply railway.toml's `[variables]` block and the missing /data
// volume hard-fails any deploy via `requiredMountPath`. So bootstrap runs
// one throwaway `up` just to create the service object, then link + attach
// the volume + write every variable with `--skip-deploys`, then triggers
// the one real build via `redeploy` (per docs.railway.com/cli/redeploy,
// redeploy "creates a new deployment from the same source, which includes
// a build" — no second upload needed).

export interface ProvisionClientOptions {
  clientName: string;
  /** Link to this existing Railway project instead of creating a new one. Required for idempotent reruns. */
  projectId?: string;
  workspace?: string;
  targetPort?: number;
  /** Defaults to deploy/openclaw-railway/template-lock.json's pinnedCommit. */
  templateRef?: string;
  setupUsername?: string;
  setupPassword?: string;
  gatewayToken?: string;
  pollSeconds?: number;
  timeoutMinutes?: number;
  /** Re-run the full bootstrap sequence even if a service already exists in the linked project. */
  forceNew?: boolean;
  envLocalPath?: string;
  handoffPath?: string;
  writeLocalFiles?: boolean;
}

export interface ProvisionClientDependencies extends InstallerDependencies {
  readTemplateLock?: () => Promise<{ pinnedCommit: string }>;
}

export interface ProvisionClientResult {
  serviceId: string;
  serviceName: string;
  projectId?: string;
  templateRef: string;
  domain: string;
  setupUrl: string;
  openclawUrl: string;
  healthUrl: string;
  setupUsername: string;
  setupPassword: string;
  gatewayToken: string;
  /**
   * The single link a fresh browser/device needs to connect the dashboard,
   * fully authenticated -- no manual "paste the gateway token" step.
   * Confirmed live (dogfood throwaway fixture, 2026-08-17): OpenClaw's own
   * Control UI reads a `#token=` URL fragment on load and auto-connects,
   * the same mechanism the wrapper's own pairing-required panel documents
   * (`openclaw dashboard --no-open`) -- this just constructs that URL
   * directly from data this function already has, without needing that
   * console command (which isn't in the wrapper's allowlist anyway).
   */
  dashboardUrl: string;
  reusedExistingService: boolean;
  wroteEnvLocal: boolean;
  wroteHandoff: boolean;
  patchedAllowedOrigins: boolean;
  /** Disambiguates `patchedAllowedOrigins:false` -- see `PatchAllowedOriginsStatus`. */
  allowedOriginsStatus: PatchAllowedOriginsStatus;
  approvedDeviceRequestId?: string;
  /** Disambiguates an absent `approvedDeviceRequestId` -- see `ApproveOwnDeviceStatus`. */
  deviceApprovalStatus: ApproveOwnDeviceStatus;
}

interface ResolvedProvisionOptions {
  clientName: string;
  projectId?: string;
  workspace?: string;
  targetPort: number;
  templateRef: string;
  setupUsername: string;
  setupPassword: string;
  gatewayToken: string;
  pollSeconds: number;
  timeoutMinutes: number;
  forceNew: boolean;
  envLocalPath: string;
  handoffPath: string;
  writeLocalFiles: boolean;
}

const DEFAULT_TEMPLATE_LOCK_PATH = "deploy/openclaw-railway/template-lock.json";

// LIVE-INSTANCE TIER: deploy
// Runs `railway up` (snapshot upload), attaches a volume, writes six
// service variables, and triggers a build via `redeploy --yes`. Reuses an
// existing healthy service instead of redeploying it when one is already
// present and `--force-new` was not passed, and waits on the auth-gated
// `/setup/api/status` -- not an unauthenticated healthcheck -- before
// touching instance config.
export async function provisionClientInstance(
  options: ProvisionClientOptions,
  dependencies: ProvisionClientDependencies
): Promise<ProvisionClientResult> {
  const resolved = await resolveProvisionOptions(options, dependencies);

  if (resolved.projectId) {
    await dependencies.runner.run(["link", "--project", resolved.projectId, "--json"]);
  } else {
    const initArgs = ["init", "--name", resolved.clientName, "--json"];
    if (resolved.workspace) {
      initArgs.push("--workspace", resolved.workspace);
    }
    await dependencies.runner.run(initArgs);
  }

  const servicesBefore = await listServices(dependencies.runner);
  const existing = selectSoleService(servicesBefore, resolved.clientName, "linked project");
  let reusedExistingService = false;
  let service: InstallerService;

  if (existing && !resolved.forceNew) {
    const status = existing.latestDeployment?.status;
    if (status !== "SUCCESS") {
      throw new Error(
        `Service '${existing.name}' already exists in this project with status '${status ?? "unknown"}'. ` +
          `Inspect logs with: railway logs --service ${existing.name} --lines 200`
      );
    }
    reusedExistingService = true;
    service = existing;
  } else {
    await dependencies.runner.run(["up", "--detach", "--json"]);

    // Diff service IDs before/after `up`, rather than indexing into
    // `service list` output, so the newly created service is identified
    // correctly even if the project already had other services (ordering
    // isn't guaranteed) or `forceNew` re-ran bootstrap against a project
    // that already had one.
    const beforeIds = new Set(servicesBefore.map((s) => s.id));
    const servicesAfter = await listServices(dependencies.runner);
    const createdCandidates = servicesAfter.filter((s) => !beforeIds.has(s.id));
    const created = selectSoleService(createdCandidates, resolved.clientName, "services created by 'railway up'");
    if (!created) {
      throw new Error(`No new Railway service was found after 'railway up' for client '${resolved.clientName}'.`);
    }

    // Link the newly created service, then attach the volume with no
    // -s/--service flag: `railway volume add --mount-path /data --service
    // <name>` panics (confirmed against the live CLI, issue #16).
    await dependencies.runner.run(["service", created.name]);
    await dependencies.runner.run(["volume", "add", "--mount-path", "/data"]);

    const variableEntries: Array<[string, string]> = [
      ["OPENCLAW_TEMPLATE_REF", resolved.templateRef],
      ["PORT", String(resolved.targetPort)],
      ["OPENCLAW_STATE_DIR", "/data/.openclaw"],
      ["OPENCLAW_WORKSPACE_DIR", "/data/workspace"],
      ["SETUP_PASSWORD", resolved.setupPassword],
      ["OPENCLAW_GATEWAY_TOKEN", resolved.gatewayToken]
    ];
    for (const [name, value] of variableEntries) {
      await writeRailwayVariable({ name, value, service: created.name, skipDeploys: true }, dependencies);
    }

    await dependencies.runner.run(["redeploy", "--service", created.name, "--yes", "--json"]);
    service = await pollServiceUntilSuccess(created.name, resolved.pollSeconds, resolved.timeoutMinutes, dependencies);
  }

  // Never regenerate a credential that may already have been handed off to
  // a client — read back what's actually on the service instead. A missing
  // value here is a real inconsistency (the service exists but was never
  // fully provisioned), not something to paper over with a freshly
  // generated password that wouldn't match the service's actual auth
  // configuration — fail loudly so the operator investigates or reprovisions.
  let setupPassword = resolved.setupPassword;
  let gatewayToken = resolved.gatewayToken;
  if (reusedExistingService) {
    const existingPassword = await readRailwayVariable("SETUP_PASSWORD", service.name, dependencies);
    if (!existingPassword) {
      throw new Error(
        `Service '${service.name}' exists but has no SETUP_PASSWORD variable set. ` +
          `Re-run with --force-new to reprovision, or set SETUP_PASSWORD manually before retrying.`
      );
    }
    setupPassword = existingPassword;

    const existingToken = await readRailwayVariable("OPENCLAW_GATEWAY_TOKEN", service.name, dependencies);
    if (!existingToken) {
      throw new Error(
        `Service '${service.name}' exists but has no OPENCLAW_GATEWAY_TOKEN variable set. ` +
          `Re-run with --force-new to reprovision, or set OPENCLAW_GATEWAY_TOKEN manually before retrying.`
      );
    }
    gatewayToken = existingToken;
  }

  const domain = await ensureDomainPort(service.name, resolved.targetPort, dependencies.runner);
  const baseUrl = `https://${domain.domain}`;
  const healthUrl = `${baseUrl}/setup/healthz`;

  // Auth-gated readiness signal, not `/setup/healthz`: an unauthenticated
  // healthcheck can return 200 from a container mid-transition, before the
  // *new*/reused setup credentials are actually live (issue #18 item 3,
  // ported here from the marketplace install path after #16 and #18
  // landed in parallel and both touched this readiness check).
  const setupAuth: SetupAuth = { username: resolved.setupUsername, password: setupPassword };
  const setupStatusUrl = `${baseUrl}/setup/api/status`;
  await waitForSetupReady(setupStatusUrl, setupAuth, resolved.pollSeconds, resolved.timeoutMinutes, dependencies);

  // Issue #23: #22 added these two steps to the marketplace install path
  // (installOpenClawOnRailway) and ported only the readiness poll above
  // into this provisioning path, not these -- confirmed live (dogfood
  // throwaway fixture, 2026-08-16/17) that a provisionClientInstance
  // instance's dashboard chat fails with "origin not allowed" and would
  // also need a manual device-pairing approval without them. Mirrors
  // installOpenClawOnRailway's call order and dependency wiring exactly.
  const { patched: patchedAllowedOrigins, status: allowedOriginsStatus } = await patchAllowedOrigins(
    baseUrl,
    setupAuth,
    domain.domain,
    { getConfigRaw: dependencies.getConfigRaw, postConfigRaw: dependencies.postConfigRaw }
  );
  const { requestId: approvedDeviceRequestId, status: deviceApprovalStatus } = await approveOwnDevicePairing(
    baseUrl,
    setupAuth,
    { getPendingDevices: dependencies.getPendingDevices, approveDevice: dependencies.approveDevice }
  );

  const openclawUrl = `${baseUrl}/openclaw`;
  const resultBase = {
    serviceId: service.id,
    serviceName: service.name,
    ...(resolved.projectId ? { projectId: resolved.projectId } : {}),
    templateRef: resolved.templateRef,
    domain: domain.domain,
    setupUrl: `${baseUrl}/setup`,
    openclawUrl,
    healthUrl,
    setupUsername: resolved.setupUsername,
    setupPassword,
    gatewayToken,
    dashboardUrl: `${openclawUrl}#token=${gatewayToken}`,
    reusedExistingService,
    patchedAllowedOrigins,
    allowedOriginsStatus,
    deviceApprovalStatus,
    ...(approvedDeviceRequestId ? { approvedDeviceRequestId } : {})
  } satisfies Omit<ProvisionClientResult, "wroteEnvLocal" | "wroteHandoff">;

  let wroteEnvLocal = false;
  let wroteHandoff = false;
  if (resolved.writeLocalFiles) {
    await writeProvisionEnvLocal(resolved.envLocalPath, resultBase, dependencies);
    wroteEnvLocal = true;
    await writeLocalText(resolved.handoffPath, buildProvisionHandoff(resultBase), dependencies);
    wroteHandoff = true;
  }

  return { ...resultBase, wroteEnvLocal, wroteHandoff };
}

/**
 * Expected-current-ref value meaning "I expect this variable to be unset".
 * Needed because a freshly provisioned client has no application-ref
 * variable until its first bump; see updateClientRefVariable.
 */
export const EXPECTED_REF_UNSET = "<unset>";

export interface UpdateClientTemplateRefOptions {
  service: string;
  templateRef: string;
  /** The ref the caller believes is currently set. A mismatch aborts the update. */
  expectedCurrentRef: string;
  /**
   * Redeploy even when the variable already reads as the requested ref. For
   * recovering an instance whose previous update wrote the ref and then
   * failed before the redeploy or readiness completed.
   */
  forceRedeploy?: boolean;
  setupUsername?: string;
  pollSeconds?: number;
  timeoutMinutes?: number;
}

export interface UpdateClientTemplateRefResult {
  serviceName: string;
  templateRef: string;
  /** False when the service was already at this ref and nothing was redeployed. */
  changed: boolean;
  /**
   * True only when this call observed a *new* deployment reach SUCCESS, saw
   * `/setup/api/status` answer afterwards, and read the variable back as the
   * requested ref.
   *
   * Deliberately named for what those checks establish and no more. They do
   * NOT establish that the running deployment was built from this ref --
   * nothing reachable from here exposes the ref a running build came from.
   * Callers must not turn this into "this ref is running".
   */
  newDeploymentReady: boolean;
}

// LIVE-INSTANCE TIER: restart-or-redeploy-triggering
// Compare-and-swap, then redeploy, then an auth-gated readiness check.
// Shared by both ref-update paths below, which differ only in which
// variable they set.
//
// Three properties this exists to guarantee, each closing a prior gap
// (docs/live-instance-operations.md, gap G1):
//
//  1. A no-op never redeploys. The current value is read first; if it
//     already equals the requested ref, nothing is written and the live
//     service is left alone. Previously a same-value call still restarted
//     a healthy instance for no benefit.
//  2. The caller must state what it believes is currently set. A mismatch
//     throws instead of overwriting, which is the confirmation the restart
//     tier requires: the operator has to know what they are replacing.
//     This is NOT an atomic compare-and-swap and does not make concurrent
//     updates safe. The read and the write are separate calls, so two
//     invocations can both read the same current value, both pass this
//     check, and both write -- last one wins. What it does catch is drift
//     that already existed at read time (someone changed the ref earlier
//     and the caller is working from a stale assumption), which is the
//     common case. Real serialization would need a provider-side
//     conditional write, which the Railway CLI does not expose, or a lock
//     shared by every writer. Tracked as the still-open concurrency half
//     of gap G1.
//  3. Deployment SUCCESS is not treated as "the instance works". After the
//     redeploy this waits on the auth-gated /setup/api/status, the same
//     signal provisionClientInstance uses, because a container can report
//     a finished deployment while not yet answering authenticated requests.
//
// The redeploy still passes --yes. Deliberate, and reviewed more than once:
// the target is named by `service`, which is required here, reaches the CLI
// as an explicit `--service` flag, and cannot fall back to whatever is
// locally linked (guard-cli.ts enforces that for direct CLI use). The
// operator therefore does name the target. `expectedCurrentRef` is a
// separate, additional precondition about live state.
//
// A further argument echoing the service name back was considered and
// rejected: it adds friction to every legitimate call, is the kind of
// ceremony that gets pasted past without being read, and would not tell an
// operator anything they did not just type on the same command line. An
// interactive prompt was rejected too -- these paths run from scripts, and a
// prompt that only appears sometimes is worse than none. See
// docs/live-instance-operations.md §5.2 for how the approval rule is met.
//
// The "never touches any other service" guarantee is still enforced only by
// `service` being a required parameter -- prose, not a runtime assertion
// (gap G6).
/**
 * Thrown when the instance is healthy but the variable does not read back as
 * the ref that was requested. Distinct from a readiness failure because the
 * two need different recovery actions.
 */
class RefVerificationError extends Error {}

/**
 * Waits for the service to answer an authenticated request. Shared by the
 * post-redeploy path and the already-at-this-ref path, because "the variable
 * says the right thing" and "the instance is actually serving it" are
 * different claims and only the second one is worth reporting as success.
 */
async function assertInstanceReady(
  params: {
    service: string;
    setupUsername?: string | undefined;
    pollSeconds: number;
    timeoutMinutes: number;
  },
  dependencies: InstallerDependencies,
  contextForFailure?: string
): Promise<void> {
  // NOTE: this wants one named variable, but no targeted read exists:
  // `railway variable --help` offers only `list`, `set`, and `delete`, and
  // `list` returns every variable on the service -- OPENCLAW_GATEWAY_TOKEN
  // included -- through this process. Verified against the CLI, not
  // assumed, so nobody spends time looking for a narrower call that is not
  // there. Suppressing stdout in the CLI stops terminal echo; it does not
  // narrow what is read. This was raised as an added caller on gap G4
  // (issue #45); G4 was closed by narrowing, not by a guarded read, once
  // tracing the real runner showed stdout was already never echoed here --
  // see docs/live-instance-operations.md §7.
  const setupPassword = await readRailwayVariable("SETUP_PASSWORD", params.service, dependencies);
  if (!setupPassword) {
    throw new Error("the service has no SETUP_PASSWORD to authenticate with");
  }

  const { domains } = await listDomains(params.service, dependencies.runner);
  const domain = domains.find((candidate) => candidate.type === "service") ?? domains[0];
  if (!domain) {
    throw new Error("the service has no domain");
  }

  try {
    await waitForSetupReady(
      `https://${domain.domain}/setup/api/status`,
      { username: params.setupUsername ?? DEFAULT_SETUP_USERNAME, password: setupPassword },
      params.pollSeconds,
      params.timeoutMinutes,
      dependencies
    );
  } catch (cause) {
    if (contextForFailure === undefined) {
      throw cause;
    }
    throw new Error(
      `${contextForFailure}, but the instance is not answering authenticated requests, so it cannot be ` +
        `confirmed to be running it. Two different causes look identical here, and they need different ` +
        `fixes. If this client uses a non-default setup username, the check may be authenticating as ` +
        `'${params.setupUsername ?? DEFAULT_SETUP_USERNAME}' and getting a 401 -- re-run with the correct ` +
        `setup username (--setup-username / -SetupUsername) before anything else, because redeploying will ` +
        `not fix a credential mismatch and costs another restart. If the credentials are known good, the ` +
        `likely cause is a previous attempt that wrote the ref and failed before its redeploy completed: ` +
        `re-run with the force-redeploy option (--force-redeploy, -ForceRedeploy, or forceRedeploy: true), ` +
        `passing the already-written ref as the expected current ref.`,
      { cause }
    );
  }
}

async function updateClientRefVariable(
  params: {
    service: string;
    variableName: "OPENCLAW_TEMPLATE_REF" | "OPENCLAW_GIT_REF";
    nextRef: string;
    expectedCurrentRef: string;
    setupUsername?: string | undefined;
    /** Redeploy even when the variable already reads as the requested ref. */
    forceRedeploy?: boolean | undefined;
    pollSeconds: number;
    timeoutMinutes: number;
  },
  dependencies: InstallerDependencies
): Promise<{ changed: boolean; newDeploymentReady: boolean }> {
  const current = await readRailwayVariable(params.variableName, params.service, dependencies);

  // A freshly provisioned client has no OPENCLAW_GIT_REF variable at all:
  // provisionClientInstance writes the template ref and the runtime vars, but
  // the application ref exists only as a Dockerfile build-time ARG default,
  // never as a service variable. Refusing outright on "unset" would make the
  // first application-version bump impossible on every client this package
  // provisions. So "unset" is a legitimate expected state the caller can
  // declare, rather than an error -- it just has to be declared, exactly like
  // any other expected value.
  if (current === undefined) {
    if (params.expectedCurrentRef !== EXPECTED_REF_UNSET) {
      throw new Error(
        `Refusing to update ${params.variableName} on '${params.service}': expected it to currently be ` +
          `'${params.expectedCurrentRef}', but the variable is not set at all. If that is expected -- ` +
          `provisioning does not set OPENCLAW_GIT_REF, so a client has none until its first application-version ` +
          `bump; OPENCLAW_TEMPLATE_REF *is* set at provisioning, so an unset one means an externally managed or ` +
          `repaired service -- pass '${EXPECTED_REF_UNSET}' as the expected current ref.`
      );
    }
  } else if (params.expectedCurrentRef === EXPECTED_REF_UNSET) {
    throw new Error(
      `Refusing to update ${params.variableName} on '${params.service}': caller expected it to be unset, ` +
        `but it is '${current}'. Re-read the current value and retry if the update is still intended.`
    );
  }

  if (current === params.nextRef && !params.forceRedeploy) {
    // The caller still has to have been right about the current value. This
    // check has to happen here rather than only below, because reaching this
    // branch with a stale expected value would otherwise report a successful
    // no-op for a caller whose belief about live state was wrong -- and would
    // contradict the recovery guidance, which says passing the pre-failure
    // ref is refused.
    if (params.expectedCurrentRef !== params.nextRef) {
      throw new Error(
        `Refusing to treat ${params.variableName} on '${params.service}' as already up to date: it reads as ` +
          `'${current}', but the caller expected '${params.expectedCurrentRef}'. If a previous attempt wrote ` +
          `this ref and then failed, retry with the written ref as the expected value (and forceRedeploy to ` +
          `redeploy it).`
      );
    }

    // The variable already reads as the requested ref -- but it is written
    // *before* the redeploy, and everything after that write can fail. So a
    // matching variable is not proof the running deployment is on this ref.
    //
    // Confirm the instance is at least answering authenticated requests
    // before calling this a no-op, so a wedged instance is never reported as
    // success. Be precise about what that does and does not establish: it
    // proves *a* deployment is serving, not that the serving deployment was
    // built from this ref. Nothing reachable from here exposes the ref a
    // running deployment was built from, so that stronger claim cannot be
    // made -- if you need certainty after a failed attempt, use forceRedeploy
    // and let the deployment-rollover guard prove a new deployment landed.
    await assertInstanceReady(params, dependencies, `${params.variableName} already reads as '${params.nextRef}'`);
    return { changed: false, newDeploymentReady: false };
  }

  if (current !== undefined && current !== params.expectedCurrentRef) {
    throw new Error(
      `Refusing to update ${params.variableName} on '${params.service}': expected it to currently be ` +
        `'${params.expectedCurrentRef}', but it is '${current}'. Something else changed it. Re-read the ` +
        `current value and retry if the update is still intended.`
    );
  }

  // Captured before the write so the post-redeploy poll can reject the
  // deployment that was already there. If it is unavailable the guard cannot
  // work at all, and silently continuing would fall back to accepting the
  // first SUCCESS seen -- possibly the pre-redeploy one, which is the race
  // this exists to close. Refuse now, while nothing has been changed yet.
  const priorDeploymentId = findTemplateService(await listServices(dependencies.runner), params.service)
    ?.latestDeployment?.id;
  if (priorDeploymentId === undefined) {
    throw new Error(
      `Refusing to update ${params.variableName} on '${params.service}': its current deployment id could not ` +
        `be read, so a redeploy could not be distinguished from the deployment already running. Nothing has ` +
        `been changed. Confirm the service exists and has a deployment, then retry.`
    );
  }

  try {
    await writeRailwayVariable(
      { name: params.variableName, value: params.nextRef, service: params.service, skipDeploys: true },
      dependencies
    );
  } catch (cause) {
    // A transport-level failure can arrive *after* the service accepted the
    // write, so this is not safely "nothing happened". Say so, rather than
    // letting the caller retry as though the service were untouched.
    throw new Error(
      `Writing ${params.variableName}='${params.nextRef}' to '${params.service}' failed, and it is not certain ` +
        `whether the value was applied before the failure: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. Re-read the live value before retrying.`,
      { cause }
    );
  }

  // Everything from here on runs *after* the variable has already changed on
  // the live service. Any failure below therefore leaves a modified,
  // unverified instance -- a materially different situation from "the update
  // did not happen". Every path out of here has to say which one it is, so
  // the whole tail is wrapped rather than relying on each individual check
  // to remember: a runner failure, a terminal deployment state, or a
  // readiness timeout would otherwise surface as a bare platform error that
  // reads like nothing was touched.
  try {
    await dependencies.runner.run(["redeploy", "--service", params.service, "--yes", "--json"]);
    // Pass the deployment observed before the redeploy so the poll cannot
    // accept it as this redeploy's success (see pollServiceUntilSuccess).
    await pollServiceUntilSuccess(
      params.service,
      params.pollSeconds,
      params.timeoutMinutes,
      dependencies,
      priorDeploymentId
    );

    await assertInstanceReady(params, dependencies);

    // Post-write verification, the second half the protocol's own
    // idempotent-write rule requires. A healthy instance is not proof it is
    // healthy on the ref that was asked for: the write could have been
    // accepted and not applied, or another writer could have replaced it in
    // the meantime, and readiness would still answer 200 either way.
    let applied: string | undefined;
    try {
      applied = await readRailwayVariable(params.variableName, params.service, dependencies);
    } catch (cause) {
      // Readiness already passed, so this is not an unhealthy instance -- it
      // is a failed *verification read*. Reporting it as a health problem
      // would send the operator to the wrong recovery.
      throw new RefVerificationError(
        `${params.variableName} on '${params.service}' was updated to '${params.nextRef}' and the instance is ` +
          `answering authenticated requests, but reading the variable back to confirm it failed: ` +
          `${cause instanceof Error ? cause.message : String(cause)}. The instance is healthy; the ref was not ` +
          `confirmed. Re-read the live value to check.`
      );
    }
    if (applied !== params.nextRef) {
      throw new RefVerificationError(
        `${params.variableName} on '${params.service}' reads back as '${applied ?? "unset"}', not the requested ` +
          `'${params.nextRef}', even though the instance is answering authenticated requests. The write was ` +
          `accepted but did not take effect, or something else changed it. The instance is healthy; it is the ` +
          `ref that is wrong. Re-read the live value and decide before retrying.`
      );
    }
  } catch (cause) {
    // A ref-verification failure is a different diagnosis from a readiness
    // failure -- one means the instance is fine but on the wrong ref, the
    // other means the instance may be down. Reporting both as "not confirmed
    // healthy" points the operator at the wrong recovery.
    if (cause instanceof RefVerificationError) {
      throw cause;
    }
    throw new Error(
      `${params.variableName} on '${params.service}' WAS updated to '${params.nextRef}', but the instance is ` +
        `not confirmed healthy afterwards: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        `The change is live and unverified -- check the instance before retrying.`,
      { cause }
    );
  }

  return { changed: true, newDeploymentReady: true };
}

/**
 * Updates one already-provisioned client service to a new
 * OPENCLAW_TEMPLATE_REF and redeploys it, then waits for it to answer
 * authenticated requests. No-ops when already at the requested ref.
 * Never touches any other service, control-plane's own main, or railway.toml.
 */
export async function updateClientTemplateRef(
  options: UpdateClientTemplateRefOptions,
  dependencies: InstallerDependencies
): Promise<UpdateClientTemplateRefResult> {
  const { changed, newDeploymentReady } = await updateClientRefVariable(
    {
      service: options.service,
      variableName: "OPENCLAW_TEMPLATE_REF",
      nextRef: options.templateRef,
      expectedCurrentRef: options.expectedCurrentRef,
      forceRedeploy: options.forceRedeploy,
      setupUsername: options.setupUsername,
      pollSeconds: options.pollSeconds ?? 15,
      timeoutMinutes: options.timeoutMinutes ?? 25
    },
    dependencies
  );

  return { serviceName: options.service, templateRef: options.templateRef, changed, newDeploymentReady };
}

export interface UpdateClientOpenClawRefOptions {
  service: string;
  openclawRef: string;
  /** The ref the caller believes is currently set. A mismatch aborts the update. */
  expectedCurrentRef: string;
  /**
   * Redeploy even when the variable already reads as the requested ref. For
   * recovering an instance whose previous update wrote the ref and then
   * failed before the redeploy or readiness completed.
   */
  forceRedeploy?: boolean;
  setupUsername?: string;
  pollSeconds?: number;
  timeoutMinutes?: number;
}

export interface UpdateClientOpenClawRefResult {
  serviceName: string;
  openclawRef: string;
  /** False when the service was already at this ref and nothing was redeployed. */
  changed: boolean;
  /**
   * True only when this call observed a *new* deployment reach SUCCESS, saw
   * `/setup/api/status` answer afterwards, and read the variable back as the
   * requested ref.
   *
   * Deliberately named for what those checks establish and no more. They do
   * NOT establish that the running deployment was built from this ref --
   * nothing reachable from here exposes the ref a running build came from.
   * Callers must not turn this into "this ref is running".
   */
  newDeploymentReady: boolean;
}

/**
 * Updates one already-provisioned client service to a new OPENCLAW_GIT_REF
 * (the pinned openclaw/openclaw application version, not the
 * OPENCLAW_TEMPLATE_REF wrapper pin) and redeploys it, then waits for it to
 * answer authenticated requests. Bumping the pinned application version is
 * the higher-risk of the two, since it changes what the live instance
 * actually runs -- which is why the readiness check matters most here.
 * Never touches any other service, control-plane's own main, or railway.toml.
 */
export async function updateClientOpenClawRef(
  options: UpdateClientOpenClawRefOptions,
  dependencies: InstallerDependencies
): Promise<UpdateClientOpenClawRefResult> {
  const { changed, newDeploymentReady } = await updateClientRefVariable(
    {
      service: options.service,
      variableName: "OPENCLAW_GIT_REF",
      nextRef: options.openclawRef,
      expectedCurrentRef: options.expectedCurrentRef,
      forceRedeploy: options.forceRedeploy,
      setupUsername: options.setupUsername,
      pollSeconds: options.pollSeconds ?? 15,
      timeoutMinutes: options.timeoutMinutes ?? 25
    },
    dependencies
  );

  return { serviceName: options.service, openclawRef: options.openclawRef, changed, newDeploymentReady };
}

export interface RotateGatewayTokenOptions {
  service: string;
  setupUsername?: string;
  pollSeconds?: number;
  timeoutMinutes?: number;
}

export interface RotateGatewayTokenResult {
  serviceName: string;
  newDeploymentReady: boolean;
}

// LIVE-INSTANCE TIER: restart-or-redeploy-triggering
// See docs/live-instance-operations.md for what this tier permits.
/**
 * Rotates OPENCLAW_GATEWAY_TOKEN on an already-provisioned client service to
 * a fresh random value and redeploys it, then waits for it to answer
 * authenticated requests. Unlike updateClientTemplateRef/updateClientOpenClawRef,
 * this is not a compare-and-swap against a caller-declared expected value --
 * a rotation's whole point is to always replace the current value with a new
 * one, so there is nothing meaningful to compare against. Refuses when the
 * service has no OPENCLAW_GATEWAY_TOKEN at all (nothing to rotate; provision
 * first). The new value is never returned, logged, or printed: nothing
 * outside the running process needs it, unlike the initial-provisioning
 * handoff, which exists specifically to hand the operator a credential they
 * will use. Never touches any other service, control-plane's own main, or
 * railway.toml.
 */
export async function rotateGatewayToken(
  options: RotateGatewayTokenOptions,
  dependencies: InstallerDependencies
): Promise<RotateGatewayTokenResult> {
  const pollSeconds = options.pollSeconds ?? 15;
  const timeoutMinutes = options.timeoutMinutes ?? 25;

  const current = await readRailwayVariable("OPENCLAW_GATEWAY_TOKEN", options.service, dependencies);
  if (current === undefined) {
    throw new Error(
      `Refusing to rotate OPENCLAW_GATEWAY_TOKEN on '${options.service}': it has no OPENCLAW_GATEWAY_TOKEN ` +
        `variable set at all. There is nothing to rotate; provision the service first.`
    );
  }

  // Captured before the write so the post-redeploy poll can reject the
  // deployment that was already there -- same guard updateClientRefVariable
  // uses, for the same reason.
  const priorDeploymentId = findTemplateService(await listServices(dependencies.runner), options.service)
    ?.latestDeployment?.id;
  if (priorDeploymentId === undefined) {
    throw new Error(
      `Refusing to rotate OPENCLAW_GATEWAY_TOKEN on '${options.service}': its current deployment id could not ` +
        `be read, so a redeploy could not be distinguished from the deployment already running. Nothing has ` +
        `been changed. Confirm the service exists and has a deployment, then retry.`
    );
  }

  const next = createSecret(32);

  try {
    await writeRailwayVariable(
      { name: "OPENCLAW_GATEWAY_TOKEN", value: next, service: options.service, skipDeploys: true },
      dependencies
    );
  } catch (cause) {
    throw new Error(
      `Writing a new OPENCLAW_GATEWAY_TOKEN to '${options.service}' failed, and it is not certain whether the ` +
        `value was applied before the failure: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        `Re-read (do not print) the live value before retrying.`,
      { cause }
    );
  }

  try {
    await dependencies.runner.run(["redeploy", "--service", options.service, "--yes", "--json"]);
    await pollServiceUntilSuccess(options.service, pollSeconds, timeoutMinutes, dependencies, priorDeploymentId);
    await assertInstanceReady(
      { service: options.service, setupUsername: options.setupUsername, pollSeconds, timeoutMinutes },
      dependencies
    );

    // Post-write verification, the second half the protocol's own
    // idempotent-write rule requires. A healthy instance is not proof the
    // rotation actually took: the write could have been accepted and not
    // applied, or something else could have changed it in the meantime.
    let applied: string | undefined;
    try {
      applied = await readRailwayVariable("OPENCLAW_GATEWAY_TOKEN", options.service, dependencies);
    } catch (cause) {
      // Readiness already passed, so this is not an unhealthy instance -- it
      // is a failed *verification read*. Reporting it as a health problem
      // would send the operator to the wrong recovery (updateClientRefVariable
      // draws the same distinction for the ref-update paths).
      throw new RefVerificationError(
        `OPENCLAW_GATEWAY_TOKEN on '${options.service}' was rotated and the instance is answering authenticated ` +
          `requests, but reading the variable back to confirm it failed: ` +
          `${cause instanceof Error ? cause.message : String(cause)}. The instance is healthy; the rotation was ` +
          `not confirmed. Re-read the live value to check.`
      );
    }
    if (applied !== next) {
      throw new RefVerificationError(
        `OPENCLAW_GATEWAY_TOKEN on '${options.service}' does not read back as the value just written, even ` +
          `though the instance is answering authenticated requests. The write was accepted but did not take ` +
          `effect, or something else changed it since. The instance is healthy; the rotation is unconfirmed.`
      );
    }
  } catch (cause) {
    if (cause instanceof RefVerificationError) {
      throw cause;
    }
    throw new Error(
      `OPENCLAW_GATEWAY_TOKEN on '${options.service}' WAS rotated, but the instance is not confirmed healthy ` +
        `afterwards: ${cause instanceof Error ? cause.message : String(cause)}. The change is live and ` +
        `unverified -- check the instance before retrying.`,
      { cause }
    );
  }

  return { serviceName: options.service, newDeploymentReady: true };
}

async function resolveProvisionOptions(
  options: ProvisionClientOptions,
  dependencies: ProvisionClientDependencies
): Promise<ResolvedProvisionOptions> {
  const templateRef = options.templateRef ?? (await resolveDefaultTemplateRef(dependencies));

  return {
    clientName: options.clientName,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.workspace ? { workspace: options.workspace } : {}),
    targetPort: options.targetPort ?? 8080,
    templateRef,
    setupUsername: options.setupUsername ?? DEFAULT_SETUP_USERNAME,
    setupPassword: options.setupPassword ?? createSecret(24, "oc-"),
    gatewayToken: options.gatewayToken ?? createSecret(32),
    pollSeconds: options.pollSeconds ?? 15,
    timeoutMinutes: options.timeoutMinutes ?? 25,
    forceNew: options.forceNew ?? false,
    envLocalPath: options.envLocalPath ?? ".env.local",
    handoffPath: options.handoffPath ?? "openclaw-railway-client-handoff.local.md",
    writeLocalFiles: options.writeLocalFiles ?? true
  };
}

/**
 * Returns the sole service in `candidates`, or `undefined` if there are
 * none. Throws if there is more than one: this feature's design assumes
 * one client == one project == one service, and `service list` ordering
 * is not guaranteed, so silently indexing into `[0]` when that assumption
 * is violated risks reusing or mutating the wrong service.
 */
function selectSoleService(
  candidates: InstallerService[],
  clientName: string,
  context: string
): InstallerService | undefined {
  if (candidates.length > 1) {
    const names = candidates.map((s) => s.name).join(", ");
    throw new Error(
      `Expected at most one service among ${context} for client '${clientName}', found ${candidates.length}: ${names}. ` +
        `This provisioner assumes one client == one project == one service; resolve the extra service(s) manually before retrying.`
    );
  }
  return candidates[0];
}

async function resolveDefaultTemplateRef(dependencies: ProvisionClientDependencies): Promise<string> {
  const reader = dependencies.readTemplateLock ?? defaultReadTemplateLock;
  const lock = await reader();
  return lock.pinnedCommit;
}

async function defaultReadTemplateLock(): Promise<{ pinnedCommit: string }> {
  return readTemplateLock(DEFAULT_TEMPLATE_LOCK_PATH);
}

async function writeProvisionEnvLocal(
  path: string,
  result: Omit<ProvisionClientResult, "wroteEnvLocal" | "wroteHandoff">,
  dependencies: ProvisionClientDependencies
): Promise<void> {
  let existing = "";
  try {
    existing = await (dependencies.readText ?? readFileUtf8)(path);
  } catch {
    existing = "";
  }

  const merged = mergeEnv(existing, {
    OPENCLAW_CLIENT_SETUP_URL: result.setupUrl,
    OPENCLAW_CLIENT_OPENCLAW_URL: result.openclawUrl,
    OPENCLAW_CLIENT_HEALTH_URL: result.healthUrl,
    OPENCLAW_CLIENT_SERVICE_ID: result.serviceId,
    OPENCLAW_CLIENT_SERVICE_NAME: result.serviceName,
    OPENCLAW_CLIENT_TEMPLATE_REF: result.templateRef,
    OPENCLAW_CLIENT_SETUP_USERNAME: result.setupUsername,
    OPENCLAW_CLIENT_SETUP_PASSWORD: result.setupPassword,
    OPENCLAW_CLIENT_GATEWAY_TOKEN: result.gatewayToken,
    OPENCLAW_CLIENT_DASHBOARD_URL: result.dashboardUrl
  });
  await writeLocalText(path, merged, dependencies);
}

async function readFileUtf8(path: string): Promise<string> {
  return readFile(resolve(path), "utf8");
}

function buildProvisionHandoff(result: Omit<ProvisionClientResult, "wroteEnvLocal" | "wroteHandoff">): string {
  return `# OpenClaw Client Provisioning Handoff

This file is local-only and should not be committed.

## URLs

- Setup: ${result.setupUrl}
- OpenClaw UI: ${result.openclawUrl}
- Healthcheck: ${result.healthUrl}

## Client Handoff Link

Hand the client this single link. It fully authenticates the dashboard's
gateway connection on first open -- no manual token entry, no separate
"Connect" step. (Confirmed live: OpenClaw's Control UI reads a \`#token=\`
URL fragment on load and auto-connects.) Not independently confirmed yet
whether a genuinely new browser/device still hits a one-time pairing
approval on top of this -- see \`openclaw devices approve <requestId>\` in
the wrapper's own pairing-required panel if so.

- ${result.dashboardUrl}

## Railway

- Service: ${result.serviceName}
- Service ID: ${result.serviceId}
${result.projectId ? `- Project ID: ${result.projectId}\n` : ""}- Template ref: ${result.templateRef}
- Domain: ${result.domain}

## Setup Auth

- Username: ${result.setupUsername}
- Password: ${result.setupPassword}

## Post-Deploy Automation

- Patched allowedOrigins: ${describePatchAllowedOriginsStatus(result.allowedOriginsStatus)}
- Approved device pairing request: ${describeDeviceApprovalStatus(result.deviceApprovalStatus, result.approvedDeviceRequestId)}

## Updating the wrapper version later

Run the update-ref path with this service name, the new ref, and the ref it
is replacing — it only touches this one service, never any other client or
control-plane's main.

The expected-current-ref argument is required: the update reads the live
value first and refuses if it is not what you said, so a client cannot be
redeployed by someone working from a stale assumption. Read the service's
current OPENCLAW_TEMPLATE_REF before bumping it rather than assuming the ref
recorded here -- on a rerun that reused an existing service, the live value
can differ from this document's, and a stale expectation is refused by
design.

The application ref (OPENCLAW_GIT_REF) is a separate pin and is not set as a
service variable at provisioning time — it exists only as a build-time
default until its first bump. For that first bump only, pass '<unset>' as
the expected current ref. See deploy/openclaw-railway/README.md for both
commands and for the recovery path if an update fails after writing.

## Next Steps

1. Open the setup URL.
2. Use any username or the username above with the setup password.
3. Complete model provider and channel configuration in the setup wizard.
4. Store client-owned secrets in their password manager and rotate
   temporary handoff values after onboarding.
`;
}
