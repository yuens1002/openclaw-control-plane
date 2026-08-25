import { serve } from "@hono/node-server";
import {
  InMemoryEventStore,
  initializePostgresRuntime,
  type PostgresRuntime
} from "@openclaw-control-plane/db";
import {
  OidcAuthenticator,
  StaticRbacAuthorizationProvider,
  TrustedContextCoordinator,
  checkIdentityReadiness,
  parseRuntimeAuthConfiguration,
  type RuntimeEnvironment
} from "@openclaw-control-plane/runtime-auth";
import { createControlPlaneApp } from "./index.js";

const port = Number(process.env.PORT ?? 8787);
const databaseUrl = process.env.DATABASE_URL;
const migrationDatabaseUrl = process.env.DATABASE_URL_UNPOOLED;
const authConfigJson = process.env.RUNTIME_AUTH_CONFIG_JSON;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to start the production API server.");
}
if (!authConfigJson) {
  throw new Error("RUNTIME_AUTH_CONFIG_JSON is required to start the production API server.");
}

const environment = normalizeEnvironment(process.env.NODE_ENV);
if (environment === "production" && process.env.RUNTIME_ENABLE_BASIC_AUTH === "true") {
  throw new Error("Development Basic Authentication cannot be enabled in production.");
}
const authConfig = parseRuntimeAuthConfiguration(JSON.parse(authConfigJson), environment);
const authenticator = new OidcAuthenticator(authConfig);
const authorizationProvider = new StaticRbacAuthorizationProvider(authConfig);
const trustedContextCoordinator = new TrustedContextCoordinator(authorizationProvider);

let runtime: PostgresRuntime | undefined;
try {
  runtime = await initializePostgresRuntime(databaseUrl, {
    ...(migrationDatabaseUrl ? { migrationDatabaseUrl } : {})
  });
} catch (error) {
  console.error("Runtime persistence bootstrap failed; starting health-only API", {
    error: error instanceof Error ? error.message : "unknown bootstrap failure"
  });
}
const app = createControlPlaneApp({
  eventStore: runtime?.eventStore ?? new InMemoryEventStore(),
  readiness: runtime?.readiness ?? (async () => ({
    database: "unavailable",
    migrations: "missing",
    registry: "invalid"
  })),
  ...(runtime ? { runtimeApiService: runtime.apiService } : {}),
  authenticator,
  trustedContextCoordinator,
  identityReadiness: () => checkIdentityReadiness(authConfig)
});

const server = serve({
  fetch: app.fetch,
  port
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void (runtime?.close() ?? Promise.resolve()).finally(() => process.exit(0));
    });
  });
}

console.log(`openclaw-control-plane API listening on :${port}`);

function normalizeEnvironment(value: string | undefined): RuntimeEnvironment {
  if (value === "production" || value === "test") return value;
  return "development";
}
