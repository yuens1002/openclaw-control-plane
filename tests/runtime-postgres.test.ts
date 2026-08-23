import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";

import {
  IdempotencyConflictError,
  PostgresRuntimeRepository,
  RuntimeTypeRegistry,
  exampleOperationRegistrations,
  exampleTypeRegistrations,
  runSqlMigrations,
  type AppendRuntimeCommand
} from "@openclaw-control-plane/db";

const connectionString = process.env.TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

describePostgres("PostgreSQL durable runtime repository", () => {
  const databaseName = `runtime_repository_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: connectionString! });
  const databaseUrl = new URL(connectionString!);
  databaseUrl.pathname = `/${databaseName}`;
  const pool = new Pool({ connectionString: databaseUrl.toString() });
  const registry = new RuntimeTypeRegistry(
    exampleTypeRegistrations,
    exampleOperationRegistrations
  );
  const migrationsDirectory = fileURLToPath(
    new URL("../packages/db/migrations", import.meta.url)
  );

  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE ${databaseName}`);
    await runSqlMigrations(pool, migrationsDirectory);
    await new PostgresRuntimeRepository(pool, registry).synchronizeRegistry();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE
      projection_checkpoints,
      projection_states,
      record_edges,
      results,
      idempotency_records,
      runtime_records,
      record_streams
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

  it("persists a traversable graph, projection checkpoint, and replay across repository restart", async () => {
    const repository = new PostgresRuntimeRepository(pool, registry);
    const command = lifecycleCommand("graph-stream", "graph-key-001");

    const inserted = await repository.appendCommand(command);
    const replayed = await repository.appendCommand(command);
    const restartedRepository = new PostgresRuntimeRepository(pool, registry);
    const event = await restartedRepository.getRecord(ids.event);
    const attempt = await restartedRepository.getRecord(ids.attempt);
    const edges = await restartedRepository.listEdges(ids.attempt);
    const projection = await restartedRepository.getProjection(
      "graph-stream",
      "example.current_state",
      { type: "example.environment", id: "production" },
      1
    );
    const receipt = await pool.query<{
      runtime_record_id: string;
      action_attempt_record_id: string;
      result_type: string;
      outcome: string;
      payload: { changed: boolean };
    }>("SELECT * FROM results WHERE runtime_record_id = $1", [ids.result]);

    expect(inserted).toEqual({
      status: "inserted",
      terminal_status: "succeeded",
      operation_record_id: ids.attempt,
      result_record_ids: [ids.result, ids.artifact]
    });
    expect(replayed).toEqual({ ...inserted, status: "replayed" });
    expect(event?.record_sequence).toBe(1);
    expect(attempt).toMatchObject({
      operation_type: "example.state.reconcile_with_approval",
      command_context: {
        authenticated_principal_ref: "principal://service/runtime-test",
        effective_actor: { type: "service", id: "runtime-test" },
        on_behalf_of_principal_ref: "principal://user/example-owner",
        request_origin: "internal",
        authorization: { result: "allowed", policy_version: "policy-v1" }
      },
      payload: {
        work_item_id: ids.work,
        trigger: { type: "event", ref: { kind: "event", id: ids.event } },
        causation_ref: { kind: "work_item", id: ids.work },
        correlation_id: "correlation-001",
        request_id: "request-allowed-001",
        tool_invocation_id: "tool-invocation-001",
        input_refs: [
          { kind: "event", id: ids.event },
          { kind: "work_item", id: ids.work }
        ],
        result_refs: [
          { kind: "result", id: ids.result },
          { kind: "artifact", id: ids.artifact }
        ],
        command_digest: `sha256:${"a".repeat(64)}`,
        started_at: "2026-08-23T12:00:00.000Z",
        finished_at: "2026-08-23T12:00:01.000Z",
        outcome: "succeeded"
      }
    });
    expect(edges.map((edge) => edge.relation)).toEqual([
      "approved_by",
      "caused_by",
      "produced",
      "produced",
      "derived_from"
    ]);
    expect(projection).toEqual({ state: { reconciled: true }, last_record_sequence: 7 });
    expect(receipt.rows[0]).toMatchObject({
      runtime_record_id: ids.result,
      action_attempt_record_id: ids.attempt,
      result_type: "example.reconciliation.delta",
      outcome: "succeeded",
      payload: { changed: true }
    });
  });

  it("rebuilds a projection deterministically from ordered canonical records", async () => {
    const repository = new PostgresRuntimeRepository(pool, registry);
    await repository.appendCommand(lifecycleCommand("rebuild-stream", "rebuild-key-001"));
    await pool.query(
      `DELETE FROM projection_checkpoints
       WHERE projection_id IN (
         SELECT projection_id FROM projection_states WHERE stream_id = 'rebuild-stream'
       );
       DELETE FROM projection_states WHERE stream_id = 'rebuild-stream';`
    );

    const rebuild = () =>
      repository.rebuildProjection({
        stream_id: "rebuild-stream",
        projection_type: "example.record_counts",
        subject: { type: "example.environment", id: "production" },
        projection_version: 1,
        initial_state: { count: 0 },
        reduce: (state) => ({ count: Number(state.count) + 1 })
      });

    const first = await rebuild();
    const late = singleEventCommand(
      "rebuild-stream",
      "rebuild-key-002",
      "00000000-0000-4000-8000-000000000301"
    );
    await repository.appendCommand({
      ...late,
      records: [{ ...late.records[0]!, occurred_at: "2025-01-01T00:00:00.000Z" }]
    });
    const second = await rebuild();
    expect(first).toEqual({ state: { count: 7 }, last_record_sequence: 7 });
    expect(second).toEqual({ state: { count: 8 }, last_record_sequence: 8 });
  });

  it("audits an idempotency conflict without creating the changed effect", async () => {
    const repository = new PostgresRuntimeRepository(pool, registry);
    const command = lifecycleCommand("conflict-stream", "conflict-key-001");
    await repository.appendCommand(command);
    const changedDigest = `sha256:${"b".repeat(64)}`;
    const conflicting = {
      ...command,
      command_digest: changedDigest,
      records: command.records.map((record) =>
        record.kind === "action_attempt" || record.kind === "approval"
          ? { ...record, payload: { ...record.payload, command_digest: changedDigest } }
          : record
      )
    };

    await expect(repository.appendCommand(conflicting)).rejects.toBeInstanceOf(
      IdempotencyConflictError
    );

    const records = await pool.query<{ type: string }>(
      "SELECT type FROM runtime_records WHERE stream_id = 'conflict-stream' ORDER BY record_sequence"
    );
    expect(records.rows.filter((row) => row.type === "runtime.idempotency.conflict")).toHaveLength(1);
    expect(records.rows.filter((row) => row.type === "example.reconciliation.delta")).toHaveLength(1);
  });

  it("coalesces concurrent equal retries onto one durable operation", async () => {
    const command = lifecycleCommand("retry-stream", "retry-key-001");
    let releaseReservation!: () => void;
    let signalReserved!: () => void;
    const reserved = new Promise<void>((resolve) => { signalReserved = resolve; });
    const release = new Promise<void>((resolve) => { releaseReservation = resolve; });
    const firstRepository = new PostgresRuntimeRepository(pool, registry, {
      afterIdempotencyReserved: async () => {
        signalReserved();
        await release;
      }
    });
    const replayRepository = new PostgresRuntimeRepository(pool, registry);

    const firstPromise = firstRepository.appendCommand(command);
    await reserved;
    const inProgress = await replayRepository.appendCommand(command);
    expect(inProgress).toEqual({
      status: "replayed",
      terminal_status: "in_progress",
      operation_record_id: ids.attempt,
      result_record_ids: []
    });
    releaseReservation();
    const inserted = await firstPromise;
    const terminal = await replayRepository.appendCommand(command);
    expect(inserted.status).toBe("inserted");
    expect(terminal).toEqual({ ...inserted, status: "replayed" });
    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM runtime_records WHERE stream_id = 'retry-stream'"
    );
    expect(count.rows[0]!.count).toBe("7");
  });

  it("recovers an expired crash reservation as a durable failed audit", async () => {
    const repository = new PostgresRuntimeRepository(pool, registry);
    const command = singleEventCommand(
      "abandoned-stream",
      "abandoned-key-001",
      "00000000-0000-4000-8000-000000000502"
    );
    const reservedId = "00000000-0000-4000-8000-000000000501";
    await pool.query(
      `INSERT INTO idempotency_records
         (authenticated_principal_ref, operation_type, idempotency_key,
          canonicalization_version, command_digest, status,
          reserved_operation_id, claim_token, claim_expires_at)
       VALUES ($1, $2, $3, $4, $5, 'in_progress', $6,
               '00000000-0000-4000-8000-000000000599', now() - interval '1 minute')`,
      [
        command.command_context.authenticated_principal_ref,
        command.operation_type,
        command.idempotency_key,
        command.canonicalization_version,
        command.command_digest,
        reservedId
      ]
    );

    const recovered = await repository.appendCommand(command);
    const replayed = await repository.appendCommand(command);
    expect(recovered).toEqual({
      status: "replayed",
      terminal_status: "failed",
      operation_record_id: reservedId,
      result_record_ids: []
    });
    expect(replayed).toEqual(recovered);
    const records = await pool.query<{ record_id: string; type: string }>(
      "SELECT record_id, type FROM runtime_records WHERE stream_id = 'abandoned-stream'"
    );
    expect(records.rows).toEqual([
      { record_id: reservedId, type: "runtime.idempotency.abandoned" }
    ]);
  });

  it("prevents a late worker from committing after lease recovery", async () => {
    const command = lifecycleCommand("lease-race-stream", "lease-race-key-001");
    let releaseWorker!: () => void;
    let signalReserved!: () => void;
    const reserved = new Promise<void>((resolve) => { signalReserved = resolve; });
    const release = new Promise<void>((resolve) => { releaseWorker = resolve; });
    const original = new PostgresRuntimeRepository(pool, registry, {
      afterIdempotencyReserved: async () => {
        signalReserved();
        await release;
      }
    });
    const originalPromise = original.appendCommand(command);
    await reserved;
    await pool.query(
      `UPDATE idempotency_records SET claim_expires_at = now() - interval '1 minute'
       WHERE idempotency_key = 'lease-race-key-001'`
    );

    const recovery = await new PostgresRuntimeRepository(pool, registry).appendCommand(command);
    expect(recovery.terminal_status).toBe("failed");
    releaseWorker();
    await expect(originalPromise).rejects.toThrow();

    const records = await pool.query<{ type: string }>(
      "SELECT type FROM runtime_records WHERE stream_id = 'lease-race-stream'"
    );
    expect(records.rows).toEqual([{ type: "runtime.idempotency.abandoned" }]);
  });

  it("rolls back records, stream allocation, and idempotency when a related write fails", async () => {
    const repository = new PostgresRuntimeRepository(pool, registry);
    const command = lifecycleCommand("rollback-stream", "rollback-key-001");
    const failing = {
      ...command,
      records: command.records.slice(0, 1),
      edges: [
        {
          from_record_id: ids.event,
          relation: "derived_from" as const,
          to_record_id: "00000000-0000-4000-8000-000000009999",
          ordinal: 0
        }
      ]
    };

    await expect(repository.appendCommand(failing)).rejects.toThrow();

    const counts = await pool.query<{
      records: string;
      streams: string;
      idempotency: string;
    }>(`SELECT
      (SELECT count(*) FROM runtime_records WHERE stream_id = 'rollback-stream') AS records,
      (SELECT count(*) FROM record_streams WHERE stream_id = 'rollback-stream') AS streams,
      (SELECT count(*) FROM idempotency_records WHERE idempotency_key = 'rollback-key-001') AS idempotency`);
    expect(counts.rows[0]).toEqual({ records: "0", streams: "0", idempotency: "0" });
  });

  it("serializes concurrent appends through the same stream counter", async () => {
    const repository = new PostgresRuntimeRepository(pool, registry);
    const first = singleEventCommand(
      "ordered-stream",
      "ordered-key-001",
      "00000000-0000-4000-8000-000000000201"
    );
    const second = singleEventCommand(
      "ordered-stream",
      "ordered-key-002",
      "00000000-0000-4000-8000-000000000202"
    );

    await Promise.all([repository.appendCommand(first), repository.appendCommand(second)]);

    const records = await pool.query<{ record_sequence: string }>(
      "SELECT record_sequence FROM runtime_records WHERE stream_id = 'ordered-stream' ORDER BY record_sequence"
    );
    expect(records.rows.map((row) => Number(row.record_sequence))).toEqual([1, 2]);
  });

  it("records a denied authorization as audit only", async () => {
    const repository = new PostgresRuntimeRepository(pool, registry);
    const result = await repository.recordAuthorizationDecision({
      stream_id: "denial-stream",
      operation_type: "example.state.reconcile",
      target: { type: "example.environment", id: "production" },
      request_id: "request-denied-001",
      command_context: trustedContext("denied")
    });

    const records = await pool.query<{ kind: string; type: string }>(
      "SELECT kind, type FROM runtime_records WHERE stream_id = 'denial-stream'"
    );
    expect(result.result_record_ids).toEqual([]);
    expect(records.rows).toEqual([
      { kind: "audit_entry", type: "runtime.authorization.denied" }
    ]);
  });

  it("content-binds denial audit idempotency and audits changed evidence", async () => {
    const repository = new PostgresRuntimeRepository(pool, registry);
    const input = {
      stream_id: "denial-conflict-stream",
      operation_type: "example.state.reconcile",
      target: { type: "example.environment", id: "production" },
      request_id: "request-denied-001",
      command_context: trustedContext("denied")
    } as const;
    await repository.recordAuthorizationDecision(input);
    await expect(
      repository.recordAuthorizationDecision({
        ...input,
        request_id: "request-denied-002"
      })
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const records = await pool.query<{ type: string }>(
      "SELECT type FROM runtime_records WHERE stream_id = 'denial-conflict-stream' ORDER BY record_sequence"
    );
    expect(records.rows.map((row) => row.type)).toEqual([
      "runtime.authorization.denied",
      "runtime.idempotency.conflict"
    ]);
  });

  it("rejects malformed built-in records and non-action result producers", async () => {
    const repository = new PostgresRuntimeRepository(pool, registry);
    const malformed = lifecycleCommand("malformed-stream", "malformed-key-001");
    const malformedAction = {
      ...malformed,
      records: malformed.records.map((record) =>
        record.record_id === ids.attempt
          ? { ...record, payload: { outcome: "succeeded" } }
          : record
      )
    };
    await expect(repository.appendCommand(malformedAction)).rejects.toThrow();

    await expect(
      repository.appendCommand({
        ...lifecycleCommand("wrong-auth-stream", "wrong-auth-key-001"),
        command_context: {
          ...trustedContext("allowed"),
          authorization: {
            ...trustedContext("allowed").authorization,
            action: "runtime.unrelated_action"
          }
        }
      })
    ).rejects.toThrow(/authorization action/i);

    const wrongApproval = lifecycleCommand("wrong-approval-stream", "wrong-approval-key-001");
    wrongApproval.records = wrongApproval.records.map((record) =>
      record.kind === "approval"
        ? {
            ...record,
            payload: {
              ...record.payload,
              approver_authorization: {
                decision_id: "approval-decision-001",
                action: "runtime.unrelated_action",
                result: "allowed",
                policy_version: "policy-v1",
                reason_codes: []
              }
            }
          }
        : record
    );
    await expect(repository.appendCommand(wrongApproval)).rejects.toThrow(/approval record/i);

    const invalidProducer = singleEventCommand(
      "producer-stream",
      "producer-key-001",
      "00000000-0000-4000-8000-000000000401"
    );
    invalidProducer.records = [
      ...invalidProducer.records,
      record(
        "00000000-0000-4000-8000-000000000402",
        "result",
        "example.reconciliation.delta",
        "example://schemas/reconciliation-delta/v1",
        { changed: true }
      )
    ];
    invalidProducer.edges = [{
      from_record_id: invalidProducer.records[0]!.record_id,
      relation: "produced",
      to_record_id: invalidProducer.records[1]!.record_id,
      ordinal: 0
    }];
    await expect(repository.appendCommand(invalidProducer)).rejects.toThrow(/action attempt/i);
  });

  it("persists retirement while preserving historical replay and failing missing-schema replay", async () => {
    const repository = new PostgresRuntimeRepository(pool, registry);
    await repository.appendCommand(lifecycleCommand("retirement-stream", "retirement-key-001"));

    const retiredRegistry = new RuntimeTypeRegistry(
      exampleTypeRegistrations,
      exampleOperationRegistrations
    );
    retiredRegistry.retireType("event", "example.observation", 1);
    retiredRegistry.retireOperation("example.state.reconcile_with_approval", 1);
    const retiredRepository = new PostgresRuntimeRepository(pool, retiredRegistry);
    await retiredRepository.synchronizeRegistry();
    const statuses = await pool.query<{ type_status: string; operation_status: string }>(`
      SELECT
        (SELECT status FROM type_registrations
         WHERE kind = 'event' AND type = 'example.observation' AND schema_version = 1) AS type_status,
        (SELECT status FROM operation_registrations
         WHERE operation_type = 'example.state.reconcile_with_approval' AND command_schema_version = 1) AS operation_status
    `);
    expect(statuses.rows[0]).toEqual({ type_status: "retired", operation_status: "retired" });
    await expect(
      retiredRepository.rebuildProjection({
        stream_id: "retirement-stream",
        projection_type: "example.retired_replay",
        subject: { type: "example.environment", id: "production" },
        projection_version: 1,
        initial_state: { count: 0 },
        reduce: (state) => ({ count: Number(state.count) + 1 })
      })
    ).resolves.toMatchObject({ last_record_sequence: 7 });
    await expect(
      retiredRepository.appendCommand(
        singleEventCommand(
          "retirement-stream",
          "retirement-key-002",
          "00000000-0000-4000-8000-000000000403"
        )
      )
    ).rejects.toThrow(/retired/i);

    const missingRegistry = new RuntimeTypeRegistry(
      exampleTypeRegistrations.filter((item) => item.type !== "example.observation"),
      exampleOperationRegistrations
    );
    await expect(
      new PostgresRuntimeRepository(pool, missingRegistry).rebuildProjection({
        stream_id: "retirement-stream",
        projection_type: "example.missing_schema",
        subject: { type: "example.environment", id: "production" },
        projection_version: 1,
        initial_state: {},
        reduce: (state) => state
      })
    ).rejects.toThrow(/missing during replay/i);

    await repository.synchronizeRegistry();
  });

  it("reports database, migration, and registry readiness independently", async () => {
    const readiness = await new PostgresRuntimeRepository(pool, registry).readiness();
    expect(readiness).toEqual({ database: "ready", migrations: "ready", registry: "ready" });
  });
});

