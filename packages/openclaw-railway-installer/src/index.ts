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
    : await waitForSuccessfulService(resolved, dependencies);

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
  // item 3). `/setup/api/status` only succeeds once those credentials work.
  const setupStatusUrl = `${baseUrl}/setup/api/status`;
  const setupStatus = await checkSetupStatus(setupStatusUrl, setupAuth, dependencies);
  if (setupStatus !== 200) {
    throw new Error(`Setup readiness check '${setupStatusUrl}' returned ${setupStatus}.`);
  }

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
    setupUsername: options.setupUsername ?? "openclaw-admin",
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

async function waitForSuccessfulService(
  options: RequiredOptions,
  dependencies: InstallerDependencies
): Promise<InstallerService | undefined> {
  const deadline = Date.now() + options.timeoutMinutes * 60_000;
  do {
    await (dependencies.sleep ?? defaultSleep)(options.pollSeconds * 1000);
    const service = findTemplateService(await listServices(dependencies.runner), options.service);
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
          `Check logs with: railway logs --service ${options.service} --lines 200`
      );
    }
  } while (Date.now() < deadline);

  throw new Error(`Timed out waiting for '${options.service}' to deploy.`);
}

async function listServices(runner: RailwayRunner): Promise<InstallerService[]> {
  const result = await runner.run(["service", "list", "--json"]);
  return JSON.parse(result.stdout) as InstallerService[];
}

async function ensureDomainPort(
  serviceName: string,
  targetPort: number,
  runner: RailwayRunner
): Promise<RailwayDomain> {
  const result = await runner.run(["domain", "list", "--service", serviceName, "--json"]);
  const parsed = JSON.parse(result.stdout) as { domains: RailwayDomain[] };
  const domain = parsed.domains.find((candidate) => candidate.type === "service") ?? parsed.domains[0];
  if (!domain) {
    throw new Error(`No Railway domain found for service '${serviceName}'.`);
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

async function writeLocalText(
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
