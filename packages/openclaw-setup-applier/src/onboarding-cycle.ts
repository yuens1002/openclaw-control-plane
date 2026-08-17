import {
  provisionClientInstance,
  type ProvisionClientDependencies,
  type ProvisionClientOptions,
  type ProvisionClientResult
} from "@openclaw-control-plane/openclaw-railway-installer/provision-client";

import { applyProfile, dryRunApplyProfile, type ApplyResult, type DryRunResult } from "./apply-profile.js";
import { deleteOpenRouterKey, mintOpenRouterKey } from "./openrouter-provisioning.js";
import { parseClientProfile } from "./profile-schema.js";
import { writeRailwayVariable, type RailwayVariableReaderDependencies } from "./railway-variables.js";
import { createSetupApiClient } from "./setup-api-client.js";

// `applyProfile` is a one-time bootstrap action (it no-ops once the instance
// reports configured, and only mints when the secret is absent) — a
// recurring regression job cannot just re-call it. This module composes two
// distinct flows instead: `bootstrapOnboardingCycle` (provision + apply,
// once) and `runRegressionCheck` (mint a fresh key, verify, delete — every
// run, unconditionally, no matter the verification's own outcome).

export interface BootstrapOnboardingCycleOptions {
  clientName: string;
  /** Parsed (not yet validated) client profile JSON. */
  profile: unknown;
  workspace?: string;
  projectId?: string;
}

export interface BootstrapOnboardingCycleDependencies extends ProvisionClientDependencies {
  openRouterManagementKey: string;
  fetchImpl?: typeof fetch;
}

export interface BootstrapOnboardingCycleResult {
  provision: ProvisionClientResult;
  dryRun: DryRunResult;
  apply: ApplyResult;
}

/**
 * Provisions the fixture instance (idempotent — reuses an existing healthy
 * service rather than recreating it) and applies the given profile.
 * Deliberately does NOT delete any minted OpenRouter key: the caller needs
 * a live key for a human-supervised verification step (e.g. a dashboard
 * chat proof) before that key is torn down as a separate, explicit step.
 */
export async function bootstrapOnboardingCycle(
  options: BootstrapOnboardingCycleOptions,
  dependencies: BootstrapOnboardingCycleDependencies
): Promise<BootstrapOnboardingCycleResult> {
  const provisionOptions: ProvisionClientOptions = {
    clientName: options.clientName,
    ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
    ...(options.workspace !== undefined ? { workspace: options.workspace } : {})
  };
  const provision = await provisionClientInstance(provisionOptions, dependencies);
  const baseUrl = `https://${provision.domain}`;

  const dryRun = await dryRunApplyProfile(options.profile, { service: provision.serviceName }, dependencies);

  const setupApiClient = createSetupApiClient({
    baseUrl,
    auth: { username: provision.setupUsername, password: provision.setupPassword },
    ...(dependencies.fetchImpl !== undefined ? { fetchImpl: dependencies.fetchImpl } : {})
  });
  const apply = await applyProfile(
    options.profile,
    { service: provision.serviceName, instanceBaseUrl: baseUrl },
    {
      runner: dependencies.runner,
      setupApiClient,
      openRouterManagementKey: dependencies.openRouterManagementKey,
      ...(dependencies.fetchImpl !== undefined ? { fetchImpl: dependencies.fetchImpl } : {})
    }
  );

  return { provision, dryRun, apply };
}

export interface RegressionCheckOptions {
  service: string;
  instanceBaseUrl: string;
  /** Parsed (not yet validated) client profile JSON — must declare exactly one modelProviders attachment with keyProvisioning intent. */
  profile: unknown;
  setupUsername: string;
  setupPassword: string;
}

export interface RegressionCheckDependencies extends RailwayVariableReaderDependencies {
  openRouterManagementKey: string;
  fetchImpl?: typeof fetch;
}

export interface RegressionCheckResult {
  passed: boolean;
  statusConfigured?: boolean;
  healthzStatus?: number;
  error?: string;
  /** The hash of the key this run minted, regardless of whether deletion below succeeded. */
  mintedKeyHash: string;
  /** Whether the delete-in-`finally` call actually succeeded. `passed` is forced false when this is false. */
  keyDeleted: boolean;
}

