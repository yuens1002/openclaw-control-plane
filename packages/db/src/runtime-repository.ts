import { randomUUID } from "node:crypto";

import {
  ActionAttributionPayloadSchema,
  ApprovalAttributionPayloadSchema,
  AuthorizationDenialAuditPayloadSchema,
  CanonicalCommandEnvelopeSchema,
  CommandDigestSchema,
  IdempotencyAbandonedAuditPayloadSchema,
  IdempotencyConflictAuditPayloadSchema,
  OperationAuditPayloadSchema,
  RuntimeKindSchema,
  RuntimePayloadSchema,
  RuntimeSubjectSchema,
  SafeNamespacedIdentifierSchema,
  TrustedCommandContextSchema,
  type CanonicalCommandEnvelope,
  type RuntimeKind,
  type RuntimePayload,
  type RuntimeSubject,
  type TrustedCommandContext
} from "@openclaw-control-plane/contracts";
import type { Pool, PoolClient } from "pg";

import { commandDigest, compareIdempotencyCommand, jsonDigest } from "./canonical-command.js";
import {
  RuntimeTypeRegistry,
  type RegisteredRuntimeKind
} from "./runtime-registry.js";

export type RuntimeTerminalStatus = "succeeded" | "failed";
export type RuntimeOperationStatus = "in_progress" | RuntimeTerminalStatus;

export interface RuntimeRecordDraft {
  record_id: string;
  kind: RuntimeKind;
  type: string;
  schema_version: number;
  schema_ref: string;
  subject: RuntimeSubject;
  payload: RuntimePayload;
  occurred_at: string;
  operation_type?: string;
  operation_schema_version?: number;
}

export interface RuntimeRecord extends RuntimeRecordDraft {
  stream_id: string;
  record_sequence: number;
  command_context: TrustedCommandContext;
  recorded_at: string;
}

export interface RuntimeEdgeDraft {
  from_record_id: string;
  relation:
    | "caused_by"
    | "derived_from"
    | "attempted_by"
    | "produced"
    | "approved_by"
    | "supersedes";
  to_record_id: string;
  ordinal: number;
}

export interface RuntimeProjectionUpdate {
  projection_type: string;
  subject: RuntimeSubject;
  projection_version: number;
  state: RuntimePayload;
}

export interface RuntimeProjectionRebuild {
  stream_id: string;
  projection_type: string;
  subject: RuntimeSubject;
  projection_version: number;
  input_types: readonly RuntimeProjectionInputType[];
  initial_state: RuntimePayload;
  reduce: (state: RuntimePayload, record: RuntimeRecord) => RuntimePayload;
}

export interface RuntimeProjectionInputType {
  kind: RuntimeKind;
  type: string;
  schema_version: number;
}

export type RuntimeProjectionAdvance = Omit<RuntimeProjectionRebuild, "initial_state">;

export interface AppendRuntimeCommand {
  stream_id: string;
  operation_type: string;
  operation_schema_version: number;
  idempotency_key: string;
  canonicalization_version: string;
  command_digest: string;
  command_arguments: RuntimePayload;
  canonical_command: CanonicalCommandEnvelope;
  command_context: TrustedCommandContext;
  approval_context?: TrustedCommandContext;
  records: readonly RuntimeRecordDraft[];
  edges?: readonly RuntimeEdgeDraft[];
  projection_updates?: readonly RuntimeProjectionUpdate[];
  terminal_status?: RuntimeTerminalStatus;
}

export interface RuntimeOperationResult {
  status: "inserted" | "replayed";
  terminal_status: RuntimeOperationStatus;
  operation_record_id: string;
  result_record_ids: string[];
}

export interface AuthorizationDenialInput {
  stream_id: string;
  operation_type: string;
  operation_schema_version: number;
  target: RuntimeSubject;
  request_id: string;
  command_context: TrustedCommandContext;
}

export interface RuntimeReadiness {
  database: "ready" | "unavailable";
  migrations: "ready" | "missing";
  registry: "ready" | "invalid";
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key was reused with different canonical command content.");
    this.name = "IdempotencyConflictError";
  }
}

export class PostgresRuntimeRepository {
  constructor(
    private readonly pool: Pool,
    private readonly registry: RuntimeTypeRegistry,
    private readonly hooks: { afterIdempotencyReserved?: () => Promise<void> } = {}
  ) {}

  async synchronizeRegistry(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const registration of this.registry.listTypes()) {
        const result = await client.query<{ schema_digest: string; schema_ref: string }>(
          `INSERT INTO type_registrations
             (kind, type, schema_version, schema_ref, schema_digest, payload_schema, status, owner)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
           ON CONFLICT (kind, type, schema_version) DO NOTHING
           RETURNING schema_digest, schema_ref`,
          [
            registration.kind,
            registration.type,
            registration.schema_version,
            registration.schema_ref,
            registration.schema_digest,
            JSON.stringify(registration.payload_schema),
            registration.status,
            registration.owner
          ]
        );
        if (result.rowCount === 0) {
          const existing = await client.query<{
            schema_digest: string;
            schema_ref: string;
            owner: string;
          }>(
            `SELECT schema_digest, schema_ref, owner FROM type_registrations
             WHERE kind = $1 AND type = $2 AND schema_version = $3`,
            [registration.kind, registration.type, registration.schema_version]
          );
          if (
            existing.rows[0]?.schema_digest !== registration.schema_digest ||
            existing.rows[0]?.schema_ref !== registration.schema_ref ||
            existing.rows[0]?.owner !== registration.owner
          ) {
            throw new Error(
              `Persisted type registration ${registration.kind}:${registration.type}:${registration.schema_version} conflicts with startup registry.`
            );
          }
          await client.query(
            `UPDATE type_registrations
             SET status = $4,
                 retired_at = CASE WHEN $4 = 'retired' THEN COALESCE(retired_at, now()) ELSE NULL END
             WHERE kind = $1 AND type = $2 AND schema_version = $3`,
            [
              registration.kind,
              registration.type,
              registration.schema_version,
              registration.status
            ]
          );
        }
      }

