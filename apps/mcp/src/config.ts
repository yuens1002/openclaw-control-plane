import {
  ClientCredentialsConfigSchema,
  isLoopbackUrl,
  WorkloadJwtConfigSchema
} from "@openclaw-control-plane/decision-runtime-mcp";
import { z } from "zod";

const BooleanStringSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .default("false");

const EnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
    MCP_TRANSPORT: z.enum(["stdio", "streamable-http"]).default("stdio"),
    MCP_HOST: z.string().min(1).default("0.0.0.0"),
    MCP_PORT: z.coerce.number().int().min(0).max(65_535).optional(),
    PORT: z.coerce.number().int().min(0).max(65_535).optional(),
    MCP_INBOUND_BEARER_TOKEN: z.string().min(16).optional(),
    MCP_ALLOWED_ORIGINS: z.string().optional(),
    RUNTIME_API_URL: z.string().url(),
    MCP_DOWNSTREAM_AUTH_MODE: z
      .enum(["oidc-client-credentials", "workload-jwt"])
      .default("oidc-client-credentials"),
    OIDC_TOKEN_ENDPOINT: z.string().url().optional(),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_SCOPE: z.string().min(1).optional(),
    OIDC_AUDIENCE: z.string().min(1).optional(),
    OIDC_CLIENT_AUTH_METHOD: z.enum(["client_secret_basic", "client_secret_post"]).optional(),
    OIDC_REFRESH_SKEW_SECONDS: z.coerce.number().int().min(5).max(300).optional(),
    MCP_WORKLOAD_JWT_ISSUER: z.string().url().optional(),
    MCP_WORKLOAD_JWT_SUBJECT: z.string().min(1).optional(),
    MCP_WORKLOAD_JWT_AUDIENCE: z.string().min(1).optional(),
    MCP_WORKLOAD_JWT_KEY_ID: z.string().min(1).optional(),
    MCP_WORKLOAD_JWT_ALGORITHM: z
      .enum(["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "EdDSA"])
      .optional(),
    MCP_WORKLOAD_JWT_PRIVATE_KEY: z.string().min(1).optional(),
    MCP_WORKLOAD_JWT_LIFETIME_SECONDS: z.coerce.number().int().min(30).max(3_600).optional(),
    MCP_WORKLOAD_JWT_REFRESH_SKEW_SECONDS: z.coerce.number().int().min(5).max(300).optional(),
    MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
    MCP_ALLOW_INSECURE_TRANSPORT: BooleanStringSchema
  })
  .passthrough()
  .superRefine((environment, context) => {
    if (environment.MCP_TRANSPORT === "streamable-http" && !environment.MCP_INBOUND_BEARER_TOKEN) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MCP_INBOUND_BEARER_TOKEN"],
        message: "Hosted MCP requires an inbound bearer token."
      });
    }
    if (environment.NODE_ENV === "production" && environment.MCP_ALLOW_INSECURE_TRANSPORT) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MCP_ALLOW_INSECURE_TRANSPORT"],
        message: "Insecure transport is unavailable in production."
      });
    }
    const oidcFields = [
      "OIDC_TOKEN_ENDPOINT",
      "OIDC_CLIENT_ID",
      "OIDC_CLIENT_SECRET",
      "OIDC_SCOPE",
      "OIDC_AUDIENCE",
      "OIDC_CLIENT_AUTH_METHOD",
      "OIDC_REFRESH_SKEW_SECONDS"
    ] as const;
    const workloadFields = [
      "MCP_WORKLOAD_JWT_ISSUER",
      "MCP_WORKLOAD_JWT_SUBJECT",
      "MCP_WORKLOAD_JWT_AUDIENCE",
      "MCP_WORKLOAD_JWT_KEY_ID",
      "MCP_WORKLOAD_JWT_ALGORITHM",
      "MCP_WORKLOAD_JWT_PRIVATE_KEY",
      "MCP_WORKLOAD_JWT_LIFETIME_SECONDS",
      "MCP_WORKLOAD_JWT_REFRESH_SKEW_SECONDS"
    ] as const;
    const requiredOidc = ["OIDC_TOKEN_ENDPOINT", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"] as const;
    const requiredWorkload = [
      "MCP_WORKLOAD_JWT_ISSUER",
      "MCP_WORKLOAD_JWT_SUBJECT",
      "MCP_WORKLOAD_JWT_AUDIENCE",
      "MCP_WORKLOAD_JWT_KEY_ID",
      "MCP_WORKLOAD_JWT_ALGORITHM",
      "MCP_WORKLOAD_JWT_PRIVATE_KEY"
    ] as const;
    const activeRequired =
      environment.MCP_DOWNSTREAM_AUTH_MODE === "workload-jwt" ? requiredWorkload : requiredOidc;
    const inactiveFields =
      environment.MCP_DOWNSTREAM_AUTH_MODE === "workload-jwt" ? oidcFields : workloadFields;
    for (const field of activeRequired) {
      if (environment[field] === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is required for ${environment.MCP_DOWNSTREAM_AUTH_MODE}.`
        });
      }
    }
    for (const field of inactiveFields) {
      if (environment[field] !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is not valid for ${environment.MCP_DOWNSTREAM_AUTH_MODE}.`
        });
      }
    }
  });