const ids = {
  event: "00000000-0000-4000-8000-000000000101",
  work: "00000000-0000-4000-8000-000000000102",
  attempt: "00000000-0000-4000-8000-000000000103",
  approval: "00000000-0000-4000-8000-000000000104",
  result: "00000000-0000-4000-8000-000000000105",
  artifact: "00000000-0000-4000-8000-000000000106",
  audit: "00000000-0000-4000-8000-000000000107"
} as const;

function lifecycleCommand(streamId: string, idempotencyKey: string): AppendRuntimeCommand {
  return {
    stream_id: streamId,
    operation_type: "example.state.reconcile_with_approval",
    operation_schema_version: 1,
    idempotency_key: idempotencyKey,
    canonicalization_version: "jcs-rfc8785-v1",
    command_digest: `sha256:${"a".repeat(64)}`,
    command_arguments: { desired: { ready: true } },
    command_context: trustedContext("allowed"),
    records: [
      record(ids.event, "event", "example.observation", "example://schemas/observation/v1", {
        statement: "A state change was requested."
      }),
      record(ids.work, "work_item", "example.state.reconcile", "example://schemas/state-reconcile/v1", {
        requested_state: { ready: true }
      }),
      record(
        ids.attempt,
        "action_attempt",
        "runtime.action.attempt",
        "runtime://schemas/action-attribution/v1",
        {
          work_item_id: ids.work,
          operation_type: "example.state.reconcile_with_approval",
          handler_id: "example-reconcile-handler",
          handler_version: 1,
          subject: { type: "example.environment", id: "production" },
          trigger: { type: "event", ref: { kind: "event", id: ids.event } },
          causation_ref: { kind: "work_item", id: ids.work },
          correlation_id: "correlation-001",
          request_id: "request-allowed-001",
          tool_invocation_id: "tool-invocation-001",
          input_refs: [
            { kind: "event", id: ids.event },
            { kind: "work_item", id: ids.work }
          ],
          result_refs: [
            { kind: "result", id: ids.result },
            { kind: "artifact", id: ids.artifact }
          ],
          canonicalization_version: "jcs-rfc8785-v1",
          command_digest: `sha256:${"a".repeat(64)}`,
          started_at: "2026-08-23T12:00:00.000Z",
          finished_at: "2026-08-23T12:00:01.000Z",
          outcome: "succeeded"
        }
      ),
      record(
        ids.approval,
        "approval",
        "runtime.command.approval",
        "runtime://schemas/command-approval/v1",
        {
          work_item_id: ids.work,
          operation_type: "example.state.reconcile_with_approval",
          action_revision: 1,
          command_digest: `sha256:${"a".repeat(64)}`,
          approved_by_principal_ref: "principal://user/example-owner",
          effective_approver: { type: "user", id: "example-owner" },
          approver_authorization: {
            decision_id: "approval-decision-001",
            action: "runtime.command.approve",
            result: "allowed",
            policy_version: "policy-v1",
            reason_codes: ["example.approval_allowed"]
          },
          decision: "approved",
          decided_at: "2026-08-23T11:59:00.000Z"
        }
      ),
      record(ids.result, "result", "example.reconciliation.delta", "example://schemas/reconciliation-delta/v1", {
        changed: true
      }),
      record(ids.artifact, "artifact", "example.report", "example://schemas/report/v1", {
        content_ref: "artifact://example/report-001"
      }),
      record(ids.audit, "audit_entry", "runtime.operation.audit", "runtime://schemas/audit-entry/v1", {
        outcome: "succeeded"
      })
    ],
    edges: [
      { from_record_id: ids.work, relation: "derived_from", to_record_id: ids.event, ordinal: 0 },
      { from_record_id: ids.attempt, relation: "caused_by", to_record_id: ids.work, ordinal: 0 },
      { from_record_id: ids.attempt, relation: "approved_by", to_record_id: ids.approval, ordinal: 0 },
      { from_record_id: ids.attempt, relation: "produced", to_record_id: ids.result, ordinal: 0 },
      { from_record_id: ids.attempt, relation: "produced", to_record_id: ids.artifact, ordinal: 1 },
      { from_record_id: ids.audit, relation: "derived_from", to_record_id: ids.attempt, ordinal: 0 }
    ],
    projection_updates: [
      {
        projection_type: "example.current_state",
        subject: { type: "example.environment", id: "production" },
        projection_version: 1,
        state: { reconciled: true }
      }
    ]
  };
}

