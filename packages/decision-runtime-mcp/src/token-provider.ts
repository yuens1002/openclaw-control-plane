import { createPrivateKey, randomUUID, type KeyObject } from "node:crypto";

import { SignJWT } from "jose";
import { z } from "zod";

const WorkloadJwtAlgorithmSchema = z.enum([
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA"
]);

const TokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().transform((value, context) => {
      if (value.toLowerCase() !== "bearer") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Unsupported token type." });
        return z.NEVER;
      }
      return "Bearer" as const;
    }),
    expires_in: z.number().int().positive().max(86_400)
  })
  .passthrough();

export const ClientCredentialsConfigSchema = z
  .object({
    tokenEndpoint: z.string().url(),
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(4096),
    scope: z.string().min(1).max(2048).optional(),
    audience: z.string().min(1).max(2048).optional(),
    authMethod: z.enum(["client_secret_basic", "client_secret_post"]).default("client_secret_basic"),
    refreshSkewSeconds: z.number().int().min(5).max(300).default(30),
    requestTimeoutMs: z.number().int().min(100).max(30_000).default(5_000),
    allowInsecureTransport: z.boolean().default(false)
  })
  .strict()
  .superRefine((config, context) => {
    const endpoint = new URL(config.tokenEndpoint);
    if (
      endpoint.protocol !== "https:" &&
      (!config.allowInsecureTransport || !isLoopbackUrl(endpoint))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tokenEndpoint"],
        message: "OIDC token endpoint requires HTTPS."
      });
    }
  });

export type ClientCredentialsConfig = z.input<typeof ClientCredentialsConfigSchema>;

export const WorkloadJwtConfigSchema = z
  .object({
    issuer: z.string().url().max(2048),
    subject: z.string().min(1).max(512),
    audience: z.string().min(1).max(2048),
    keyId: z.string().min(1).max(256),
    algorithm: WorkloadJwtAlgorithmSchema,
    privateKeyPem: z
      .string()
      .min(1)
      .max(32_768)
      .refine(
        (value) => value.includes("-----BEGIN PRIVATE KEY-----"),
        "Workload JWT key must be PKCS#8 private key material."
      ),
    lifetimeSeconds: z.number().int().min(30).max(3_600).default(300),
    refreshSkewSeconds: z.number().int().min(5).max(300).default(30),
    allowInsecureTransport: z.boolean().default(false)
  })
  .strict()
  .superRefine((config, context) => {
    const issuer = new URL(config.issuer);
    if (
      issuer.protocol !== "https:" &&
      (!config.allowInsecureTransport || !isLoopbackUrl(issuer))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issuer"],
        message: "Workload JWT issuer requires HTTPS."
      });
    }
    if (config.refreshSkewSeconds >= config.lifetimeSeconds) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["refreshSkewSeconds"],
        message: "Workload JWT refresh skew must be shorter than its lifetime."
      });
    }
  });

export type WorkloadJwtConfig = z.input<typeof WorkloadJwtConfigSchema>;

export interface ClientCredentialsTokenProviderOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface WorkloadJwtTokenProviderOptions {
  now?: () => number;
  randomId?: () => string;
}

export function createWorkloadJwtTokenProvider(
  input: WorkloadJwtConfig,
  options: WorkloadJwtTokenProviderOptions = {}
) {
  const config = WorkloadJwtConfigSchema.parse(input);
  const privateKey = parseWorkloadPrivateKey(config.privateKeyPem, config.algorithm);
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? randomUUID;
  let cached: { token: string; refreshAt: number; expiresAt: number } | undefined;
  let refresh: Promise<string> | undefined;

  async function sign() {
    const issuedAt = Math.floor(now() / 1000);
    const expiresAtSeconds = issuedAt + config.lifetimeSeconds;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: config.algorithm, kid: config.keyId, typ: "JWT" })
      .setIssuer(config.issuer)
      .setSubject(config.subject)
      .setAudience(config.audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAtSeconds)
      .setJti(randomId())
      .sign(privateKey);
    const expiresAt = expiresAtSeconds * 1000;
    cached = {
      token,
      expiresAt,
      refreshAt: expiresAt - config.refreshSkewSeconds * 1000
    };
    return token;
  }

  async function getToken() {
    const timestamp = now();
    if (cached && timestamp < cached.refreshAt && timestamp < cached.expiresAt) return cached.token;
    if (!refresh) {
      refresh = sign().finally(() => {
        refresh = undefined;
      });
    }
    return refresh;
  }

  function invalidate(token?: string) {
    if (!token || cached?.token === token) cached = undefined;
  }

  function status() {
    return {
      ready: true,
      cached: Boolean(cached && now() < cached.expiresAt)
    };
  }

  return { getToken, invalidate, status };
}

