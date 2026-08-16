import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createSecret,
  ensureDomainPort,
  healthCheck,
  listServices,
  mergeEnv,
  pollServiceUntilSuccess,
  writeLocalText,
  type InstallerDependencies,
  type InstallerService
} from "./index.js";
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
  reusedExistingService: boolean;
  wroteEnvLocal: boolean;
  wroteHandoff: boolean;
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

  const existing = (await listServices(dependencies.runner))[0];
  let reusedExistingService = false;
  let service: InstallerService;

  if (existing && !resolved.forceNew) {
    reusedExistingService = true;
    service = existing;
  } else {
    await dependencies.runner.run(["up", "--detach", "--json"]);

    const created = (await listServices(dependencies.runner))[0];
    if (!created) {
      throw new Error(`No Railway service was found after 'railway up' for client '${resolved.clientName}'.`);
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
  // a client — read back what's actually on the service instead.
  const setupPassword = reusedExistingService
    ? ((await readRailwayVariable("SETUP_PASSWORD", service.name, dependencies)) ?? resolved.setupPassword)
    : resolved.setupPassword;

  const domain = await ensureDomainPort(service.name, resolved.targetPort, dependencies.runner);
  const baseUrl = `https://${domain.domain}`;
  const healthUrl = `${baseUrl}/setup/healthz`;
  const status = await healthCheck(healthUrl, dependencies);
  if (status !== 200) {
    throw new Error(`Healthcheck '${healthUrl}' returned ${status}.`);
  }

  const resultBase = {
    serviceId: service.id,
    serviceName: service.name,
    ...(resolved.projectId ? { projectId: resolved.projectId } : {}),
    templateRef: resolved.templateRef,
    domain: domain.domain,
    setupUrl: `${baseUrl}/setup`,
    openclawUrl: `${baseUrl}/openclaw`,
    healthUrl,
    setupUsername: resolved.setupUsername,
    setupPassword,
    reusedExistingService
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

export interface UpdateClientTemplateRefOptions {
  service: string;
  templateRef: string;
  pollSeconds?: number;
  timeoutMinutes?: number;
}

export interface UpdateClientTemplateRefResult {
  serviceName: string;
  templateRef: string;
}

/**
 * Updates one already-provisioned client service to a new
 * OPENCLAW_TEMPLATE_REF and redeploys it. Never touches any other
 * service, control-plane's own main, or railway.toml.
 */
export async function updateClientTemplateRef(
  options: UpdateClientTemplateRefOptions,
  dependencies: InstallerDependencies
): Promise<UpdateClientTemplateRefResult> {
  const pollSeconds = options.pollSeconds ?? 15;
  const timeoutMinutes = options.timeoutMinutes ?? 25;

  await writeRailwayVariable(
    { name: "OPENCLAW_TEMPLATE_REF", value: options.templateRef, service: options.service, skipDeploys: true },
    dependencies
  );
  await dependencies.runner.run(["redeploy", "--service", options.service, "--yes", "--json"]);
  await pollServiceUntilSuccess(options.service, pollSeconds, timeoutMinutes, dependencies);

  return { serviceName: options.service, templateRef: options.templateRef };
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
    setupUsername: options.setupUsername ?? "openclaw-admin",
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
    OPENCLAW_CLIENT_SETUP_PASSWORD: result.setupPassword
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

## Railway

- Service: ${result.serviceName}
- Service ID: ${result.serviceId}
${result.projectId ? `- Project ID: ${result.projectId}\n` : ""}- Template ref: ${result.templateRef}
- Domain: ${result.domain}

## Setup Auth

- Username: ${result.setupUsername}
- Password: ${result.setupPassword}

## Updating the wrapper version later

Run the update-ref path with this service name and a new ref — it only
touches this one service, never any other client or control-plane's main.

## Next Steps

1. Open the setup URL.
2. Use any username or the username above with the setup password.
3. Complete model provider and channel configuration in the setup wizard.
4. Store client-owned secrets in their password manager and rotate
   temporary handoff values after onboarding.
`;
}
