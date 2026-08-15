import { mintOpenRouterKey } from "./openrouter-provisioning.js";
import { parseClientProfile, type ClientProfile, type ModelProviderAttachment } from "./profile-schema.js";
import {
  listRailwayVariables,
  writeRailwayVariable,
  type RailwayVariableReaderDependencies
} from "./railway-variables.js";
import type { SetupApiClient } from "./setup-api-client.js";

// This module implements both the non-mutating `--dry-run` path (Session 1)
// and the mutating apply path (Session 2): mint-if-needed, write variable,
// re-healthcheck when required, call /setup/api/run, guarded by an
// idempotency check against /setup/api/status.

export interface DryRunOptions {
  service: string;
}

export interface DryRunSecretStatus {
  name: string;
  present: boolean;
}

export interface DryRunPayloadPreview {
  providers: Array<{
    authGroup: string;
    authChoice: string;
    flow: string;
    authSecret: "<redacted>";
  }>;
  channels: Array<{
    channelType: string;
    tokens: Array<"<redacted>">;
  }>;
}

export interface DryRunResult {
  requiredSecrets: DryRunSecretStatus[];
  payloadPreview: DryRunPayloadPreview;
}

/**
 * Resolves a candidate profile against the target Railway service without
 * mutating anything: no key is minted, no variable is written, and
 * /setup/api/run is never called. Real secret values are never read into
 * the result — only whether each required secret name is present.
 */
export async function dryRunApplyProfile(
  candidateProfile: unknown,
  options: DryRunOptions,
  dependencies: RailwayVariableReaderDependencies
): Promise<DryRunResult> {
  const profile = parseClientProfile(candidateProfile);
  const variables = await listRailwayVariables(options.service, dependencies);
  const requiredSecretNames = collectRequiredSecretNames(profile);

  const requiredSecrets = requiredSecretNames.map((name) => ({
    name,
    present: Object.prototype.hasOwnProperty.call(variables, name)
  }));

  return {
    requiredSecrets,
    payloadPreview: buildRedactedPayloadPreview(profile)
  };
}

/** Prints a dry-run result. Every secret-bearing field is already redacted. */
export function printDryRunResult(result: DryRunResult): void {
  console.log(JSON.stringify(result, null, 2));
}

function collectRequiredSecretNames(profile: ClientProfile): string[] {
  const names = new Set<string>();
  for (const provider of profile.attachments.modelProviders) {
    for (const name of provider.requiredSecretNames) {
      names.add(name);
    }
  }
  for (const channel of profile.attachments.channels) {
    for (const name of channel.requiredSecretNames) {
      names.add(name);
    }
  }
  return [...names];
}

function buildRedactedPayloadPreview(profile: ClientProfile): DryRunPayloadPreview {
  return {
    providers: profile.attachments.modelProviders.map((provider) => ({
      authGroup: provider.nonSecretConfig.authGroup,
      authChoice: provider.nonSecretConfig.authChoice,
      flow: provider.nonSecretConfig.flow,
      authSecret: "<redacted>" as const
    })),
    // One redacted placeholder per declared secret, not one per channel —
    // a channel like Slack declares two (bot token + app token), and a
    // preview that showed only one would misrepresent what apply mode
    // actually requires. Mirrors the real apply path's `secrets` array
    // below (resolvedChannels), which already handles this correctly.
    channels: profile.attachments.channels.map((channel) => ({
      channelType: channel.type,
      tokens: channel.requiredSecretNames.map(() => "<redacted>" as const)
    }))
  };
}

export interface ApplyOptions {
  service: string;
  instanceBaseUrl: string;
  /** Healthcheck poll interval after a redeploy-triggering write. Default 2s. */
  healthcheckPollSeconds?: number;
  /** Healthcheck poll deadline after a redeploy-triggering write. Default 60s. */
  healthcheckTimeoutSeconds?: number;
}

