import {
  ClientCredentialsConfigSchema,
  isLoopbackUrl
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
    RUNTIME_API_URL: z.string().url(),
    OIDC_TOKEN_ENDPOINT: z.string().url(),
    OIDC_CLIENT_ID: z.string().min(1),
    OIDC_CLIENT_SECRET: z.string().min(1),
    OIDC_SCOPE: z.string().min(1).optional(),
    OIDC_AUDIENCE: z.string().min(1).optional(),
    OIDC_CLIENT_AUTH_METHOD: z
      .enum(["client_secret_basic", "client_secret_post"])
      .default("client_secret_basic"),
    OIDC_REFRESH_SKEW_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
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
  const token = ClientCredentialsConfigSchema.parse({
    tokenEndpoint: parsed.OIDC_TOKEN_ENDPOINT,
    clientId: parsed.OIDC_CLIENT_ID,
    clientSecret: parsed.OIDC_CLIENT_SECRET,
    ...(parsed.OIDC_SCOPE ? { scope: parsed.OIDC_SCOPE } : {}),
    ...(parsed.OIDC_AUDIENCE ? { audience: parsed.OIDC_AUDIENCE } : {}),
    authMethod: parsed.OIDC_CLIENT_AUTH_METHOD,
    refreshSkewSeconds: parsed.OIDC_REFRESH_SKEW_SECONDS,
    requestTimeoutMs: parsed.MCP_REQUEST_TIMEOUT_MS,
    allowInsecureTransport
  });
  return {
    mode: parsed.MCP_TRANSPORT,
    hosted: {
      hostname: parsed.MCP_HOST,
      port: parsed.MCP_PORT ?? parsed.PORT ?? 3001,
      ...(parsed.MCP_INBOUND_BEARER_TOKEN
        ? { bearerToken: parsed.MCP_INBOUND_BEARER_TOKEN }
        : {})
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
