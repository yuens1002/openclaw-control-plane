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

export type ChannelPayloadField = "telegramToken" | "discordToken" | "slackBotToken" | "slackAppToken";

export interface DryRunPayloadPreview {
  providers: Array<{
    authChoice: string;
    flow: string;
    authSecret: "<redacted>";
  }>;
  // Mirrors exactly the channel-field shape the real /setup/api/run payload
  // carries (see mapChannelsToPayloadFields) -- not one entry per channel
  // attachment, since the real payload has no per-attachment structure at
  // all, just a fixed set of optional top-level fields.
  channels: Partial<Record<ChannelPayloadField, "<redacted>">>;
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
  const channels: DryRunPayloadPreview["channels"] = {};
  for (const mapping of mapChannelsToPayloadFields(profile.attachments.channels)) {
    channels[mapping.field] = "<redacted>";
  }

  return {
    providers: profile.attachments.modelProviders.map((provider) => ({
      authChoice: provider.nonSecretConfig.authChoice,
      flow: provider.nonSecretConfig.flow,
      authSecret: "<redacted>" as const
    })),
    channels
  };
}

// A Map, not a plain object: channel.type is an untrusted string from the
// parsed profile, and a plain-object lookup (CHANNEL_SECRET_COUNTS[type])
// would return an inherited Object.prototype method (e.g. `type ===
// "toString"`) instead of undefined for an unsupported type, silently
// bypassing the check below. Map.get() has no prototype to collide with.
const CHANNEL_SECRET_COUNTS = new Map<string, number>([
  ["telegram", 1],
  ["discord", 1],
  ["slack", 2]
]);

interface ChannelFieldMapping {
  field: ChannelPayloadField;
  secretName: string;
}

/**
 * Maps each channel attachment to the flat /setup/api/run field(s) it
 * fills, per the confirmed live contract (see
 * docs/plans/setup-run-payload-contract/plan.md's Live Confirmation --
 * read directly from the real wizard's own request-building source,
 * app.js, not guessed). Fails loud on any shape the flat payload cannot
 * represent: an unsupported channel type, a duplicate type (two
 * attachments can't both fill one field), or a requiredSecretNames count
 * that doesn't match the type's fixed field count.
 */
function mapChannelsToPayloadFields(channels: ClientProfile["attachments"]["channels"]): ChannelFieldMapping[] {
  const seenTypes = new Set<string>();
  const mappings: ChannelFieldMapping[] = [];

  for (const channel of channels) {
    const expectedCount = CHANNEL_SECRET_COUNTS.get(channel.type);
    if (expectedCount === undefined) {
      throw new Error(
        `Unsupported channel type '${channel.type}'; /setup/api/run only accepts telegram, discord, and slack.`
      );
    }
    if (seenTypes.has(channel.type)) {
      throw new Error(
        `Profile has more than one '${channel.type}' channel attachment; ` +
          "/setup/api/run has only one field per channel type."
      );
    }
    seenTypes.add(channel.type);

    if (channel.requiredSecretNames.length !== expectedCount) {
      throw new Error(
        `'${channel.type}' channel attachment must declare exactly ${expectedCount} requiredSecretNames; ` +
          `found ${channel.requiredSecretNames.length}.`
      );
    }

    if (channel.type === "slack") {
      const botToken = channel.requiredSecretNames[0];
      const appToken = channel.requiredSecretNames[1];
      if (botToken === undefined || appToken === undefined) {
        throw new Error("'slack' channel attachment has malformed requiredSecretNames.");
      }
      // Positional convention (bot token first, app token second) -- not
      // independently confirmed live; matches issue #7's own example
      // ordering (ACME_SLACK_BOT_TOKEN, ACME_SLACK_APP_TOKEN). See plan.md.
      mappings.push({ field: "slackBotToken", secretName: botToken });
      mappings.push({ field: "slackAppToken", secretName: appToken });
    } else {
      const secretName = channel.requiredSecretNames[0];
      if (secretName === undefined) {
        throw new Error(`'${channel.type}' channel attachment has no requiredSecretNames.`);
      }
      mappings.push({
        field: channel.type === "telegram" ? "telegramToken" : "discordToken",
        secretName
      });
    }
  }

  return mappings;
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
  /** Set only when this call actually minted a new OpenRouter key (the secret name was absent from Railway variables). */
  mintedKeyHash?: string;
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
  // authGroup is never sent to /setup/api/run (confirmed live -- it's UI
  // grouping-only in the real wizard, see plan.md's Live Confirmation) --
  // only authChoice is part of the outgoing payload.
  let resolvedProvider:
    | {
        authChoice: string;
        flow: string;
        authSecret: string;
        customProviderApiKeyEnv?: string;
      }
    | undefined;
  let mintedKeyHash: string | undefined;

  if (provider !== undefined) {
    const resolution = await resolveProviderSecret(provider, existingVars, options.service, dependencies);
    redeployTriggered = redeployTriggered || resolution.triggeredRedeploy;
    mintedKeyHash = resolution.mintedKeyHash;
    resolvedProvider = {
      authChoice: provider.nonSecretConfig.authChoice,
      flow: provider.nonSecretConfig.flow,
      authSecret: resolution.value,
      ...(provider.nonSecretConfig.customProviderApiKeyEnv !== undefined
        ? { customProviderApiKeyEnv: provider.nonSecretConfig.customProviderApiKeyEnv }
        : {})
    };
  }

  const resolvedChannelFields: Partial<Record<ChannelPayloadField, string>> = {};
  for (const mapping of mapChannelsToPayloadFields(profile.attachments.channels)) {
    const value = existingVars[mapping.secretName];
    if (value === undefined) {
      throw new Error(
        `Required secret '${mapping.secretName}' not found in Railway variables for service '${options.service}'.`
      );
    }
    resolvedChannelFields[mapping.field] = value;
  }

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

  // Flat payload -- confirmed live against the real wizard's own
  // request-building source (app.js), not guessed. See
  // docs/plans/setup-run-payload-contract/plan.md's Live Confirmation.
  const payload = {
    ...(resolvedProvider ?? {}),
    ...resolvedChannelFields
  };

  await dependencies.setupApiClient.run(payload);

  const postRunStatus = await dependencies.setupApiClient.getStatus();
  if (!isConfigured(postRunStatus)) {
    throw new Error(
      "POST /setup/api/run completed but GET /setup/api/status still does not report configured."
    );
  }

  return { outcome: "applied", ...(mintedKeyHash !== undefined ? { mintedKeyHash } : {}) };
}

function isConfigured(status: unknown): boolean {
  // `configured: boolean` on the /setup/api/status response is confirmed
  // against a live instance -- see
  // docs/plans/setup-run-payload-contract/plan.md's Live Confirmation.
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
): Promise<{ value: string; triggeredRedeploy: boolean; mintedKeyHash?: string }> {
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
    { name: secretName, value: minted.key, service, skipDeploys: !requiresRedeploy },
    dependencies
  );

  return { value: minted.key, triggeredRedeploy: requiresRedeploy, mintedKeyHash: minted.hash };
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