      for (const registration of this.registry.listOperations()) {
        const result = await client.query<{ command_schema_digest: string; command_schema_ref: string }>(
          `INSERT INTO operation_registrations
             (operation_type, command_schema_version, command_schema_ref,
              command_schema_digest, command_schema, allowed_result_types,
              handler_id, handler_version, authorization_action, approval_required, status)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (operation_type, command_schema_version) DO NOTHING
           RETURNING command_schema_digest, command_schema_ref`,
          [
            registration.operation_type,
            registration.command_schema_version,
            registration.command_schema_ref,
            registration.command_schema_digest,
            JSON.stringify(registration.command_schema),
            [...registration.allowed_result_types],
            registration.handler_id,
            registration.handler_version,
            registration.authorization_action,
            registration.approval_required,
            registration.status
          ]
        );
        if (result.rowCount === 0) {
          const existing = await client.query<{
            command_schema_digest: string;
            command_schema_ref: string;
            allowed_result_types: string[];
            handler_id: string;
            handler_version: number;
            authorization_action: string;
            approval_required: boolean;
          }>(
            `SELECT command_schema_digest, command_schema_ref, allowed_result_types,
                    handler_id, handler_version, authorization_action
                    , approval_required
             FROM operation_registrations
             WHERE operation_type = $1 AND command_schema_version = $2`,
            [registration.operation_type, registration.command_schema_version]
          );
          if (
            existing.rows[0]?.command_schema_digest !== registration.command_schema_digest ||
            existing.rows[0]?.command_schema_ref !== registration.command_schema_ref ||
            existing.rows[0]?.handler_id !== registration.handler_id ||
            existing.rows[0]?.handler_version !== registration.handler_version ||
            existing.rows[0]?.authorization_action !== registration.authorization_action ||
            existing.rows[0]?.approval_required !== registration.approval_required ||
            JSON.stringify(existing.rows[0]?.allowed_result_types) !==
              JSON.stringify(registration.allowed_result_types)
          ) {
            throw new Error(
              `Persisted operation registration ${registration.operation_type}:${registration.command_schema_version} conflicts with startup registry.`
            );
          }
          await client.query(
            `UPDATE operation_registrations
             SET status = $3,
                 retired_at = CASE WHEN $3 = 'retired' THEN COALESCE(retired_at, now()) ELSE NULL END
             WHERE operation_type = $1 AND command_schema_version = $2`,
            [
              registration.operation_type,
              registration.command_schema_version,
              registration.status
            ]
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async appendCommand(command: AppendRuntimeCommand): Promise<RuntimeOperationResult> {
    validateAppendCommand(command, this.registry);
    if (command.command_context.authorization.result !== "allowed") {
      throw new Error("Denied command context may only use recordAuthorizationDecision.");
    }

    const reservedOperationId =
      command.records.find((record) => record.kind === "action_attempt")?.record_id ??
      command.records[0]!.record_id;
    const claimed = await reserveIdempotency(this.pool, command, reservedOperationId);
    if (claimed.kind === "replay") return claimed.result;
    if (claimed.kind === "expired") {
      return this.recoverExpiredReservation(
        command,
        claimed.reservedOperationId,
        claimed.claimToken
      );
    }
    if (claimed.kind === "conflict") {
      await this.appendConflictAuditTransaction(command);
      throw new IdempotencyConflictError();
    }
    try {
      await this.hooks.afterIdempotencyReserved?.();
    } catch (error) {
      await releaseIdempotencyReservation(
        this.pool,
        command,
        reservedOperationId,
        claimed.claimToken
      );
      throw error;
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await appendRecords(client, command.stream_id, command.command_context, command.records);
      await appendResultReceipts(
        client,
        inserted,
        command.edges ?? [],
        command.terminal_status ?? "succeeded"
      );
      await appendEdges(client, command.edges ?? []);
      await updateProjections(
        client,
        command.stream_id,
        command.projection_updates ?? [],
        inserted.at(-1)
      );

      const operationRecordId =
        inserted.find((record) => record.kind === "action_attempt")?.record_id ??
        inserted[0]!.record_id;
      const resultRecordIds = inserted
        .filter((record) => record.kind === "result" || record.kind === "artifact")
        .map((record) => record.record_id);
      const terminalStatus = command.terminal_status ?? "succeeded";
      const finalized = await client.query(
        `UPDATE idempotency_records
         SET status = $4, operation_record_id = $5, result_record_ids = $6, updated_at = now()
         WHERE authenticated_principal_ref = $1 AND operation_type = $2 AND idempotency_key = $3
           AND reserved_operation_id = $5 AND claim_token = $7
           AND status = 'in_progress'`,
        [
          command.command_context.authenticated_principal_ref,
          command.operation_type,
          command.idempotency_key,
          terminalStatus,
          operationRecordId,
          resultRecordIds,
          claimed.claimToken
        ]
      );
      if (finalized.rowCount !== 1) {
        throw new Error("Idempotency reservation expired before the operation committed.");
      }
      await client.query("COMMIT");
      return {
        status: "inserted",
        terminal_status: terminalStatus,
        operation_record_id: operationRecordId,
        result_record_ids: resultRecordIds
      };
    } catch (error) {
      await client.query("ROLLBACK");
      await releaseIdempotencyReservation(
        this.pool,
        command,
        reservedOperationId,
        claimed.claimToken
      );
      throw error;
    } finally {
      client.release();
    }
  }

  async recordAuthorizationDecision(input: AuthorizationDenialInput): Promise<RuntimeOperationResult> {
    const context = TrustedCommandContextSchema.parse(input.command_context);
    if (context.authorization.result !== "denied") {
      throw new Error("recordAuthorizationDecision only accepts denied decisions.");
    }
    const operation = this.registry.requireOperation(
      input.operation_type,
      input.operation_schema_version
    );
    if (context.authorization.action !== operation.authorization_action) {
      throw new Error("Denied authorization action does not match the registered operation action.");
    }
    const auditId = randomUUID();
    const canonicalCommand = CanonicalCommandEnvelopeSchema.parse({
      canonicalization_version: "jcs-rfc8785-v1",
      operation_type: input.operation_type,
      operation_schema_version: input.operation_schema_version,
      work_item_id: auditId,
      action_revision: 1,
      target: input.target,
      arguments: {
        request_id: input.request_id,
        authorization_evidence: context.authorization
      },
      declared_effects: []
    });
    return this.appendDeniedAudit({
      stream_id: input.stream_id,
      operation_type: input.operation_type,
      operation_schema_version: input.operation_schema_version,
      idempotency_key: `authorization:${context.authorization.decision_id}`,
      canonicalization_version: canonicalCommand.canonicalization_version,
      command_digest: commandDigest(canonicalCommand),
      command_arguments: canonicalCommand.arguments,
      canonical_command: canonicalCommand,
      command_context: context,
      records: [
        {
          record_id: auditId,
          kind: "audit_entry",
          type: "runtime.authorization.denied",
          schema_version: 1,
          schema_ref: "runtime://schemas/authorization-denied/v1",
          operation_type: input.operation_type,
          operation_schema_version: input.operation_schema_version,
          subject: input.target,
          payload: {
            request_id: input.request_id,
            decision_id: context.authorization.decision_id,
            policy_version: context.authorization.policy_version,
            reason_codes: context.authorization.reason_codes
          },
          occurred_at: new Date().toISOString()
        }
      ]
    });
  }

  async getRecord(recordId: string): Promise<RuntimeRecord | null> {
    const result = await this.pool.query<RuntimeRecordRow>(
      `SELECT record_id, stream_id, record_sequence, kind, type, schema_version,
              schema_ref, operation_type, operation_schema_version, command_context, subject, payload,
              occurred_at, recorded_at
       FROM runtime_records WHERE record_id = $1`,
      [recordId]
    );
    return result.rows[0] ? mapRuntimeRecord(result.rows[0]) : null;
  }

  async listStreamRecords(streamId: string): Promise<RuntimeRecord[]> {
    const result = await this.pool.query<RuntimeRecordRow>(
      `SELECT record_id, stream_id, record_sequence, kind, type, schema_version,
              schema_ref, operation_type, operation_schema_version, command_context, subject, payload,
              occurred_at, recorded_at
       FROM runtime_records
       WHERE stream_id = $1
       ORDER BY record_sequence`,
      [streamId]
    );
    return result.rows.map(mapRuntimeRecord);
  }

  async listEdges(recordId: string): Promise<RuntimeEdgeDraft[]> {
    const result = await this.pool.query<{
      from_record_id: string;
      relation: RuntimeEdgeDraft["relation"];
      to_record_id: string;
      ordinal: number;
    }>(
      `SELECT from_record_id, relation, to_record_id, ordinal
       FROM record_edges
       WHERE from_record_id = $1 OR to_record_id = $1
       ORDER BY from_record_id, relation, ordinal`,
      [recordId]
    );
    return result.rows;
  }

  async getProjection(
    streamId: string,
    projectionType: string,
    subject: RuntimeSubject,
    projectionVersion: number
  ): Promise<{ state: RuntimePayload; last_record_sequence: number } | null> {
    const result = await this.pool.query<{ state: RuntimePayload; last_record_sequence: string }>(
      `SELECT p.state, c.last_record_sequence
       FROM projection_states p
       JOIN projection_checkpoints c ON c.projection_id = p.projection_id
       WHERE p.stream_id = $1 AND p.projection_type = $2 AND p.subject_type = $3
         AND p.subject_id = $4 AND p.projection_version = $5`,
      [streamId, projectionType, subject.type, subject.id, projectionVersion]
    );
    return result.rows[0]
      ? {
          state: result.rows[0].state,
          last_record_sequence: Number(result.rows[0].last_record_sequence)
        }
      : null;
  }

  async rebuildProjection(input: RuntimeProjectionRebuild): Promise<{
    state: RuntimePayload;
    last_record_sequence: number;
  }> {
    RuntimeSubjectSchema.parse(input.subject);
    RuntimePayloadSchema.parse(input.initial_state);
    validateProjectionInputTypes(input.input_types);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<RuntimeRecordRow>(
        `SELECT record_id, stream_id, record_sequence, kind, type, schema_version,
                schema_ref, operation_type, operation_schema_version, command_context, subject, payload,
                occurred_at, recorded_at
         FROM runtime_records
         WHERE stream_id = $1
         ORDER BY record_sequence
         FOR UPDATE`,
        [input.stream_id]
      );
      const records = result.rows.map(mapRuntimeRecord);
      const consumedRecords = records.filter((record) =>
        projectionConsumes(record, input.input_types)
      );
      for (const record of consumedRecords) {
        validateHistoricalRecord(record, this.registry);
      }
      const state = consumedRecords.reduce(input.reduce, input.initial_state);
      RuntimePayloadSchema.parse(state);
      const lastRecord = records.at(-1);

      const projection = await client.query<{ projection_id: string }>(
        `INSERT INTO projection_states
           (stream_id, projection_type, subject_type, subject_id, projection_version, state)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (stream_id, projection_type, subject_type, subject_id, projection_version)
         DO UPDATE SET state = EXCLUDED.state, updated_at = now()
         RETURNING projection_id`,
        [
          input.stream_id,
          input.projection_type,
          input.subject.type,
          input.subject.id,
          input.projection_version,
          JSON.stringify(state)
        ]
      );
      await client.query(
        `INSERT INTO projection_checkpoints
           (projection_id, last_record_sequence, last_record_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (projection_id) DO UPDATE
         SET last_record_sequence = EXCLUDED.last_record_sequence,
             last_record_id = EXCLUDED.last_record_id,
             updated_at = now()`,
        [
          projection.rows[0]!.projection_id,
          lastRecord?.record_sequence ?? 0,
          lastRecord?.record_id ?? null
        ]
      );
      await client.query("COMMIT");
      return { state, last_record_sequence: lastRecord?.record_sequence ?? 0 };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async advanceProjection(input: RuntimeProjectionAdvance): Promise<{
    state: RuntimePayload;
    last_record_sequence: number;
  }> {
    RuntimeSubjectSchema.parse(input.subject);
    validateProjectionInputTypes(input.input_types);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const projection = await client.query<{
        projection_id: string;
        state: RuntimePayload;
        last_record_sequence: string;
      }>(
        `SELECT p.projection_id, p.state, c.last_record_sequence
         FROM projection_states p
         JOIN projection_checkpoints c ON c.projection_id = p.projection_id
         WHERE p.stream_id = $1 AND p.projection_type = $2
           AND p.subject_type = $3 AND p.subject_id = $4
           AND p.projection_version = $5
         FOR UPDATE`,
        [
          input.stream_id,
          input.projection_type,
          input.subject.type,
          input.subject.id,
          input.projection_version
        ]
      );
      const current = projection.rows[0];
      if (!current) throw new Error("Projection must be rebuilt before it can advance.");
      RuntimePayloadSchema.parse(current.state);
      const recordsResult = await client.query<RuntimeRecordRow>(
        `SELECT record_id, stream_id, record_sequence, kind, type, schema_version,
                schema_ref, operation_type, operation_schema_version, command_context, subject, payload,
                occurred_at, recorded_at
         FROM runtime_records
         WHERE stream_id = $1 AND record_sequence > $2
         ORDER BY record_sequence
         FOR UPDATE`,
        [input.stream_id, current.last_record_sequence]
      );
      const records = recordsResult.rows.map(mapRuntimeRecord);
      const consumedRecords = records.filter((record) =>
        projectionConsumes(record, input.input_types)
      );
      for (const record of consumedRecords) validateHistoricalRecord(record, this.registry);
      const state = consumedRecords.reduce(input.reduce, current.state);
      RuntimePayloadSchema.parse(state);
      const lastRecord = records.at(-1);
      const lastRecordSequence = lastRecord?.record_sequence ??
        Number(current.last_record_sequence);
      await client.query(
        "UPDATE projection_states SET state = $2::jsonb, updated_at = now() WHERE projection_id = $1",
        [current.projection_id, JSON.stringify(state)]
      );
      if (lastRecord) {
        await client.query(
          `UPDATE projection_checkpoints
           SET last_record_sequence = $2, last_record_id = $3, updated_at = now()
           WHERE projection_id = $1`,
          [current.projection_id, lastRecord.record_sequence, lastRecord.record_id]
        );
      }
      await client.query("COMMIT");
      return { state, last_record_sequence: lastRecordSequence };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async readiness(): Promise<RuntimeReadiness> {
    try {
      const result = await this.pool.query<{ migrations_table: boolean; registry_table: boolean }>(
        `SELECT
           to_regclass('public.control_plane_migrations') IS NOT NULL AS migrations_table,
           to_regclass('public.type_registrations') IS NOT NULL AS registry_table`
      );
      const tables = result.rows[0];
      if (!tables?.migrations_table || !tables.registry_table) {
        return {
          database: "ready",
          migrations: tables?.migrations_table ? "ready" : "missing",
          registry: tables?.registry_table ? "ready" : "invalid"
        };
      }
      const migration = await this.pool.query<{ applied: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM control_plane_migrations
           WHERE name = '0002_durable_typed_runtime.sql'
         ) AS applied`
      );
      const registryReady = await this.persistedRegistryMatches();
      return {
        database: "ready",
        migrations: migration.rows[0]?.applied ? "ready" : "missing",
        registry: registryReady ? "ready" : "invalid"
      };
    } catch {
      return { database: "unavailable", migrations: "missing", registry: "invalid" };
    }
  }

  private async persistedRegistryMatches(): Promise<boolean> {
    const types = await this.pool.query<{
      kind: RegisteredRuntimeKind;
      type: string;
      schema_version: number;
      schema_ref: string;
      schema_digest: string;
      owner: string;
      status: string;
    }>(
      `SELECT kind, type, schema_version, schema_ref, schema_digest, owner, status
       FROM type_registrations`
    );
    const operations = await this.pool.query<{
      operation_type: string;
      command_schema_version: number;
      command_schema_ref: string;
      command_schema_digest: string;
      allowed_result_types: string[];
      handler_id: string;
      handler_version: number;
      authorization_action: string;
      approval_required: boolean;
      status: string;
    }>(
      `SELECT operation_type, command_schema_version, command_schema_ref,
              command_schema_digest, allowed_result_types, handler_id,
              handler_version, authorization_action, approval_required, status
       FROM operation_registrations`
    );
    const typeRows = new Map(
      types.rows.map((row) => [`${row.kind}:${row.type}:${row.schema_version}`, row])
    );
    const operationRows = new Map(
      operations.rows.map((row) => [
        `${row.operation_type}:${row.command_schema_version}`,
        row
      ])
    );
    return (
      this.registry.listTypes().every((registration) => {
        const row = typeRows.get(
          `${registration.kind}:${registration.type}:${registration.schema_version}`
        );
        return (
          row?.schema_ref === registration.schema_ref &&
          row.schema_digest === registration.schema_digest &&
          row.owner === registration.owner &&
          row.status === registration.status
        );
      }) &&
      this.registry.listOperations().every((registration) => {
        const row = operationRows.get(
          `${registration.operation_type}:${registration.command_schema_version}`
        );
        return (
          row?.command_schema_ref === registration.command_schema_ref &&
          row.command_schema_digest === registration.command_schema_digest &&
          row.handler_id === registration.handler_id &&
          row.handler_version === registration.handler_version &&
          row.authorization_action === registration.authorization_action &&
          row.approval_required === registration.approval_required &&
          JSON.stringify(row.allowed_result_types) ===
            JSON.stringify(registration.allowed_result_types) &&
          row.status === registration.status
        );
      })
    );
  }

  private async appendDeniedAudit(command: AppendRuntimeCommand): Promise<RuntimeOperationResult> {
    const reservedOperationId = command.records[0]!.record_id;
    const claimed = await reserveIdempotency(this.pool, command, reservedOperationId);
    if (claimed.kind === "replay") return claimed.result;
    if (claimed.kind === "expired") {
      return this.recoverExpiredReservation(
        command,
        claimed.reservedOperationId,
        claimed.claimToken
      );
    }
    if (claimed.kind === "conflict") {
      await this.appendConflictAuditTransaction(command);
      throw new IdempotencyConflictError();
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await appendRecords(
        client,
        command.stream_id,
        command.command_context,
        command.records
      );
      const finalized = await client.query(
        `UPDATE idempotency_records
         SET status = 'succeeded', operation_record_id = $4, result_record_ids = '{}', updated_at = now()
         WHERE authenticated_principal_ref = $1 AND operation_type = $2 AND idempotency_key = $3
           AND reserved_operation_id = $4 AND claim_token = $5
           AND status = 'in_progress'`,
        [
          command.command_context.authenticated_principal_ref,
          command.operation_type,
          command.idempotency_key,
          inserted[0]!.record_id,
          claimed.claimToken
        ]
      );
      if (finalized.rowCount !== 1) {
        throw new Error("Idempotency reservation expired before the denial audit committed.");
      }
      await client.query("COMMIT");
      return {
        status: "inserted",
        terminal_status: "succeeded",
        operation_record_id: inserted[0]!.record_id,
        result_record_ids: []
      };
    } catch (error) {
      await client.query("ROLLBACK");
      await releaseIdempotencyReservation(
        this.pool,
        command,
        reservedOperationId,
        claimed.claimToken
      );
      throw error;
    } finally {
      client.release();
    }
  }

  private async appendConflictAuditTransaction(command: AppendRuntimeCommand): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await appendConflictAudit(client, command);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async recoverExpiredReservation(
    command: AppendRuntimeCommand,
    reservedOperationId: string,
    claimToken: string
  ): Promise<RuntimeOperationResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await appendRecords(client, command.stream_id, command.command_context, [
        {
          record_id: reservedOperationId,
          kind: "audit_entry",
          type: "runtime.idempotency.abandoned",
          schema_version: 1,
          schema_ref: "runtime://schemas/idempotency-abandoned/v1",
          operation_type: command.operation_type,
          operation_schema_version: command.operation_schema_version,
          subject: { type: "runtime.operation", id: reservedOperationId },
          payload: {
            operation_type: command.operation_type,
            reason: "claim_lease_expired"
          },
          occurred_at: new Date().toISOString()
        }
      ]);
      const finalized = await client.query(
        `UPDATE idempotency_records
         SET status = 'failed', operation_record_id = reserved_operation_id,
             result_record_ids = '{}', updated_at = now()
         WHERE authenticated_principal_ref = $1 AND operation_type = $2
           AND idempotency_key = $3 AND reserved_operation_id = $4
           AND claim_token = $5 AND status = 'in_progress'`,
        [
          command.command_context.authenticated_principal_ref,
          command.operation_type,
          command.idempotency_key,
          reservedOperationId,
          claimToken
        ]
      );
      if (finalized.rowCount !== 1) {
        throw new Error("Expired idempotency reservation was recovered concurrently.");
      }
      await client.query("COMMIT");
      return {
        status: "replayed",
        terminal_status: "failed",
        operation_record_id: reservedOperationId,
        result_record_ids: []
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

type ClaimedIdempotency =
  | { kind: "new"; claimToken: string }
  | { kind: "conflict" }
  | { kind: "expired"; reservedOperationId: string; claimToken: string }
  | { kind: "replay"; result: RuntimeOperationResult };

async function reserveIdempotency(
  pool: Pool,
  command: AppendRuntimeCommand,
  reservedOperationId: string
): Promise<ClaimedIdempotency> {
  const claimToken = randomUUID();
  const inserted = await pool.query(
    `INSERT INTO idempotency_records
       (authenticated_principal_ref, operation_type, idempotency_key,
        canonicalization_version, command_digest, status, reserved_operation_id,
        claim_token, claim_expires_at)
     VALUES ($1, $2, $3, $4, $5, 'in_progress', $6, $7, now() + interval '5 minutes')
     ON CONFLICT (authenticated_principal_ref, operation_type, idempotency_key) DO NOTHING`,
    [
      command.command_context.authenticated_principal_ref,
      command.operation_type,
      command.idempotency_key,
      command.canonicalization_version,
      command.command_digest,
      reservedOperationId,
      claimToken
    ]
  );
  const current = await pool.query<{
    canonicalization_version: string;
    command_digest: string;
    status: "in_progress" | RuntimeTerminalStatus;
    reserved_operation_id: string;
    claim_expires_at: Date;
    operation_record_id: string | null;
    result_record_ids: string[];
  }>(
    `SELECT canonicalization_version, command_digest, status,
            reserved_operation_id, claim_expires_at, operation_record_id, result_record_ids
     FROM idempotency_records
     WHERE authenticated_principal_ref = $1 AND operation_type = $2 AND idempotency_key = $3
     `,
    [
      command.command_context.authenticated_principal_ref,
      command.operation_type,
      command.idempotency_key
    ]
  );
  const row = current.rows[0]!;
  if (
    compareIdempotencyCommand(row, {
      canonicalization_version: command.canonicalization_version,
      command_digest: command.command_digest
    }) === "conflict"
  ) {
    return { kind: "conflict" };
  }
  if (inserted.rowCount === 1) return { kind: "new", claimToken };
  if (row.status === "in_progress" && new Date(row.claim_expires_at).getTime() <= Date.now()) {
    const recovered = await pool.query<{ reserved_operation_id: string }>(
      `UPDATE idempotency_records
       SET claim_token = $4, claim_expires_at = now() + interval '5 minutes', updated_at = now()
       WHERE authenticated_principal_ref = $1 AND operation_type = $2
         AND idempotency_key = $3 AND status = 'in_progress'
         AND claim_expires_at <= now()
       RETURNING reserved_operation_id`,
      [
        command.command_context.authenticated_principal_ref,
        command.operation_type,
        command.idempotency_key,
        claimToken
      ]
    );
    if (recovered.rows[0]) {
      return {
        kind: "expired",
        reservedOperationId: recovered.rows[0].reserved_operation_id,
        claimToken
      };
    }
  }
  return {
    kind: "replay",
    result: {
      status: "replayed",
      terminal_status: row.status,
      operation_record_id: row.operation_record_id ?? row.reserved_operation_id,
      result_record_ids: row.result_record_ids
    }
  };
}

async function releaseIdempotencyReservation(
  pool: Pool,
  command: AppendRuntimeCommand,
  reservedOperationId: string,
  claimToken: string
): Promise<void> {
  await pool.query(
    `DELETE FROM idempotency_records
     WHERE authenticated_principal_ref = $1 AND operation_type = $2
       AND idempotency_key = $3 AND reserved_operation_id = $4
       AND claim_token = $5 AND status = 'in_progress'`,
    [
      command.command_context.authenticated_principal_ref,
      command.operation_type,
      command.idempotency_key,
      reservedOperationId,
      claimToken
    ]
  );
}

async function appendRecords(
  client: PoolClient,
  streamId: string,
  context: TrustedCommandContext,
  drafts: readonly RuntimeRecordDraft[]
): Promise<RuntimeRecord[]> {
  await client.query(
    `INSERT INTO record_streams (stream_id, next_record_sequence)
     VALUES ($1, 1) ON CONFLICT (stream_id) DO NOTHING`,
    [streamId]
  );
  const stream = await client.query<{ next_record_sequence: string }>(
    "SELECT next_record_sequence FROM record_streams WHERE stream_id = $1 FOR UPDATE",
    [streamId]
  );
  let nextSequence = Number(stream.rows[0]!.next_record_sequence);
  const records: RuntimeRecord[] = [];
  for (const draft of drafts) {
    const result = await client.query<RuntimeRecordRow>(
      `INSERT INTO runtime_records
         (record_id, stream_id, record_sequence, kind, type, schema_version,
          schema_ref, operation_type, operation_schema_version, command_context,
          authenticated_principal_ref, effective_actor, subject, payload, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb,
               $13::jsonb, $14::jsonb, $15::timestamptz)
       RETURNING record_id, stream_id, record_sequence, kind, type, schema_version,
                 schema_ref, operation_type, operation_schema_version, command_context, subject, payload,
                 occurred_at, recorded_at`,
      [
        draft.record_id,
        streamId,
        nextSequence,
        draft.kind,
        draft.type,
        draft.schema_version,
        draft.schema_ref,
        draft.operation_type ?? null,
        draft.operation_schema_version ?? null,
        JSON.stringify(context),
        context.authenticated_principal_ref,
        JSON.stringify(context.effective_actor),
        JSON.stringify(draft.subject),
        JSON.stringify(draft.payload),
        draft.occurred_at
      ]
    );
    records.push(mapRuntimeRecord(result.rows[0]!));
    nextSequence += 1;
  }
  await client.query(
    "UPDATE record_streams SET next_record_sequence = $2, updated_at = now() WHERE stream_id = $1",
    [streamId, nextSequence]
  );
  return records;
}

async function appendEdges(client: PoolClient, edges: readonly RuntimeEdgeDraft[]): Promise<void> {
  for (const edge of edges) {
    await client.query(
      `INSERT INTO record_edges (from_record_id, relation, ordinal, to_record_id)
       VALUES ($1, $2, $3, $4)`,
      [edge.from_record_id, edge.relation, edge.ordinal, edge.to_record_id]
    );
  }
}

async function appendResultReceipts(
  client: PoolClient,
  records: readonly RuntimeRecord[],
  edges: readonly RuntimeEdgeDraft[],
  outcome: RuntimeTerminalStatus
): Promise<void> {
  for (const record of records.filter((candidate) => candidate.kind === "result")) {
    const producer = edges.find(
      (edge) =>
        edge.relation === "produced" && edge.to_record_id === record.record_id
    );
    if (!producer) {
      throw new Error(`Result record ${record.record_id} requires a producing action edge.`);
    }
    const currentProducer = records.find(
      (candidate) => candidate.record_id === producer.from_record_id
    );
    const producerKind = currentProducer?.kind ??
      (
        await client.query<{ kind: RuntimeKind }>(
          "SELECT kind FROM runtime_records WHERE record_id = $1",
          [producer.from_record_id]
        )
      ).rows[0]?.kind;
    if (producerKind !== "action_attempt") {
      throw new Error(`Result record ${record.record_id} must be produced by an action attempt.`);
    }
    await client.query(
      `INSERT INTO results
         (runtime_record_id, action_attempt_record_id, result_type,
          schema_version, schema_ref, subject, payload, outcome)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
      [
        record.record_id,
        producer.from_record_id,
        record.type,
        record.schema_version,
        record.schema_ref,
        JSON.stringify(record.subject),
        JSON.stringify(record.payload),
        outcome
      ]
    );
  }
}

async function updateProjections(
  client: PoolClient,
  streamId: string,
  updates: readonly RuntimeProjectionUpdate[],
  lastRecord: RuntimeRecord | undefined
): Promise<void> {
  if (!lastRecord) return;
  for (const update of updates) {
    const projection = await client.query<{ projection_id: string }>(
      `INSERT INTO projection_states
         (stream_id, projection_type, subject_type, subject_id, projection_version, state)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (stream_id, projection_type, subject_type, subject_id, projection_version)
       DO UPDATE SET state = EXCLUDED.state, updated_at = now()
       RETURNING projection_id`,
      [
        streamId,
        update.projection_type,
        update.subject.type,
        update.subject.id,
        update.projection_version,
        JSON.stringify(update.state)
      ]
    );
    await client.query(
      `INSERT INTO projection_checkpoints
         (projection_id, last_record_sequence, last_record_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (projection_id) DO UPDATE
       SET last_record_sequence = EXCLUDED.last_record_sequence,
           last_record_id = EXCLUDED.last_record_id,
           updated_at = now()`,
      [projection.rows[0]!.projection_id, lastRecord.record_sequence, lastRecord.record_id]
    );
  }
}

async function appendConflictAudit(
  client: PoolClient,
  command: AppendRuntimeCommand
): Promise<void> {
  await appendRecords(client, command.stream_id, command.command_context, [
    {
      record_id: randomUUID(),
      kind: "audit_entry",
      type: "runtime.idempotency.conflict",
      schema_version: 1,
      schema_ref: "runtime://schemas/idempotency-conflict/v1",
      operation_type: command.operation_type,
      operation_schema_version: command.operation_schema_version,
      subject: { type: "runtime.idempotency", id: command.idempotency_key },
      payload: { operation_type: command.operation_type },
      occurred_at: new Date().toISOString()
    }
  ]);
}

function validateAppendCommand(
  command: AppendRuntimeCommand,
  registry: RuntimeTypeRegistry
): void {
  TrustedCommandContextSchema.parse(command.command_context);
  CommandDigestSchema.parse(command.command_digest);
  const canonicalCommand = CanonicalCommandEnvelopeSchema.parse(command.canonical_command);
  if (commandDigest(canonicalCommand) !== command.command_digest) {
    throw new Error("Command digest does not match the canonical command envelope.");
  }
  if (
    canonicalCommand.operation_type !== command.operation_type ||
    canonicalCommand.operation_schema_version !== command.operation_schema_version ||
    canonicalCommand.canonicalization_version !== command.canonicalization_version ||
    jsonDigest(canonicalCommand.arguments) !== jsonDigest(command.command_arguments)
  ) {
    throw new Error("Canonical command identity does not match the append command.");
  }
  SafeNamespacedIdentifierSchema.parse(command.operation_type);
  const operation = registry.requireOperation(
    command.operation_type,
    command.operation_schema_version
  );
  if (
    command.command_context.authorization.action !== operation.authorization_action
  ) {
    throw new Error("Authorization action does not match the registered operation action.");
  }
  registry.validateCommand(
    command.operation_type,
    command.operation_schema_version,
    command.command_arguments
  );
  if (command.records.length === 0) throw new Error("At least one runtime record is required.");
  const ids = new Set<string>();
  for (const record of command.records) {
    RuntimeKindSchema.parse(record.kind);
    SafeNamespacedIdentifierSchema.parse(record.type);
    RuntimeSubjectSchema.parse(record.subject);
    RuntimePayloadSchema.parse(record.payload);
    if (ids.has(record.record_id)) throw new Error(`Duplicate runtime record ${record.record_id}.`);
    ids.add(record.record_id);
    if (
      record.operation_type !== command.operation_type ||
      record.operation_schema_version !== command.operation_schema_version
    ) {
      throw new Error("Runtime record operation identity does not match its append command.");
    }
    if (isRegisteredKind(record.kind)) {
      const registration = registry.requireType(record.kind, record.type, record.schema_version);
      if (registration.schema_ref !== record.schema_ref) {
        throw new Error(`Schema reference for ${record.type} does not match its registration.`);
      }
      registry.validatePayload(record.kind, record.type, record.schema_version, record.payload);
    } else {
      validateBuiltInRecord(record);
    }
  }
  for (const edge of command.edges ?? []) {
    if (!ids.has(edge.from_record_id) && !ids.has(edge.to_record_id)) {
      throw new Error("At least one edge endpoint must be part of the current command.");
    }
  }
  const approvals = command.records.filter((record) => record.kind === "approval");
  if (operation.approval_required && approvals.length !== 1) {
    throw new Error(`Operation ${command.operation_type} requires exactly one approval record.`);
  }
  if (!operation.approval_required && approvals.length !== 0) {
    throw new Error(`Operation ${command.operation_type} does not accept approval records.`);
  }
  const approvalContext = command.approval_context
    ? TrustedCommandContextSchema.parse(command.approval_context)
    : undefined;
  if (operation.approval_required && !approvalContext) {
    throw new Error(`Operation ${command.operation_type} requires trusted approver context.`);
  }
  if (!operation.approval_required && approvalContext) {
    throw new Error(`Operation ${command.operation_type} does not accept approver context.`);
  }
  const action = command.records.find((record) => record.kind === "action_attempt");
  if (action) {
    const payload = ActionAttributionPayloadSchema.parse(action.payload);
    if (
      payload.operation_type !== command.operation_type ||
      payload.command_digest !== command.command_digest
    ) {
      throw new Error("Action attribution does not match its command identity.");
    }
  }
  if (approvals[0]) {
    const payload = ApprovalAttributionPayloadSchema.parse(approvals[0].payload);
    if (
      payload.operation_type !== command.operation_type ||
      payload.command_digest !== command.command_digest ||
      payload.decision !== "approved" ||
      payload.approver_authorization.result !== "allowed" ||
      payload.approver_authorization.action !== "runtime.command.approve"
    ) {
      throw new Error("Approval record is not authorized for this exact command.");
    }
    if (
      !approvalContext ||
      payload.approved_by_principal_ref !== approvalContext.authenticated_principal_ref ||
      jsonDigest(payload.effective_approver) !== jsonDigest(approvalContext.effective_actor) ||
      jsonDigest(payload.approver_authorization) !== jsonDigest(approvalContext.authorization)
    ) {
      throw new Error("Approval record does not match the trusted approver context.");
    }
    if (
      !action ||
      !(command.edges ?? []).some(
        (edge) =>
          edge.relation === "approved_by" &&
          edge.from_record_id === action.record_id &&
          edge.to_record_id === approvals[0]!.record_id
      )
    ) {
      throw new Error("Approved commands require an approved_by edge from the action attempt.");
    }
  }
}

function isRegisteredKind(kind: RuntimeKind): kind is RegisteredRuntimeKind {
  return kind === "event" || kind === "work_item" || kind === "result" || kind === "artifact";
}

function validateHistoricalRecord(
  record: RuntimeRecord,
  registry: RuntimeTypeRegistry
): void {
  if (record.operation_type) {
    if (!record.operation_schema_version) {
      throw new Error(`Historical record ${record.record_id} is missing its operation schema version.`);
    }
    registry.requireOperation(record.operation_type, record.operation_schema_version);
  }
  if (isRegisteredKind(record.kind)) {
    registry.validateHistoricalPayload(
      record.kind,
      record.type,
      record.schema_version,
      record.schema_ref,
      record.payload
    );
    return;
  }
  if (record.type.startsWith("legacy.")) {
    RuntimePayloadSchema.parse(record.payload);
    return;
  }
  validateBuiltInRecord(record);
}

function validateProjectionInputTypes(
  inputTypes: readonly RuntimeProjectionInputType[]
): void {
  if (inputTypes.length === 0) {
    throw new Error("Projection input_types must contain at least one typed input.");
  }
  const keys = new Set<string>();
  for (const input of inputTypes) {
    RuntimeKindSchema.parse(input.kind);
    SafeNamespacedIdentifierSchema.parse(input.type);
    if (!Number.isInteger(input.schema_version) || input.schema_version < 1) {
      throw new Error("Projection input schema versions must be positive integers.");
    }
    const key = `${input.kind}:${input.type}:${input.schema_version}`;
    if (keys.has(key)) throw new Error(`Duplicate projection input type ${key}.`);
    keys.add(key);
  }
}

function projectionConsumes(
  record: RuntimeRecord,
  inputTypes: readonly RuntimeProjectionInputType[]
): boolean {
  return inputTypes.some(
    (input) =>
      input.kind === record.kind &&
      input.type === record.type &&
      input.schema_version === record.schema_version
  );
}

function validateBuiltInRecord(
  record: Pick<RuntimeRecordDraft, "kind" | "type" | "schema_version" | "schema_ref" | "payload">
): void {
  if (record.schema_version !== 1) {
    throw new Error(`Built-in runtime record ${record.type} requires schema version 1.`);
  }
  if (record.kind === "action_attempt") {
    if (
      record.type !== "runtime.action.attempt" ||
      record.schema_ref !== "runtime://schemas/action-attribution/v1"
    ) {
      throw new Error("Action attempts must use the built-in action-attribution schema.");
    }
    ActionAttributionPayloadSchema.parse(record.payload);
    return;
  }
  if (record.kind === "approval") {
    if (
      record.type !== "runtime.command.approval" ||
      record.schema_ref !== "runtime://schemas/command-approval/v1"
    ) {
      throw new Error("Approvals must use the built-in command-approval schema.");
    }
    ApprovalAttributionPayloadSchema.parse(record.payload);
    return;
  }
  if (record.kind === "audit_entry") {
    const schemas = {
      "runtime.authorization.denied": {
        schema: AuthorizationDenialAuditPayloadSchema,
        schemaRef: "runtime://schemas/authorization-denied/v1"
      },
      "runtime.idempotency.conflict": {
        schema: IdempotencyConflictAuditPayloadSchema,
        schemaRef: "runtime://schemas/idempotency-conflict/v1"
      },
      "runtime.idempotency.abandoned": {
        schema: IdempotencyAbandonedAuditPayloadSchema,
        schemaRef: "runtime://schemas/idempotency-abandoned/v1"
      },
      "runtime.operation.audit": {
        schema: OperationAuditPayloadSchema,
        schemaRef: "runtime://schemas/audit-entry/v1"
      }
    } as const;
    const definition = schemas[record.type as keyof typeof schemas];
    if (!definition) throw new Error(`Unknown built-in audit type ${record.type}.`);
    if (record.schema_ref !== definition.schemaRef) {
      throw new Error(`Audit record ${record.type} has an unexpected schema reference.`);
    }
    definition.schema.parse(record.payload);
    return;
  }
  throw new Error(`Runtime kind ${record.kind} cannot be appended as a direct record.`);
}

interface RuntimeRecordRow {
  record_id: string;
  stream_id: string;
  record_sequence: string;
  kind: RuntimeKind;
  type: string;
  schema_version: number;
  schema_ref: string;
  operation_type: string | null;
  operation_schema_version: number | null;
  command_context: TrustedCommandContext;
  subject: RuntimeSubject;
  payload: RuntimePayload;
  occurred_at: Date;
  recorded_at: Date;
}

function mapRuntimeRecord(row: RuntimeRecordRow): RuntimeRecord {
  return {
    record_id: row.record_id,
    stream_id: row.stream_id,
    record_sequence: Number(row.record_sequence),
    kind: row.kind,
    type: row.type,
    schema_version: row.schema_version,
    schema_ref: row.schema_ref,
    ...(row.operation_type ? { operation_type: row.operation_type } : {}),
    ...(row.operation_schema_version
      ? { operation_schema_version: row.operation_schema_version }
      : {}),
    command_context: TrustedCommandContextSchema.parse(row.command_context),
    subject: RuntimeSubjectSchema.parse(row.subject),
    payload: RuntimePayloadSchema.parse(row.payload),
    occurred_at: new Date(row.occurred_at).toISOString(),
    recorded_at: new Date(row.recorded_at).toISOString()
  };
}