function singleEventCommand(
  streamId: string,
  idempotencyKey: string,
  recordId: string
): AppendRuntimeCommand {
  return {
    ...lifecycleCommand(streamId, idempotencyKey),
    operation_type: "example.state.reconcile",
    records: [
      {
        ...record(recordId, "event", "example.observation", "example://schemas/observation/v1", {
          statement: idempotencyKey
        }),
        operation_type: "example.state.reconcile"
      }
    ],
    edges: [],
    projection_updates: []
  };
}

function record(
  recordId: string,
  kind: AppendRuntimeCommand["records"][number]["kind"],
  type: string,
  schemaRef: string,
  payload: AppendRuntimeCommand["records"][number]["payload"]
) {
  return {
    record_id: recordId,
    kind,
    type,
    schema_version: 1,
    schema_ref: schemaRef,
    subject: { type: "example.environment", id: "production" },
    payload,
    occurred_at: "2026-08-23T12:00:00.000Z",
    operation_type: "example.state.reconcile_with_approval"
  } as const;
}

function trustedContext(result: "allowed" | "denied") {
  return {
    authenticated_principal_ref: "principal://service/runtime-test",
    effective_actor: { type: "service" as const, id: "runtime-test" },
    on_behalf_of_principal_ref: "principal://user/example-owner",
    request_origin: "internal" as const,
    authorization: {
      decision_id: result === "allowed" ? "decision-allowed-001" : "decision-denied-001",
      action: "state.reconcile",
      result,
      policy_version: "policy-v1",
      reason_codes: [result === "allowed" ? "example.policy.allowed" : "example.policy.denied"]
    }
  };
}
