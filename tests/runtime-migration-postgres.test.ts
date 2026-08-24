import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  RuntimeKindSchema,
  RuntimePayloadSchema,
  RuntimeSubjectSchema,
  SafeNamespacedIdentifierSchema,
  TrustedCommandContextSchema
} from "@openclaw-control-plane/contracts";
import {
  PostgresRuntimeRepository,
  RuntimeTypeRegistry,
  legacyOperationRegistrations,
  legacyTypeRegistrations,
  runSqlMigrations
} from "@openclaw-control-plane/db";

const connectionString = process.env.TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

describePostgres("M1 to durable runtime PostgreSQL migration", () => {
  const databaseName = `runtime_migration_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: connectionString! });
  const databaseUrl = new URL(connectionString!);
  databaseUrl.pathname = `/${databaseName}`;
  const pool = new Pool({ connectionString: databaseUrl.toString() });
  const migrationsDirectory = dirname(
    fileURLToPath(new URL("../packages/db/migrations/0001_m1_foundations.sql", import.meta.url))
  );

  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE ${databaseName}`);
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

  it("preserves every M1 table row and links typed historical records", async () => {
    const m1Path = join(migrationsDirectory, "0001_m1_foundations.sql");
    const m1Sql = await readFile(m1Path, "utf8");
    const m1Digest = createHash("sha256").update(m1Sql, "utf8").digest("hex");
    await pool.query(m1Sql);
    await pool.query(`
      CREATE TABLE control_plane_migrations (
        name text PRIMARY KEY,
        digest text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool.query(
      "INSERT INTO control_plane_migrations (name, digest) VALUES ($1, $2)",
      ["0001_m1_foundations.sql", m1Digest]
    );
    await seedM1(pool);

    const tables = [
      "domains",
      "pipelines",
      "workers",
      "events",
      "work_items",
      "worker_runs",
      "approval_requests",
      "artifacts",
      "audit_log",
      "tasks",
      "commitments",
      "tool_invocations"
    ];
    const before = await rowCounts(pool, tables);

    await runSqlMigrations(pool, migrationsDirectory);

    expect(await rowCounts(pool, tables)).toEqual(before);
    const linked = await pool.query<{ table_name: string; linked: string }>(`
      SELECT 'events' AS table_name, count(runtime_record_id)::text AS linked FROM events
      UNION ALL SELECT 'work_items', count(runtime_record_id)::text FROM work_items
      UNION ALL SELECT 'worker_runs', count(runtime_record_id)::text FROM worker_runs
      UNION ALL SELECT 'approval_requests', count(runtime_record_id)::text FROM approval_requests
      UNION ALL SELECT 'artifacts', count(runtime_record_id)::text FROM artifacts
      UNION ALL SELECT 'audit_log', count(runtime_record_id)::text FROM audit_log
      UNION ALL SELECT 'tool_invocations', count(runtime_record_id)::text FROM tool_invocations
    `);
    expect(Object.fromEntries(linked.rows.map((row) => [row.table_name, row.linked]))).toEqual({
      events: "1",
      work_items: "1",
      worker_runs: "1",
      approval_requests: "1",
      artifacts: "1",
      audit_log: "1",
      tool_invocations: "1"
    });

    const legacy = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM runtime_records WHERE authenticated_principal_ref = 'principal://legacy/system'"
    );
    expect(Number(legacy.rows[0]!.count)).toBeGreaterThanOrEqual(7);
    const invalidDigests = await pool.query<{ count: string }>(`
      SELECT (
        (SELECT count(*) FROM type_registrations WHERE schema_digest !~ '^[a-f0-9]{64}$') +
        (SELECT count(*) FROM operation_registrations WHERE command_schema_digest !~ '^[a-f0-9]{64}$')
      )::text AS count
    `);
    expect(invalidDigests.rows[0]!.count).toBe("0");

    const migrated = await pool.query<{
      record_id: string;
      stream_id: string;
      kind: string;
      type: string;
      operation_type: string | null;
      operation_schema_version: number | null;
      command_context: unknown;
      effective_actor: unknown;
      subject: unknown;
      payload: unknown;
    }>(`
      SELECT record_id, stream_id, kind, type, operation_type, operation_schema_version, command_context,
             effective_actor, subject, payload
        FROM runtime_records
       ORDER BY stream_id, record_sequence
    `);
    expect(migrated.rows).toHaveLength(7);

    const repository = new PostgresRuntimeRepository(pool, new RuntimeTypeRegistry());
    for (const row of migrated.rows) {
      expect(await repository.getRecord(row.record_id)).not.toBeNull();
      expect(row.stream_id).toMatch(/^legacy-domain:[a-f0-9]{64}$/);
      RuntimeKindSchema.parse(row.kind);
      SafeNamespacedIdentifierSchema.parse(row.type);
      if (row.operation_type !== null) {
        SafeNamespacedIdentifierSchema.parse(row.operation_type);
        expect(row.operation_schema_version).toBe(1);
      } else {
        expect(row.operation_schema_version).toBeNull();
      }
      const context = TrustedCommandContextSchema.parse(row.command_context);
      expect(context).toMatchObject({
        authenticated_principal_ref: "principal://legacy/system",
        effective_actor: { type: "system", id: "legacy-migration" },
        request_origin: "internal"
      });
      expect(row.effective_actor).toEqual({ type: "system", id: "legacy-migration" });
      RuntimeSubjectSchema.parse(row.subject);
      RuntimePayloadSchema.parse(row.payload);
    }

    expect(migrated.rows.map((row) => row.kind).sort()).toEqual([
      "action_attempt",
      "action_attempt",
      "approval",
      "artifact",
      "audit_entry",
      "event",
      "work_item"
    ]);
    expect(JSON.stringify(migrated.rows.map((row) => row.payload))).not.toMatch(
      /"(actor|effective_actor|authenticated_principal_ref|on_behalf_of_principal_ref|authorization|command_context)"\s*:/
    );

    const replayRepository = new PostgresRuntimeRepository(
      pool,
      new RuntimeTypeRegistry(legacyTypeRegistrations, legacyOperationRegistrations)
    );
    await expect(
      replayRepository.rebuildProjection({
        stream_id: migrated.rows[0]!.stream_id,
        projection_type: "legacy.replay_count",
        subject: { type: "legacy.domain", id: "migrated" },
        projection_version: 1,
        input_types: [
          { kind: "event", type: "legacy.event", schema_version: 1 },
          { kind: "action_attempt", type: "legacy.worker_run", schema_version: 1 },
          { kind: "action_attempt", type: "legacy.tool.invoke", schema_version: 1 }
        ],
        initial_state: { count: 0 },
        reduce: (state) => ({ count: Number(state.count) + 1 })
      })
    ).resolves.toMatchObject({ state: { count: 3 }, last_record_sequence: 7 });
  });
});

async function rowCounts(pool: Pool, tables: readonly string[]) {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
    counts[table] = Number(result.rows[0]!.count);
  }
  return counts;
}

async function seedM1(pool: Pool): Promise<void> {
  await pool.query(`
    INSERT INTO domains (id, display_name) VALUES ('Legacy Workflow / One', 'Example Workflow');
    INSERT INTO pipelines (id, domain, display_name) VALUES ('pipeline-1', 'Legacy Workflow / One', 'Pipeline');
    INSERT INTO workers (id, domain, display_name, status) VALUES ('worker-1', 'Legacy Workflow / One', 'Worker', 'ready');
    INSERT INTO events
      (event_id, idempotency_key, event_type, source, domain, actor, subject, sensitivity, occurred_at, payload)
    VALUES
      ('00000000-0000-4000-8000-000000001001', 'migration-event-001', 'example.observation', 'fixture',
       'Legacy Workflow / One', '{"type":"user","id":"untrusted-caller"}', '{"display":"untyped legacy subject"}',
       'business', '2026-08-23T12:00:00Z', '{"statement":"observed","actor":"spoofed","authorization":{"result":"allowed"}}');
    INSERT INTO work_items
      (id, domain, status, subject_id, subject_type, source_event_id, idempotency_key, current_owner)
    VALUES
      ('00000000-0000-4000-8000-000000001002', 'Legacy Workflow / One', 'captured', 'one', 'Unnamespaced Subject',
       '00000000-0000-4000-8000-000000001001', 'migration-work-001', 'worker');
    INSERT INTO worker_runs (id, work_item_id, worker_id, status, attempt)
    VALUES ('00000000-0000-4000-8000-000000001003', '00000000-0000-4000-8000-000000001002', 'worker-1', 'succeeded', 1);
    INSERT INTO approval_requests (id, work_item_id, status, requested_by, reason, payload)
    VALUES ('00000000-0000-4000-8000-000000001004', '00000000-0000-4000-8000-000000001002', 'approved', 'fixture', 'test', '{}');
    INSERT INTO artifacts
      (artifact_id, work_item_id, type, domain, title, approval_state, content_uri, summary)
    VALUES
      ('00000000-0000-4000-8000-000000001005', '00000000-0000-4000-8000-000000001002', 'audit_note',
       'Legacy Workflow / One', 'Fixture', 'approved', 'artifact://fixture', 'Fixture artifact');
    INSERT INTO audit_log
      (audit_id, actor, action, domain, target, source_event_id, approval_id, summary, diff)
    VALUES
      ('00000000-0000-4000-8000-000000001006', 'fixture', 'event_ingested', 'Legacy Workflow / One',
       '{"type":"example.subject","id":"one"}', '00000000-0000-4000-8000-000000001001',
       '00000000-0000-4000-8000-000000001004', 'Fixture audit', '{}');
    INSERT INTO tasks (id, domain, work_item_id, status, title)
    VALUES ('00000000-0000-4000-8000-000000001007', 'Legacy Workflow / One', '00000000-0000-4000-8000-000000001002', 'open', 'Fixture task');
    INSERT INTO commitments (id, domain, work_item_id, description, source_event_id)
    VALUES ('00000000-0000-4000-8000-000000001008', 'Legacy Workflow / One', '00000000-0000-4000-8000-000000001002', 'Fixture commitment', '00000000-0000-4000-8000-000000001001');
    INSERT INTO tool_invocations (id, tool_name, domain, actor, idempotency_key, input, output, status)
    VALUES ('00000000-0000-4000-8000-000000001009', 'Example Tool / Legacy', 'Legacy Workflow / One', 'fixture', 'migration-tool-001', '{}', '{}', 'succeeded');
  `);
}
