import { z } from "zod";

import type { IssuerConfiguration, RuntimeAuthConfiguration } from "./config.js";

const JwkSchema = z
  .object({
    kid: z.string().min(1),
    kty: z.enum(["RSA", "EC", "OKP"]),
    alg: z.string().min(1).optional(),
    use: z.string().optional()
  })
  .passthrough();
const JwksDocumentSchema = z.object({ keys: z.array(JwkSchema).min(1) });

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
    const document = JwksDocumentSchema.safeParse(await response.json());
    if (!document.success) return false;
    const keyIds = document.data.keys.map((key) => key.kid);
    if (new Set(keyIds).size !== keyIds.length) return false;
    return document.data.keys.some(
      (key) =>
        key.use !== "enc" &&
        issuer.allowed_algorithms.some(
          (algorithm) =>
            (!key.alg || key.alg === algorithm) &&
            ((algorithm.startsWith("RS") && key.kty === "RSA") ||
              (algorithm.startsWith("ES") && key.kty === "EC") ||
              (algorithm === "EdDSA" && key.kty === "OKP"))
        )
    );
  } catch {
    return false;
  }
}
