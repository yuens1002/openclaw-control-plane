import { serve } from "@hono/node-server";
import { initializePostgresRuntime } from "@openclaw-control-plane/db";
import { createControlPlaneApp } from "./index.js";

const port = Number(process.env.PORT ?? 8787);
const databaseUrl = process.env.DATABASE_URL;
const migrationDatabaseUrl = process.env.DATABASE_URL_UNPOOLED;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to start the production API server.");
}

const runtime = await initializePostgresRuntime(databaseUrl, {
  ...(migrationDatabaseUrl ? { migrationDatabaseUrl } : {})
});
const app = createControlPlaneApp({
  eventStore: runtime.eventStore,
  readiness: runtime.readiness
});

const server = serve({
  fetch: app.fetch,
  port
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void runtime.close().finally(() => process.exit(0));
    });
  });
}

console.log(`openclaw-control-plane API listening on :${port}`);
