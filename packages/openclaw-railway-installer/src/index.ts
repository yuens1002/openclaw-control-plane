// LIVE-INSTANCE TIER: deploy
// See docs/live-instance-operations.md for what this tier permits.
//
// Highest tier comes from `installOpenClawOnRailway`, which runs a raw
// `deploy` command. This module is also the repo's worst credential-axis
// offender: that same command passes SETUP_PASSWORD and
// OPENCLAW_GATEWAY_TOKEN as `-v NAME=<value>` argument-vector entries, so
// both values land in a process listing while the deploy runs -- the exact
// pattern the sibling Railway-variables module exists to avoid by piping
// values through stdin instead. Not fixed here (this change is
// comment-only); recorded so the marker matches what the code does rather
// than what it should do. The shared helpers below carry their own
// markers; the pure local helpers (secret generation, env merging, handoff
// text, local file writes) touch no live instance and carry none.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { approveOwnDevicePairing, type ApproveOwnDeviceDependencies } from "./approve-own-device.js";
import { patchAllowedOrigins, type PatchAllowedOriginsDependencies } from "./patch-allowed-origins.js";
import { basicAuthHeader, type SetupAuth } from "./setup-auth.js";

export type { SetupAuth };

export type DeploymentStatus =
  | "BUILDING"
  | "CRASHED"
  | "DEPLOYING"
  | "FAILED"
  | "INITIALIZING"
  | "NEEDS_APPROVAL"
  | "PENDING"
  | "QUEUED"
  | "REMOVED"
  | "REMOVING"
  | "SKIPPED"
  | "SLEEPING"
  | "SUCCESS"
  | "WAITING";

const terminalFailureStatuses = new Set<DeploymentStatus>([
  "CRASHED",
  "FAILED",
  "NEEDS_APPROVAL",
  "REMOVED",
  "REMOVING",
  "SKIPPED",
  "SLEEPING"
]);

export interface CommandResult {
  stdout: string;
}

export interface RailwayRunner {
  run(args: string[], stdin?: string): Promise<CommandResult>;
}

export interface InstallerService {
  id: string;
  name: string;
  url?: string;
  latestDeployment?: {
    id?: string;
    status?: DeploymentStatus;
  };
  source?: {
    repo?: string | null;
    image?: string | null;
  };
}

export interface RailwayDomain {
  domain: string;
  type: string;
  targetPort?: number;
}

export interface InstallerOptions {
  template?: string;
  service?: string;
  targetPort?: number;
  pollSeconds?: number;
  timeoutMinutes?: number;
  forceNew?: boolean;
  setupUsername?: string;
  setupPassword?: string;
  gatewayToken?: string;
  envLocalPath?: string;
  handoffPath?: string;
  writeLocalFiles?: boolean;
}

export interface InstallerDependencies {
  runner: RailwayRunner;
  sleep?: (ms: number) => Promise<void>;
  checkSetupStatus?: (url: string, auth: SetupAuth) => Promise<number>;
  getConfigRaw?: PatchAllowedOriginsDependencies["getConfigRaw"];
  postConfigRaw?: PatchAllowedOriginsDependencies["postConfigRaw"];
  getPendingDevices?: ApproveOwnDeviceDependencies["getPendingDevices"];
  approveDevice?: ApproveOwnDeviceDependencies["approveDevice"];
  readText?: (path: string) => Promise<string>;
  writeText?: (path: string, contents: string) => Promise<void>;
}

export interface InstallResult {
  serviceId: string;
  serviceName: string;
  deploymentId?: string;
  domain: string;
  setupUrl: string;
  openclawUrl: string;
  healthUrl: string;
  setupUsername: string;
  setupPassword: string;
  reusedExistingService: boolean;
  wroteEnvLocal: boolean;
  wroteHandoff: boolean;
  patchedAllowedOrigins: boolean;
  approvedDeviceRequestId?: string;
}

interface RequiredOptions {
  template: string;
  service: string;
  targetPort: number;
  pollSeconds: number;
  timeoutMinutes: number;
  forceNew: boolean;
  setupUsername: string;
  setupPassword: string;
  gatewayToken: string;
  envLocalPath: string;
  handoffPath: string;
  writeLocalFiles: boolean;
}

export function createSecret(bytes: number, prefix = ""): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

export function mergeEnv(existing: string, entries: Record<string, string>): string {
  const keys = new Set(Object.keys(entries));
  const kept = existing
    .split(/\r?\n/)
    .filter((line) => {
      const key = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1];
      return !key || !keys.has(key);
    })
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1);

  const next = Object.entries(entries).map(([key, value]) => `${key}=${value}`);
  return [...kept, ...next].join("\n").trimEnd() + "\n";
}

