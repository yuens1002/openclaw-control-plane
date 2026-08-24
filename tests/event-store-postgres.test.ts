import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { parseEventEnvelope, type EventEnvelope } from "@openclaw-control-plane/contracts";
import {
  PostgresEventStore,
  PostgresRuntimeRepository,
  RuntimeTypeRegistry,
  runSqlMigrations,
  runtimeTypeRegistrations
} from "@openclaw-control-plane/db";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const connectionString = process.env.TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

describePostgres("PostgresEventStore", () => {
  const databaseName = `event_store_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: connectionString! });
  const databaseUrl = new URL(connectionString!);
  databaseUrl.pathname = `/${databaseName}`;
  const pool = new Pool({ connectionString: databaseUrl.toString() });
  const migrationsDirectory = fileURLToPath(
    new URL("../packages/db/migrations", import.meta.url)
  );

  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE ${databaseName}`);
    await runSqlMigrations(pool, migrationsDirectory);
    await new PostgresRuntimeRepository(
      pool,
      new RuntimeTypeRegistry(runtimeTypeRegistrations)
    ).synchronizeRegistry();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE
      events,
      runtime_records,
      record_streams,
      domains
      CASCADE`);
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
      [databaseName]
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await adminPool.end();
  });

  it("persists and retrieves an event with its canonical runtime record", async () => {
    const store = new PostgresEventStore(pool);
    const event = fixture("00000000-0000-4000-8000-000000002001", "event-key-2001");

    expect(await store.insertEventIfNew(event, trustedEventContext("2001"))).toEqual({ status: "inserted", event });
    expect(await store.getEventByIdempotencyKey(event.idempotency_key)).toEqual(event);

    const persisted = await pool.query<{
      runtime_record_id: string;
      record_sequence: string;
      type: string;
      authenticated_principal_ref: string;
      effective_actor: { type: string; id: string };
      payload: { reported_actor: EventEnvelope["actor"] };
    }>(`SELECT e.runtime_record_id, r.record_sequence, r.type,
               r.authenticated_principal_ref, r.effective_actor, r.payload
          FROM events e
          JOIN runtime_records r ON r.record_id = e.runtime_record_id
         WHERE e.idempotency_key = $1`, [event.idempotency_key]);

    expect(persisted.rows[0]).toMatchObject({
      runtime_record_id: event.event_id,
      record_sequence: "1",
      type: "runtime.ingested_event",
      authenticated_principal_ref: "principal://service/api-test",
      effective_actor: { type: "service", id: "api-test" },
      payload: { reported_actor: event.actor }
    });
  });

  it("returns the original event for sequential and concurrent retries", async () => {
    const store = new PostgresEventStore(pool);
    const original = fixture("00000000-0000-4000-8000-000000002002", "event-key-2002");
    const retry = {
      ...original,
      event_id: "00000000-0000-4000-8000-000000002003"
    };

    const context = trustedEventContext("2002");
    const inserted = await store.insertEventIfNew(original, context);
    const [first, second] = await Promise.all([
      store.insertEventIfNew(retry, context),
      store.insertEventIfNew(retry, context)
    ]);
    const sequential = await store.insertEventIfNew(retry, context);

    expect(inserted).toEqual({ status: "inserted", event: original });
    expect(first.status).toBe("duplicate");
    expect(second.status).toBe("duplicate");
    expect(first.event.event_id).toBe(original.event_id);
    expect(second.event.event_id).toBe(original.event_id);
    expect(sequential).toEqual({ status: "duplicate", event: original });

    const counts = await pool.query<{ events: string; records: string; next_sequence: string }>(
      `SELECT
         (SELECT count(*) FROM events) AS events,
         (SELECT count(*) FROM runtime_records) AS records,
         (SELECT next_record_sequence FROM record_streams WHERE stream_id = $1) AS next_sequence`,
      [`domain:${original.domain}`]
    );
    expect(counts.rows[0]).toEqual({ events: "1", records: "1", next_sequence: "2" });
  });

  it("allocates contiguous order for concurrent distinct events in one domain", async () => {
    const store = new PostgresEventStore(pool);

    await Promise.all([
      store.insertEventIfNew(
        fixture("00000000-0000-4000-8000-000000002004", "event-key-2004"),
        trustedEventContext("2004")
      ),
      store.insertEventIfNew(
        fixture("00000000-0000-4000-8000-000000002005", "event-key-2005"),
        trustedEventContext("2005")
      )
    ]);

    const records = await pool.query<{ record_sequence: string }>(
      `SELECT record_sequence
         FROM runtime_records
        WHERE stream_id = 'domain:example-workflow'
        ORDER BY record_sequence`
    );
    expect(records.rows.map((row) => Number(row.record_sequence))).toEqual([1, 2]);
  });

  it("rolls back the runtime append and stream advance when event insertion fails", async () => {
    const store = new PostgresEventStore(pool);
    const event = fixture("00000000-0000-4000-8000-000000002006", "event-key-2006");
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_test_event_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced event insert failure';
      END;
      $$;
      CREATE TRIGGER reject_test_event_insert
      BEFORE INSERT ON events
      FOR EACH ROW EXECUTE FUNCTION reject_test_event_insert();
    `);

    try {
      await expect(
        store.insertEventIfNew(event, trustedEventContext("2006"))
      ).rejects.toThrow("forced event insert failure");
    } finally {
      await pool.query("DROP TRIGGER reject_test_event_insert ON events");
      await pool.query("DROP FUNCTION reject_test_event_insert() ");
    }

    const counts = await pool.query<{ records: string; streams: string; events: string }>(
      `SELECT
         (SELECT count(*) FROM runtime_records) AS records,
         (SELECT count(*) FROM record_streams) AS streams,
         (SELECT count(*) FROM events) AS events`
    );
    expect(counts.rows[0]).toEqual({ records: "0", streams: "0", events: "0" });
  });
});

function fixture(eventId: string, idempotencyKey: string): EventEnvelope {
  return parseEventEnvelope({
    event_id: eventId,
    event_type: "example.lead_created",
    occurred_at: "2026-08-23T12:00:00.000Z",
    source: "test-fixture",
    domain: "example-workflow",
    actor: { type: "user", id: "user-123" },
    subject: { type: "lead", id: "lead-123" },
    sensitivity: "business",
    idempotency_key: idempotencyKey,
    payload: { name: "Example Lead" }
  });
}

function trustedEventContext(suffix: string) {
  return {
    authenticated_principal_ref: "principal://service/api-test",
    effective_actor: { type: "service" as const, id: "api-test" },
    request_origin: "http" as const,
    authorization: {
      decision_id: `event-ingest-${suffix}`,
      action: "runtime.event.ingest",
      result: "allowed" as const,
      policy_version: "test-policy-v1",
      reason_codes: ["runtime.test_ingest"]
    }
  };
}