export function createClientCredentialsTokenProvider(
  input: ClientCredentialsConfig,
  options: ClientCredentialsTokenProviderOptions = {}
) {
  const config = ClientCredentialsConfigSchema.parse(input);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { token: string; refreshAt: number; expiresAt: number } | undefined;
  let refresh: Promise<string> | undefined;

  async function acquire() {
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    if (config.scope) body.set("scope", config.scope);
    if (config.audience) body.set("audience", config.audience);
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded"
    };
    if (config.authMethod === "client_secret_basic") {
      const clientId = formEncode(config.clientId);
      const clientSecret = formEncode(config.clientSecret);
      headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    } else {
      body.set("client_id", config.clientId);
      body.set("client_secret", config.clientSecret);
    }

    let response: Response;
    try {
      response = await fetchImpl(config.tokenEndpoint, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(config.requestTimeoutMs)
      });
    } catch {
      throw new Error("OIDC token request failed.");
    }
    if (!response.ok) throw new Error(`OIDC token endpoint returned ${response.status}.`);

    let parsed: z.infer<typeof TokenResponseSchema>;
    try {
      parsed = TokenResponseSchema.parse(await response.json());
    } catch {
      throw new Error("OIDC token endpoint returned an invalid response.");
    }
    const acquiredAt = now();
    const lifetimeMs = parsed.expires_in * 1000;
    const expiresAt = acquiredAt + lifetimeMs;
    const configuredSkewMs = config.refreshSkewSeconds * 1000;
    const refreshSafetyMs =
      configuredSkewMs < lifetimeMs
        ? configuredSkewMs
        : Math.max(1, Math.floor(lifetimeMs / 10));
    cached = {
      token: parsed.access_token,
      expiresAt,
      refreshAt: expiresAt - refreshSafetyMs
    };
    return parsed.access_token;
  }

  async function getToken() {
    const timestamp = now();
    if (cached && timestamp < cached.refreshAt && timestamp < cached.expiresAt) return cached.token;
    if (!refresh) {
      refresh = acquire().finally(() => {
        refresh = undefined;
      });
    }
    return refresh;
  }

  function invalidate(token?: string) {
    if (!token || cached?.token === token) cached = undefined;
  }

  function status() {
    return {
      ready: true,
      cached: Boolean(cached && now() < cached.expiresAt)
    };
  }

  return { getToken, invalidate, status };
}

export function isLoopbackUrl(value: URL) {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(value.hostname.toLowerCase());
}

function formEncode(value: string) {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

function parseWorkloadPrivateKey(pem: string, algorithm: z.infer<typeof WorkloadJwtAlgorithmSchema>) {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
  } catch {
    throw new Error("Invalid workload JWT private key.");
  }
  const keyType = key.asymmetricKeyType;
  const expectedType = algorithm.startsWith("RS")
    ? "rsa"
    : algorithm.startsWith("ES")
      ? "ec"
      : "ed";
  const matches =
    expectedType === "rsa"
      ? keyType === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048
      : expectedType === "ec"
        ? keyType === "ec" && matchesEcCurve(key, algorithm)
        : keyType === "ed25519" || keyType === "ed448";
  if (!matches) throw new Error("Workload JWT private key does not match its algorithm.");
  return key;
}

function matchesEcCurve(
  key: KeyObject,
  algorithm: z.infer<typeof WorkloadJwtAlgorithmSchema>
) {
  const curve = key.asymmetricKeyDetails?.namedCurve;
  return (
    (algorithm === "ES256" && curve === "prime256v1") ||
    (algorithm === "ES384" && curve === "secp384r1") ||
    (algorithm === "ES512" && curve === "secp521r1")
  );
}
