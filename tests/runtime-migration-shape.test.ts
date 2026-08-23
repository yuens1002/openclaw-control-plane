import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration1 = readFileSync(
  new URL("../packages/db/migrations/0001_m1_foundations.sql", import.meta.url),
  "utf8"
);
const migration2 = readFileSync(
  new URL("../packages/db/migrations/0002_durable_typed_runtime.sql", import.meta.url),
  "utf8"
);
const drizzleSchema = readFileSync(
  new URL("../packages/db/src/schema.ts", import.meta.url),
  "utf8"
);

const m1Tables = [
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

const linkedRuntimeTables = [
  "events",
  "work_items",
  "worker_runs",
  "approval_requests",
  "artifacts",
  "audit_log",
  "tool_invocations"
];

function createTableBody(sql: string, table: string): string {
  const match = sql.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`, "i"));
  expect(match, `missing CREATE TABLE ${table}`).not.toBeNull();
  return match![1]!;
}

describe("M2 durable runtime migration shape", () => {
  it("preserves all M1 tables and columns through additive DDL", () => {
    for (const table of m1Tables) {
      expect(migration1).toMatch(new RegExp(`CREATE TABLE ${table} \\(`, "i"));
    }

    expect(migration2).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
    expect(migration2).not.toMatch(/\bALTER\s+TABLE[\s\S]*?\bRENAME\b/i);
    expect(migration2).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration2).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("defines the canonical append-only runtime record ledger", () => {
    const body = createTableBody(migration2, "runtime_records");
    for (const column of [
      "record_id",
      "stream_id",
      "record_sequence",
      "kind",
      "type",
      "schema_version",
      "schema_ref",
      "operation_type",
      "operation_schema_version",
      "command_context",
      "authenticated_principal_ref",
      "effective_actor",
      "subject",
      "payload",
      "occurred_at",
      "recorded_at"
    ]) {
      expect(body).toMatch(new RegExp(`\\b${column}\\b`, "i"));
    }
    expect(body).toMatch(/UNIQUE\s*\(stream_id,\s*record_sequence\)/i);
    expect(migration2).toMatch(
      /CREATE TRIGGER runtime_records_append_only\s+BEFORE UPDATE OR DELETE ON runtime_records/i
    );
    expect(migration2).not.toMatch(/\bCREATE\s+(?:TEMP\s+)?SEQUENCE\b|\bnextval\s*\(/i);
  });

  it("uses a transactional per-stream counter", () => {
    const streams = createTableBody(migration2, "record_streams");
    expect(streams).toMatch(/next_record_sequence\s+bigint/i);
    expect(migration2).toMatch(/CREATE FUNCTION allocate_runtime_record_sequence/i);
    expect(migration2).toMatch(/WHERE stream_id = requested_stream_id\s+FOR UPDATE/i);
    expect(migration2).toMatch(/SET next_record_sequence = allocated_sequence \+ 1/i);
  });

  it("adds the required generic runtime support tables", () => {
    for (const table of [
      "type_registrations",
      "operation_registrations",
      "record_streams",
      "runtime_records",
      "results",
      "record_edges",
      "idempotency_records",
      "projection_states",
      "projection_checkpoints"
    ]) {
      expect(migration2).toMatch(new RegExp(`CREATE TABLE ${table} \\(`, "i"));
    }
  });

  it("links and backfills every M1 runtime surface", () => {
    for (const table of linkedRuntimeTables) {
      expect(migration2).toMatch(
        new RegExp(`ALTER TABLE ${table}[\\s\\S]*?ADD COLUMN runtime_record_id uuid`, "i")
      );
      expect(migration2).toMatch(
        new RegExp(`UPDATE ${table} SET runtime_record_id = gen_random_uuid\\(\\)`, "i")
      );
      expect(migration2).toMatch(
        new RegExp(`${table}_runtime_record_id_fk[\\s\\S]*?REFERENCES runtime_records\\(record_id\\)`, "i")
      );
    }

    expect(migration2).toContain("principal://legacy/system");
    expect(migration2).toContain("legacy.event");
    expect(migration2).toContain("legacy.work_item");
    expect(migration2).toContain("legacy.artifact");
    expect(migration2).toContain("legacy.worker_run");
    expect(migration2).toMatch(/INSERT INTO runtime_records[\s\S]*?FROM legacy_runtime_record_stage/i);
  });

  it("anchors results, provenance, idempotency, and projections to canonical records", () => {
    const edges = createTableBody(migration2, "record_edges");
    expect(edges.match(/REFERENCES runtime_records\(record_id\)/gi)).toHaveLength(2);
    expect(edges).toMatch(/PRIMARY KEY \(from_record_id, relation, ordinal\)/i);

    const idempotency = createTableBody(migration2, "idempotency_records");
    expect(idempotency).toMatch(
      /PRIMARY KEY \(authenticated_principal_ref, operation_type, idempotency_key\)/i
    );

    expect(createTableBody(migration2, "results")).toMatch(
      /action_attempt_record_id uuid NOT NULL REFERENCES runtime_records\(record_id\)/i
    );
    expect(createTableBody(migration2, "projection_checkpoints")).toMatch(
      /last_record_sequence bigint NOT NULL/i
    );
  });

  it("keeps the Drizzle schema aligned with the M2 tables and linkage", () => {
    for (const exportName of [
      "typeRegistrations",
      "operationRegistrations",
      "recordStreams",
      "runtimeRecords",
      "results",
      "recordEdges",
      "idempotencyRecords",
      "projectionStates",
      "projectionCheckpoints",
      "toolInvocations"
    ]) {
      expect(drizzleSchema).toMatch(new RegExp(`export const ${exportName} = pgTable`));
    }
    expect(drizzleSchema.match(/runtimeRecordId: uuid\("runtime_record_id"\)/g)).toHaveLength(8);
    expect(drizzleSchema).toContain('uniqueIndex("runtime_records_stream_sequence_idx")');
  });
});
