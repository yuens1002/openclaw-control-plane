import { serve } from "@hono/node-server";
import { initializePostgresRuntime } from "@openclaw-control-plane/db";
import { createControlPlaneApp } from "./index.js";

const port = Number(process.env.PORT ?? 8787);
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to start the production API server.");
}

const runtime = await initializePostgresRuntime(databaseUrl);
const app = createControlPlaneApp({
  eventStore: runtime.eventStore,
  readiness: runtime.readiness,
  eventCommandContext: () => ({
    authenticated_principal_ref: "principal://service/control-plane-api",
    effective_actor: { type: "service", id: "control-plane-api" },
    request_origin: "http",
    authorization: {
      decision_id: `compatibility-${Date.now()}`,
      action: "runtime.event.ingest",
      result: "allowed",
      policy_version: "m2-compatibility-v1",
      reason_codes: ["runtime.compatibility_ingest"]
    }
  })
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