/**
 * Mints a fresh OpenRouter key, writes it to the profile's declared
 * model-provider Railway variable, then checks the instance is still
 * configured and healthy. Deletion of the minted key is always attempted in
 * a `finally` block — whether the checks passed, failed, or threw — so no
 * regression run ever *tries* to leave a live key behind. That attempt can
 * itself fail (network error, revoked management key, etc.): this function
 * never throws past the `finally` boundary for that failure — it's caught
 * and folded into the returned result (`keyDeleted: false`, `passed` forced
 * false) instead, so an unattended scheduled run always gets back a
 * diagnosable result rather than an uncaught exception that masks whatever
 * the verification step already found. Never re-calls `/setup/api/run`: the
 * instance is already configured by `bootstrapOnboardingCycle`, and this
 * function only proves liveness/auth and the key-lifecycle round-trip, not
 * a live model response (that stays a human-supervised check elsewhere).
 */
export async function runRegressionCheck(
  options: RegressionCheckOptions,
  dependencies: RegressionCheckDependencies
): Promise<RegressionCheckResult> {
  const profile = parseClientProfile(options.profile);
  if (profile.attachments.modelProviders.length !== 1) {
    throw new Error(
      `Profile must declare exactly one modelProviders attachment for a regression check; found ${profile.attachments.modelProviders.length}.`
    );
  }
  const provider = profile.attachments.modelProviders[0]!;
  const secretName = provider.requiredSecretNames[0];
  if (secretName === undefined) {
    throw new Error("Model provider attachment has no requiredSecretNames.");
  }
  const keyProvisioning = provider.nonSecretConfig.keyProvisioning;
  if (keyProvisioning === undefined) {
    throw new Error(
      "Model provider attachment has no keyProvisioning intent; regression-check only supports the managed-tier mint/delete cycle."
    );
  }

  const fetchImpl = dependencies.fetchImpl;
  const openRouterOptions = {
    managementKey: dependencies.openRouterManagementKey,
    ...(fetchImpl !== undefined ? { fetchImpl } : {})
  };

  const minted = await mintOpenRouterKey(
    { name: secretName, spendLimitUsd: keyProvisioning.spendLimitUsd, limitReset: keyProvisioning.limitReset },
    openRouterOptions
  );

  let passed = false;
  let statusConfigured: boolean | undefined;
  let healthzStatus: number | undefined;
  let error: string | undefined;
  let keyDeleted = false;

  try {
    await writeRailwayVariable(
      { name: secretName, value: minted.key, service: options.service, skipDeploys: true },
      dependencies
    );

    const setupApiClient = createSetupApiClient({
      baseUrl: options.instanceBaseUrl,
      auth: { username: options.setupUsername, password: options.setupPassword },
      ...(fetchImpl !== undefined ? { fetchImpl } : {})
    });
    const status = await setupApiClient.getStatus();
    statusConfigured =
      typeof status === "object" &&
      status !== null &&
      "configured" in status &&
      (status as { configured: unknown }).configured === true;

    const healthFetch = fetchImpl ?? fetch;
    const healthResponse = await healthFetch(`${options.instanceBaseUrl.replace(/\/$/, "")}/setup/healthz`);
    healthzStatus = healthResponse.status;

    passed = statusConfigured === true && healthzStatus === 200;
    if (!passed) {
      error = `regression check failed: statusConfigured=${String(statusConfigured)}, healthzStatus=${String(healthzStatus)}`;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    // Unconditional: this line must run whether the try block above passed,
    // failed its own assertions, or threw. No standing OpenRouter key ever
    // survives a regression-check run. A delete failure here must not mask
    // an earlier verification error (or throw past this function's
    // structured-result contract) — caught and folded into the result
    // instead, per Copilot's PR #26 review: an unattended scheduled run
    // that crashes with only "delete failed" and no verification context
    // is much harder to diagnose than a returned result carrying both.
    let deleteError: string | undefined;
    try {
      await deleteOpenRouterKey(minted.hash, openRouterOptions);
    } catch (deleteCaught) {
      deleteError = deleteCaught instanceof Error ? deleteCaught.message : String(deleteCaught);
    }
    keyDeleted = deleteError === undefined;
    if (!keyDeleted) {
      passed = false;
      error = error !== undefined ? `${error}; additionally, key deletion failed: ${deleteError}` : `key deletion failed: ${deleteError}`;
    }
  }

  return {
    passed,
    mintedKeyHash: minted.hash,
    keyDeleted,
    ...(statusConfigured !== undefined ? { statusConfigured } : {}),
    ...(healthzStatus !== undefined ? { healthzStatus } : {}),
    ...(error !== undefined ? { error } : {})
  };
}