export interface ApplyProfileDependencies extends RailwayVariableReaderDependencies {
  setupApiClient: SetupApiClient;
  openRouterManagementKey: string;
  /** Used for OpenRouter minting and the post-write healthcheck. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a real `setTimeout`-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export type ApplyOutcome = "already-configured" | "applied";

export interface ApplyResult {
  outcome: ApplyOutcome;
}

/**
 * Applies a candidate profile to a live OpenClaw instance. Idempotent:
 * skips /setup/api/run entirely if the instance already reports configured,
 * and skips minting for any attachment whose declared secret name is
 * already present in Railway variables. Never logs or persists a secret
 * value beyond the single call it serves.
 */
export async function applyProfile(
  candidateProfile: unknown,
  options: ApplyOptions,
  dependencies: ApplyProfileDependencies
): Promise<ApplyResult> {
  const profile = parseClientProfile(candidateProfile);

  const status = await dependencies.setupApiClient.getStatus();
  if (isConfigured(status)) {
    return { outcome: "already-configured" };
  }

  const existingVars = await listRailwayVariables(options.service, dependencies);
  let redeployTriggered = false;

  // /setup/api/run takes a single authGroup/authChoice/authSecret set
  // (issue #7's field names are singular, not arrays) — one model-provider
  // attachment per call matches the wizard's real contract. A profile with
  // more than one is a shape this applier doesn't support; fail loudly
  // rather than silently applying only the first and dropping the rest.
  if (profile.attachments.modelProviders.length > 1) {
    throw new Error(
      `Profile has ${profile.attachments.modelProviders.length} modelProviders attachments; ` +
        "this applier supports at most one per /setup/api/run call."
    );
  }
  const provider = profile.attachments.modelProviders[0];
  let resolvedProvider:
    | {
        authGroup: string;
        authChoice: string;
        flow: string;
        authSecret: string;
        customProviderApiKeyEnv?: string;
      }
    | undefined;

  if (provider !== undefined) {
    const resolution = await resolveProviderSecret(provider, existingVars, options.service, dependencies);
    redeployTriggered = redeployTriggered || resolution.triggeredRedeploy;
    resolvedProvider = {
      authGroup: provider.nonSecretConfig.authGroup,
      authChoice: provider.nonSecretConfig.authChoice,
      flow: provider.nonSecretConfig.flow,
      authSecret: resolution.value,
      ...(provider.nonSecretConfig.customProviderApiKeyEnv !== undefined
        ? { customProviderApiKeyEnv: provider.nonSecretConfig.customProviderApiKeyEnv }
        : {})
    };
  }

  const resolvedChannels = profile.attachments.channels.map((channel) => ({
    channelType: channel.type,
    secrets: channel.requiredSecretNames.map((name) => {
      const value = existingVars[name];
      if (value === undefined) {
        throw new Error(
          `Required secret '${name}' not found in Railway variables for service '${options.service}'.`
        );
      }
      return value;
    })
  }));

  if (redeployTriggered) {
    await waitForHealthy(options.instanceBaseUrl, dependencies.fetchImpl ?? fetch, {
      ...(dependencies.sleep !== undefined ? { sleep: dependencies.sleep } : {}),
      ...(options.healthcheckPollSeconds !== undefined
        ? { pollSeconds: options.healthcheckPollSeconds }
        : {}),
      ...(options.healthcheckTimeoutSeconds !== undefined
        ? { timeoutSeconds: options.healthcheckTimeoutSeconds }
        : {})
    });
  }

  // The exact /setup/api/run payload shape for multiple channels is not
  // independently confirmed against a live instance. Issue #7's prose
  // describes named per-channel-type fields (telegramToken, slackBotToken,
  // slackAppToken, ...) on what may be a flat, single-provider payload,
  // which may not match the array shape built here. Confirm against a live
  // instance before relying on this in production — see plan.md's open
  // "Before D2/D13" dependency (also flags the authGroup/authChoice enum).
  const payload = {
    ...(resolvedProvider ?? {}),
    channels: resolvedChannels
  };

  await dependencies.setupApiClient.run(payload);

  const postRunStatus = await dependencies.setupApiClient.getStatus();
  if (!isConfigured(postRunStatus)) {
    throw new Error(
      "POST /setup/api/run completed but GET /setup/api/status still does not report configured."
    );
  }

  return { outcome: "applied" };
}

function isConfigured(status: unknown): boolean {
  // `configured: boolean` on the /setup/api/status response is not
  // independently confirmed against a live instance — same caveat as the
  // rest of setup-api-client.ts's unconfirmed response shapes.
  return (
    typeof status === "object" &&
    status !== null &&
    "configured" in status &&
    (status as { configured: unknown }).configured === true
  );
}

async function resolveProviderSecret(
  provider: ModelProviderAttachment,
  existingVars: Record<string, string>,
  service: string,
  dependencies: ApplyProfileDependencies
): Promise<{ value: string; triggeredRedeploy: boolean }> {
  const secretName = provider.requiredSecretNames[0];
  if (secretName === undefined) {
    throw new Error("Model provider attachment has no requiredSecretNames.");
  }

  const existing = existingVars[secretName];
  if (existing !== undefined) {
    return { value: existing, triggeredRedeploy: false };
  }

  const keyProvisioning = provider.nonSecretConfig.keyProvisioning;
  if (keyProvisioning === undefined) {
    throw new Error(
      `Required secret '${secretName}' not found in Railway variables for service '${service}'.`
    );
  }

  const minted = await mintOpenRouterKey(
    {
      name: secretName,
      spendLimitUsd: keyProvisioning.spendLimitUsd,
      limitReset: keyProvisioning.limitReset
    },
    {
      managementKey: dependencies.openRouterManagementKey,
      ...(dependencies.fetchImpl !== undefined ? { fetchImpl: dependencies.fetchImpl } : {})
    }
  );

  const requiresRedeploy = provider.nonSecretConfig.customProviderApiKeyEnv !== undefined;
  await writeRailwayVariable(
    { name: secretName, value: minted, service, skipDeploys: !requiresRedeploy },
    dependencies
  );

  return { value: minted, triggeredRedeploy: requiresRedeploy };
}

interface WaitForHealthyOptions {
  sleep?: (ms: number) => Promise<void>;
  pollSeconds?: number;
  timeoutSeconds?: number;
}

/**
 * Polls `/setup/healthz` until it responds ok or the deadline passes. A
 * single check is both flaky (the instance can be briefly unreachable
 * mid-redeploy) and insufficient (an old instance can still answer 200
 * while the new one hasn't taken over yet) — polling with a deadline is
 * the minimum needed to actually wait out a redeploy rather than race it.
 */
async function waitForHealthy(
  instanceBaseUrl: string,
  fetchImpl: typeof fetch,
  options: WaitForHealthyOptions = {}
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = (options.pollSeconds ?? 2) * 1000;
  const timeoutSeconds = options.timeoutSeconds ?? 60;
  const deadline = Date.now() + timeoutSeconds * 1000;
  const url = `${instanceBaseUrl.replace(/\/$/, "")}/setup/healthz`;

  let lastStatus: number | undefined;
  for (;;) {
    const response = await fetchImpl(url);
    if (response.ok) {
      return;
    }
    lastStatus = response.status;
    if (Date.now() >= deadline) {
      break;
    }
    await sleep(pollMs);
  }

  throw new Error(
    `Instance healthcheck at '${url}' did not become healthy within ${timeoutSeconds}s ` +
      `(last status: ${lastStatus}) before calling /setup/api/run.`
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
