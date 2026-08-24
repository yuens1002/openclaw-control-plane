import { createServer } from "node:http";

import { initializePostgresRuntime } from "@openclaw-control-plane/db";
import {
  checkIdentityReadiness,
  parseRuntimeAuthConfiguration,
  type RuntimeEnvironment
} from "@openclaw-control-plane/runtime-auth";

const databaseUrl = process.env.DATABASE_URL;
const authConfigJson = process.env.RUNTIME_AUTH_CONFIG_JSON;
if (!databaseUrl) throw new Error("DATABASE_URL is required to start the runtime worker.");
if (!authConfigJson) throw new Error("RUNTIME_AUTH_CONFIG_JSON is required to start the runtime worker.");
const environment = normalizeEnvironment(process.env.NODE_ENV);
if (environment === "production" && process.env.RUNTIME_ENABLE_BASIC_AUTH === "true") {
  throw new Error("Development Basic Authentication cannot be enabled in production.");
}
const authConfig = parseRuntimeAuthConfiguration(JSON.parse(authConfigJson), environment);
const runtime = await initializePostgresRuntime(databaseUrl, {
  ...(process.env.DATABASE_URL_UNPOOLED
    ? { migrationDatabaseUrl: process.env.DATABASE_URL_UNPOOLED }
    : {})
});
const port = Number(process.env.PORT ?? 8788);

const server = createServer(async (request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  const [persistence, identity] = await Promise.all([
    runtime.readiness(),
    checkIdentityReadiness(authConfig)
  ]);
  const ready =
    persistence.database === "ready" &&
    persistence.migrations === "ready" &&
    persistence.registry === "ready" &&
    identity.identity === "ready" &&
    identity.jwks === "ready";
  response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify({ ready, ...persistence, ...identity, workflows: [] }));
});
server.listen(port, () => console.log(`workflow-neutral runtime worker listening on :${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => void runtime.close().finally(() => process.exit(0)));
  });
}

function normalizeEnvironment(value: string | undefined): RuntimeEnvironment {
  if (value === "production" || value === "test") return value;
  return "development";
}