export function loadMcpAppConfig(environment: NodeJS.ProcessEnv) {
  const parsed = EnvironmentSchema.parse(environment);
  const allowInsecureTransport = parsed.MCP_ALLOW_INSECURE_TRANSPORT;
  const runtimeUrl = new URL(parsed.RUNTIME_API_URL);
  if (
    runtimeUrl.protocol !== "https:" &&
    (!allowInsecureTransport || !isLoopbackUrl(runtimeUrl))
  ) {
    throw new Error("Decision Runtime API requires HTTPS.");
  }
  const token =
    parsed.MCP_DOWNSTREAM_AUTH_MODE === "workload-jwt"
      ? {
          mode: "workload-jwt" as const,
          config: WorkloadJwtConfigSchema.parse({
            issuer: parsed.MCP_WORKLOAD_JWT_ISSUER,
            subject: parsed.MCP_WORKLOAD_JWT_SUBJECT,
            audience: parsed.MCP_WORKLOAD_JWT_AUDIENCE,
            keyId: parsed.MCP_WORKLOAD_JWT_KEY_ID,
            algorithm: parsed.MCP_WORKLOAD_JWT_ALGORITHM,
            privateKeyPem: parsed.MCP_WORKLOAD_JWT_PRIVATE_KEY,
            ...(parsed.MCP_WORKLOAD_JWT_LIFETIME_SECONDS
              ? { lifetimeSeconds: parsed.MCP_WORKLOAD_JWT_LIFETIME_SECONDS }
              : {}),
            ...(parsed.MCP_WORKLOAD_JWT_REFRESH_SKEW_SECONDS
              ? { refreshSkewSeconds: parsed.MCP_WORKLOAD_JWT_REFRESH_SKEW_SECONDS }
              : {}),
            allowInsecureTransport
          })
        }
      : {
          mode: "oidc-client-credentials" as const,
          config: ClientCredentialsConfigSchema.parse({
            tokenEndpoint: parsed.OIDC_TOKEN_ENDPOINT,
            clientId: parsed.OIDC_CLIENT_ID,
            clientSecret: parsed.OIDC_CLIENT_SECRET,
            ...(parsed.OIDC_SCOPE ? { scope: parsed.OIDC_SCOPE } : {}),
            ...(parsed.OIDC_AUDIENCE ? { audience: parsed.OIDC_AUDIENCE } : {}),
            ...(parsed.OIDC_CLIENT_AUTH_METHOD
              ? { authMethod: parsed.OIDC_CLIENT_AUTH_METHOD }
              : {}),
            ...(parsed.OIDC_REFRESH_SKEW_SECONDS
              ? { refreshSkewSeconds: parsed.OIDC_REFRESH_SKEW_SECONDS }
              : {}),
            requestTimeoutMs: parsed.MCP_REQUEST_TIMEOUT_MS,
            allowInsecureTransport
          })
        };
  const allowedOrigins = (parsed.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      try {
        const parsedOrigin = new URL(origin);
        if (parsedOrigin.origin !== origin) throw new Error();
        return parsedOrigin.origin;
      } catch {
        throw new Error(
          "MCP allowed origins must be absolute origins without credentials or paths."
        );
      }
    });
  return {
    mode: parsed.MCP_TRANSPORT,
    hosted: {
      hostname: parsed.MCP_HOST,
      port: parsed.MCP_PORT ?? parsed.PORT ?? 3001,
      ...(parsed.MCP_INBOUND_BEARER_TOKEN
        ? { bearerToken: parsed.MCP_INBOUND_BEARER_TOKEN }
        : {}),
      allowedOrigins
    },
    runtime: {
      baseUrl: parsed.RUNTIME_API_URL,
      allowInsecureTransport,
      requestTimeoutMs: parsed.MCP_REQUEST_TIMEOUT_MS
    },
    token
  };
}

export type McpAppConfig = ReturnType<typeof loadMcpAppConfig>;
