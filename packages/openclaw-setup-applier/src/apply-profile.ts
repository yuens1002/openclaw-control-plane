import { parseClientProfile, type ClientProfile } from "./profile-schema.js";
import { listRailwayVariables, type RailwayVariableReaderDependencies } from "./railway-variables.js";

// Session 1 scope only: this file currently implements the non-mutating
// `--dry-run` path. Session 2 adds the mutating apply path (mint-if-needed,
// write variable, re-healthcheck, call /setup/api/run, verify via
// /setup/api/status) to this same module.

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
    token: "<redacted>";
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
    channels: profile.attachments.channels.map((channel) => ({
      channelType: channel.type,
      token: "<redacted>" as const
    }))
  };
}