export function buildHandoff(result: Omit<InstallResult, "wroteEnvLocal" | "wroteHandoff">): string {
  return `# OpenClaw Railway Handoff

This file is local-only and should not be committed.

## URLs

- Setup: ${result.setupUrl}
- OpenClaw UI: ${result.openclawUrl}
- Healthcheck: ${result.healthUrl}

## Railway

- Service: ${result.serviceName}
- Service ID: ${result.serviceId}
- Deployment ID: ${result.deploymentId ?? "unknown"}
- Domain: ${result.domain}

## Setup Auth

- Username: ${result.setupUsername}
- Password: ${result.setupPassword}

## Post-Deploy Automation

- Patched allowedOrigins: ${result.patchedAllowedOrigins ? "yes" : "no (already present)"}
- Approved device pairing request: ${result.approvedDeviceRequestId ?? "none pending"}

## Next Steps

1. Open the setup URL.
2. Use any username or the username above with the setup password.
3. Complete model provider and channel configuration in the setup wizard.
4. Attach client-specific tools, connectors, and workflows only after the shell install is healthy.
5. Store client-owned secrets in their password manager and rotate temporary handoff values after onboarding.
`;
}

// LIVE-INSTANCE TIER: deploy
// Skips the deploy entirely and reuses the service when a healthy one
// already exists and `forceNew` was not passed, so a rerun is not
// automatically a redeploy. When it does deploy, it passes both generated
// secrets on the argument line (see the file header).
export async function installOpenClawOnRailway(
  options: InstallerOptions,
  dependencies: InstallerDependencies
): Promise<InstallResult> {
  const resolved = resolveOptions(options);
  const servicesBefore = await listServices(dependencies.runner);
  const existing = findTemplateService(servicesBefore, resolved.service);
  let reusedExistingService = false;

  if (existing && !resolved.forceNew) {
    const status = existing.latestDeployment?.status;
    if (status !== "SUCCESS") {
      throw new Error(
        `Service '${resolved.service}' already exists with status '${status ?? "unknown"}'. ` +
          `Inspect logs with: railway logs --service ${resolved.service} --lines 200`
      );
    }
    reusedExistingService = true;
  } else {
    await dependencies.runner.run([
      "deploy",
      "-t",
      resolved.template,
      "-v",
      `SETUP_PASSWORD=${resolved.setupPassword}`,
      "-v",
      `OPENCLAW_GATEWAY_TOKEN=${resolved.gatewayToken}`
    ]);
  }

  const service = reusedExistingService
    ? existing
    : await pollServiceUntilSuccess(resolved.service, resolved.pollSeconds, resolved.timeoutMinutes, dependencies);

  if (!service) {
    throw new Error(`Service '${resolved.service}' was not found after deployment.`);
  }

  const domain = await ensureDomainPort(service.name, resolved.targetPort, dependencies.runner);
  const baseUrl = `https://${domain.domain}`;
  const healthUrl = `${baseUrl}/setup/healthz`;
  const setupAuth: SetupAuth = { username: resolved.setupUsername, password: resolved.setupPassword };

  // Auth-gated readiness signal, not `/setup/healthz`: an unauthenticated
  // healthcheck can return 200 from a container mid-transition, before the
  // *new*, just-rotated setup credentials are actually live (issue #18
  // item 3). `/setup/api/status` only succeeds once those credentials work
  // -- poll it rather than checking once, since that propagation can take
  // a few seconds after the deployment itself reaches SUCCESS.
  const setupStatusUrl = `${baseUrl}/setup/api/status`;
  await waitForSetupReady(setupStatusUrl, setupAuth, resolved.pollSeconds, resolved.timeoutMinutes, dependencies);

  const { patched: patchedAllowedOrigins } = await patchAllowedOrigins(baseUrl, setupAuth, domain.domain, {
    getConfigRaw: dependencies.getConfigRaw,
    postConfigRaw: dependencies.postConfigRaw
  });
  const approvedDeviceRequestId = await approveOwnDevicePairing(baseUrl, setupAuth, {
    getPendingDevices: dependencies.getPendingDevices,
    approveDevice: dependencies.approveDevice
  });

  const resultBase = {
    serviceId: service.id,
    serviceName: service.name,
    domain: domain.domain,
    setupUrl: `${baseUrl}/setup`,
    openclawUrl: `${baseUrl}/openclaw`,
    healthUrl,
    setupUsername: resolved.setupUsername,
    setupPassword: resolved.setupPassword,
    reusedExistingService,
    patchedAllowedOrigins,
    ...(approvedDeviceRequestId ? { approvedDeviceRequestId } : {}),
    ...(service.latestDeployment?.id ? { deploymentId: service.latestDeployment.id } : {})
  } satisfies Omit<InstallResult, "wroteEnvLocal" | "wroteHandoff">;

  let wroteEnvLocal = false;
  let wroteHandoff = false;
  if (resolved.writeLocalFiles) {
    await writeEnvLocal(resolved.envLocalPath, resultBase, dependencies);
    wroteEnvLocal = true;
    await writeLocalText(resolved.handoffPath, buildHandoff(resultBase), dependencies);
    wroteHandoff = true;
  }

  return {
    ...resultBase,
    wroteEnvLocal,
    wroteHandoff
  };
}

