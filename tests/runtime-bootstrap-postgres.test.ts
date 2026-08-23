import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { parseEventEnvelope } from "@openclaw-control-plane/contracts";
import { initializePostgresRuntime } from "@openclaw-control-plane/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString = process.env.TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

describePostgres("PostgreSQL runtime bootstrap", () => {
  const databaseName = `runtime_bootstrap_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: connectionString! });
  const databaseUrl = new URL(connectionString!);
  databaseUrl.pathname = `/${databaseName}`;
  const migrationsDirectory = fileURLToPath(
    new URL("../packages/db/migrations", import.meta.url)
  );

  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE ${databaseName}`);
  });

  afterAll(async () => {
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
      [databaseName]
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await adminPool.end();
  });

  it("migrates, synchronizes registrations, persists, and restarts ready", async () => {
    const first = await initializePostgresRuntime(
      databaseUrl.toString(),
      migrationsDirectory
    );
    expect(await first.readiness()).toEqual({
      database: "ready",
      migrations: "ready",
      registry: "ready"
    });
    const event = parseEventEnvelope({
      event_id: "00000000-0000-4000-8000-000000004001",
      event_type: "example.observation_received",
      occurred_at: "2026-08-23T12:00:00.000Z",
      source: "bootstrap-fixture",
      domain: "example-workflow",
      actor: { type: "system", id: "fixture" },
      subject: { type: "environment", id: "production" },
      sensitivity: "business",
      idempotency_key: "bootstrap-event-key-4001",
      payload: { statement: "ready" }
    });
    await first.eventStore.insertEventIfNew(event, {
      authenticated_principal_ref: "principal://service/bootstrap-test",
      effective_actor: { type: "service", id: "bootstrap-test" },
      request_origin: "internal",
      authorization: {
        decision_id: "bootstrap-ingest-4001",
        action: "runtime.event.ingest",
        result: "allowed",
        policy_version: "test-policy-v1",
        reason_codes: ["runtime.test_ingest"]
      }
    });
    await first.close();

    const restarted = await initializePostgresRuntime(
      databaseUrl.toString(),
      migrationsDirectory
    );
    expect(await restarted.eventStore.getEventByIdempotencyKey(event.idempotency_key)).toEqual(
      event
    );
    expect(await restarted.readiness()).toEqual({
      database: "ready",
      migrations: "ready",
      registry: "ready"
    });
    await restarted.close();
  });
});
