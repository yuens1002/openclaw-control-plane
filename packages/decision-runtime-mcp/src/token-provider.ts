import { z } from "zod";

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

export interface ClientCredentialsTokenProviderOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
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
    const expiresAt = acquiredAt + parsed.expires_in * 1000;
    cached = {
      token: parsed.access_token,
      expiresAt,
      refreshAt: Math.max(acquiredAt, expiresAt - config.refreshSkewSeconds * 1000)
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