function resolveOptions(options: InstallerOptions): RequiredOptions {
  return {
    template: options.template ?? "clawdbot-railway-template",
    service: options.service ?? "clawdbot-railway-template",
    targetPort: options.targetPort ?? 8080,
    pollSeconds: options.pollSeconds ?? 15,
    timeoutMinutes: options.timeoutMinutes ?? 25,
    forceNew: options.forceNew ?? false,
    setupUsername: options.setupUsername ?? DEFAULT_SETUP_USERNAME,
    setupPassword: options.setupPassword ?? createSecret(24, "oc-"),
    gatewayToken: options.gatewayToken ?? createSecret(32),
    envLocalPath: options.envLocalPath ?? ".env.local",
    handoffPath: options.handoffPath ?? "openclaw-railway-handoff.local.md",
    writeLocalFiles: options.writeLocalFiles ?? true
  };
}

function findTemplateService(services: InstallerService[], serviceName: string): InstallerService | undefined {
  return services.find((service) => service.name === serviceName);
}

// LIVE-INSTANCE TIER: read
/**
 * Polls `service list` until the named service's latest deployment reaches
 * `SUCCESS`, or throws on a terminal failure status / timeout. Generic over
 * which command put the service into a pending state (a fresh `deploy`, a
 * `redeploy`, etc.) — shared by the marketplace-template install path and
 * the Dockerfile-based client provisioner.
 */
export async function pollServiceUntilSuccess(
  serviceName: string,
  pollSeconds: number,
  timeoutMinutes: number,
  dependencies: InstallerDependencies
): Promise<InstallerService> {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  do {
    await (dependencies.sleep ?? defaultSleep)(pollSeconds * 1000);
    const service = findTemplateService(await listServices(dependencies.runner), serviceName);
    if (!service) {
      continue;
    }

    const status = service.latestDeployment?.status;
    if (status === "SUCCESS") {
      return service;
    }
    if (status && terminalFailureStatuses.has(status)) {
      throw new Error(
        `Deployment ended in terminal state '${status}'. ` +
          `Check logs with: railway logs --service ${serviceName} --lines 200`
      );
    }
  } while (Date.now() < deadline);

  throw new Error(`Timed out waiting for '${serviceName}' to deploy.`);
}

// LIVE-INSTANCE TIER: read
export async function listServices(runner: RailwayRunner): Promise<InstallerService[]> {
  const result = await runner.run(["service", "list", "--json"]);
  return JSON.parse(result.stdout) as InstallerService[];
}

/** Default Basic-auth username for the wrapper's /setup routes. */
export const DEFAULT_SETUP_USERNAME = "openclaw-admin";

export async function listDomains(serviceName: string, runner: RailwayRunner): Promise<{ domains: RailwayDomain[] }> {
  const result = await runner.run(["domain", "list", "--service", serviceName, "--json"]);
  return JSON.parse(result.stdout) as { domains: RailwayDomain[] };
}

