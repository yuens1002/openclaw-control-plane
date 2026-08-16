// OpenRouter's Provisioning API mints a scoped key. This module never
// prints, logs, or persists the minted key — it is returned to the caller,
// which is responsible for passing it directly into the single call that
// needs it (Railway variable write, /setup/api/run payload) and nowhere
// else. Tests must stub `fetch`; this endpoint is real, billable, and
// irreversible — never call it from a test or CI run.

const OPENROUTER_KEYS_URL = "https://openrouter.ai/api/v1/keys";

export interface OpenRouterProvisioningOptions {
  managementKey: string;
  fetchImpl?: typeof fetch;
}

export interface MintKeyRequest {
  name: string;
  spendLimitUsd: number;
  limitReset: string;
}

export class OpenRouterProvisioningError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`OpenRouter provisioning API returned ${status}`);
    this.name = "OpenRouterProvisioningError";
    this.status = status;
  }
}

export interface MintedOpenRouterKey {
  key: string;
  /** Opaque management identifier — required to disable/delete this key later. Never the secret itself. */
  hash: string;
}

/**
 * Mints a new OpenRouter API key scoped to the given spend limit. Returns
 * the minted key value plus its management `hash` (needed to delete the key
 * later via `deleteOpenRouterKey`) — never logs or persists either.
 */
export async function mintOpenRouterKey(
  request: MintKeyRequest,
  options: OpenRouterProvisioningOptions
): Promise<MintedOpenRouterKey> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(OPENROUTER_KEYS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.managementKey}`
    },
    // Never include the response body in a thrown error — it may echo
    // request fields back, and could in principle include the key itself.
    body: JSON.stringify({
      name: request.name,
      limit: request.spendLimitUsd,
      limit_reset: request.limitReset
    })
  });

  if (!response.ok) {
    throw new OpenRouterProvisioningError(response.status);
  }

  // Confirmed live (2026-08-16, diagnostic probe key immediately deleted
  // after inspection): the create response is `{ key: "<secret>", data: {
  // hash, name, ... } }` -- the secret is top-level, but `hash` is nested
  // under `data`, NOT top-level. This differs from an earlier guess (both
  // top-level) that shipped without live confirmation and orphaned a real,
  // untracked key on first live use (mint succeeded, hash-read failed, so
  // the key was never written anywhere and never deleted) -- see
  // docs/plans/onboarding-regression-pipeline/plan.md.
  const body = (await response.json()) as { key?: unknown; data?: { hash?: unknown } };
  if (typeof body.key !== "string" || body.key.length === 0) {
    throw new Error("OpenRouter provisioning API response did not include a key.");
  }
  const hash = body.data?.hash;
  if (typeof hash !== "string" || hash.length === 0) {
    throw new Error(
      "OpenRouter provisioning API response did not include a data.hash — cannot manage/delete this key later."
    );
  }
  return { key: body.key, hash };
}

/**
 * Deletes a previously-minted OpenRouter key by its management hash — never
 * the key value itself, only the opaque identifier `mintOpenRouterKey`
 * returned. Irreversible.
 */
export async function deleteOpenRouterKey(hash: string, options: OpenRouterProvisioningOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${OPENROUTER_KEYS_URL}/${hash}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${options.managementKey}`
    }
  });

  if (!response.ok) {
    throw new OpenRouterProvisioningError(response.status);
  }
}
