import { z } from "zod";

import type { IssuerConfiguration, RuntimeAuthConfiguration } from "./config.js";

const JwksDocumentSchema = z.object({
  keys: z.array(z.object({ kid: z.string().min(1), kty: z.string().min(1) }).passthrough()).min(1)
});

export interface IdentityReadiness {
  identity: "ready" | "invalid";
  jwks: "ready" | "unavailable";
}

export async function checkIdentityReadiness(
  config: RuntimeAuthConfiguration,
  fetchImpl: typeof fetch = fetch
): Promise<IdentityReadiness> {
  if (!config.issuers.length || !config.principals.length) {
    return { identity: "invalid", jwks: "unavailable" };
  }
  const checks = await Promise.all(config.issuers.map((issuer) => checkIssuer(issuer, fetchImpl)));
  return {
    identity: "ready",
    jwks: checks.every(Boolean) ? "ready" : "unavailable"
  };
}

async function checkIssuer(issuer: IssuerConfiguration, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(issuer.jwks_uri, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) return false;
    return JwksDocumentSchema.safeParse(await response.json()).success;
  } catch {
    return false;
  }
}