// LIVE-INSTANCE TIER: idempotent-write
// Both writes are conditional: a domain is generated only when `domain
// list` comes back with none, and `domain update` runs only when the
// existing domain's targetPort differs from the requested one. Rerunning
// against an already-correct domain makes no write. Changing a live
// service's public domain routing is still a write, hence not read tier.
export async function ensureDomainPort(
  serviceName: string,
  targetPort: number,
  runner: RailwayRunner
): Promise<RailwayDomain> {
  let parsed = await listDomains(serviceName, runner);
  let domain = parsed.domains.find((candidate) => candidate.type === "service") ?? parsed.domains[0];

  if (!domain) {
    // A raw Dockerfile deploy (`railway up`, the provisionClientInstance
    // path) never gets an automatic domain the way a marketplace-template
    // install does -- confirmed live (first-ever smoke of
    // provisionClientInstance, 2026-08-16): `domain list` came back empty
    // for a freshly-deployed, already-`SUCCESS` service. `railway domain
    // --service <name> --port <port> --json` generates one, but its
    // response shape (`{domain: "<full-url>"}`, a string) is confirmed live
    // to be different from `domain list`/`domain update`'s `{domain, type,
    // targetPort}` object shape -- re-list rather than parse it directly,
    // so this function returns one consistent shape either way.
    await runner.run(["domain", "--service", serviceName, "--port", String(targetPort), "--json"]);
    parsed = await listDomains(serviceName, runner);
    domain = parsed.domains.find((candidate) => candidate.type === "service") ?? parsed.domains[0];
    if (!domain) {
      throw new Error(`Generated a Railway domain for '${serviceName}' but it did not appear in 'domain list'.`);
    }
  }

  if (domain.targetPort !== targetPort) {
    const update = await runner.run([
      "domain",
      "update",
      domain.domain,
      "--service",
      serviceName,
      "--port",
      String(targetPort),
      "--json"
    ]);
    const updated = JSON.parse(update.stdout) as { domain: RailwayDomain };
    return updated.domain;
  }

  return domain;
}

async function checkSetupStatus(
  url: string,
  auth: SetupAuth,
  dependencies: InstallerDependencies
): Promise<number> {
  if (dependencies.checkSetupStatus) {
    return dependencies.checkSetupStatus(url, auth);
  }
  const response = await fetch(url, { headers: { authorization: basicAuthHeader(auth) } });
  return response.status;
}

// LIVE-INSTANCE TIER: read
// Credential-bearing on the other axis: sends Basic auth on every poll.
/**
 * Polls `checkSetupStatus` until it returns 200 or the timeout elapses.
 * Newly-rotated setup credentials can take a few seconds to propagate after
 * the deployment itself reaches SUCCESS, so a single check is not enough --
 * mirrors `waitForSuccessfulService`'s poll/timeout shape. Exported for
 * reuse by `provision-client.ts`, which had its own separate unauthenticated
 * `/setup/healthz` single-shot check (from #16, merged as PR #21) before
 * this feature's fix (issue #18 item 3) was ported over to it too.
 */
export async function waitForSetupReady(
  url: string,
  auth: SetupAuth,
  pollSeconds: number,
  timeoutMinutes: number,
  dependencies: InstallerDependencies
): Promise<void> {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let lastStatus: number | undefined;
  do {
    lastStatus = await checkSetupStatus(url, auth, dependencies);
    if (lastStatus === 200) {
      return;
    }
    await (dependencies.sleep ?? defaultSleep)(pollSeconds * 1000);
  } while (Date.now() < deadline);

  throw new Error(
    `Setup readiness check '${url}' did not return 200 within ${timeoutMinutes} minute(s) ` +
      `(last status: ${lastStatus ?? "none"}).`
  );
}

async function writeEnvLocal(
  path: string,
  result: Omit<InstallResult, "wroteEnvLocal" | "wroteHandoff">,
  dependencies: InstallerDependencies
): Promise<void> {
  let existing = "";
  try {
    existing = await (dependencies.readText ?? readFileUtf8)(path);
  } catch {
    existing = "";
  }

  const merged = mergeEnv(existing, {
    OPENCLAW_RAILWAY_SETUP_URL: result.setupUrl,
    OPENCLAW_RAILWAY_OPENCLAW_URL: result.openclawUrl,
    OPENCLAW_RAILWAY_HEALTH_URL: result.healthUrl,
    OPENCLAW_RAILWAY_SERVICE_ID: result.serviceId,
    OPENCLAW_RAILWAY_SERVICE_NAME: result.serviceName,
    OPENCLAW_RAILWAY_SETUP_USERNAME: result.setupUsername,
    OPENCLAW_RAILWAY_SETUP_PASSWORD: result.setupPassword
  });
  await writeLocalText(path, merged, dependencies);
}

export async function writeLocalText(
  path: string,
  contents: string,
  dependencies: InstallerDependencies
): Promise<void> {
  const fullPath = resolve(path);
  await mkdir(dirname(fullPath), { recursive: true });
  if (dependencies.writeText) {
    await dependencies.writeText(path, contents);
    return;
  }
  await writeFile(fullPath, contents, "utf8");
}

async function readFileUtf8(path: string): Promise<string> {
  return readFile(resolve(path), "utf8");
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
