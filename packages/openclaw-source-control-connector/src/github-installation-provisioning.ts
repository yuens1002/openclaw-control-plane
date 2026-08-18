// GitHub App JWT signing + installation access token exchange. This module
// never prints, logs, or persists a minted token — it is returned to the
// caller, which is responsible for using it in the single call that needs it
// and nowhere else. Tests must stub `fetchImpl`; the real endpoint mints a
// live, usable-for-up-to-an-hour token and cannot be un-minted — never call
// it from a test or CI run.
//
// Response field names (`expires_at`, `permissions`) are taken from GitHub's
// documented REST API contract, not confirmed against a live call — no App
// is registered yet (see docs/plans/github-installation-connector/plan.md).
// Parsing below fails loud on a missing/malformed field rather than silently
// returning `undefined` for it.

import { sign as cryptoSign } from "node:crypto";

const GITHUB_API_BASE = "https://api.github.com";
const JWT_ALGORITHM = "RSA-SHA256";
const JWT_CLOCK_DRIFT_SECONDS = 60;
const JWT_TTL_SECONDS = 600;

function base64url(input: Buffer | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buffer.toString("base64url");
}

/**
 * Signs a GitHub App JWT (RS256): header `{alg: "RS256", typ: "JWT"}`,
 * payload `{iat, exp, iss}` with `iss` set to the App id, `iat` backdated
 * `JWT_CLOCK_DRIFT_SECONDS` for clock skew, `exp` `JWT_TTL_SECONDS` after
 * `iat` (GitHub's documented ceiling is 10 minutes from `iat`). Pure and
 * synchronous — no network call.
 */
export function buildAppJwt(appId: string, privateKeyPem: string, now: () => Date = () => new Date()): string {
  const nowSeconds = Math.floor(now().getTime() / 1000);
  const issuedAt = nowSeconds - JWT_CLOCK_DRIFT_SECONDS;

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: issuedAt,
    exp: issuedAt + JWT_TTL_SECONDS,
    iss: appId
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = cryptoSign(JWT_ALGORITHM, Buffer.from(signingInput, "utf8"), privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

export interface MintInstallationTokenOptions {
  appId: string;
  privateKeyPem: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface MintedInstallationToken {
  token: string;
  expiresAt: string;
  permissions: Record<string, string>;
}

export class GitHubProvisioningError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`GitHub installation token API returned ${status}`);
    this.name = "GitHubProvisioningError";
    this.status = status;
  }
}

/**
 * Exchanges a freshly-signed App JWT for a short-lived installation access
 * token scoped to whatever repos/permissions the target installation
 * already grants. Never logs or persists the returned token.
 */
export async function mintInstallationToken(
  installationId: string,
  options: MintInstallationTokenOptions
): Promise<MintedInstallationToken> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const jwt = buildAppJwt(options.appId, options.privateKeyPem, options.now ?? (() => new Date()));

  const response = await fetchImpl(`${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28"
    }
  });

  if (!response.ok) {
    // Never include the response body in a thrown error — it could in
    // principle echo request fields back, and a malformed-response body is
    // no less sensitive than a token itself until proven otherwise.
    throw new GitHubProvisioningError(response.status);
  }

  const body = (await response.json()) as {
    token?: unknown;
    expires_at?: unknown;
    permissions?: unknown;
  };

  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error("GitHub installation token response did not include a 'token' field.");
  }
  if (typeof body.expires_at !== "string" || body.expires_at.length === 0) {
    throw new Error("GitHub installation token response did not include an 'expires_at' field.");
  }
  if (typeof body.permissions !== "object" || body.permissions === null || Array.isArray(body.permissions)) {
    throw new Error("GitHub installation token response did not include a 'permissions' object.");
  }

  return {
    token: body.token,
    expiresAt: body.expires_at,
    permissions: body.permissions as Record<string, string>
  };
}
