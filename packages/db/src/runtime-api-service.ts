import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  ApprovalAttributionPayloadSchema,
  RuntimeApprovalRequestSchema,
  RuntimeCommandRequestSchema,
  RuntimeIntakeRequestSchema,
  RuntimeRecordQuerySchema,
  type RuntimeApprovalRequest,
  type RuntimeCommandRequest,
  type RuntimeIntakeRequest,
  type RuntimeRecordQuery,
  type TrustedCommandContext
} from "@openclaw-control-plane/contracts";

import { commandDigest } from "./canonical-command.js";
import type {
  PostgresRuntimeRepository,
  RuntimeAccessDenialInput
} from "./runtime-repository.js";
import { RuntimeTypeRegistry } from "./runtime-registry.js";
import { PrincipalAwareRuntimeService, type RuntimeApprovalEvidence } from "./runtime-service.js";

export interface RuntimeApiServiceOptions {
  createId?: () => string;
  now?: () => string;
}

export class RuntimeRequestError extends Error {
  constructor(
    message = "Runtime request is not valid for the active registry.",
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "RuntimeRequestError";
  }
}

const RuntimeCursorPayloadSchema = z
  .object({
    version: z.literal(1),
    stream_id: z.string().min(1),
    record_sequence: z.number().int().nonnegative()
  })
  .strict();

export class RuntimeApiService {
  private readonly runtimeService: PrincipalAwareRuntimeService;
  private readonly createId: () => string;
  private readonly now: () => string;

  constructor(
    private readonly repository: PostgresRuntimeRepository,
    private readonly registry: RuntimeTypeRegistry,
    options: RuntimeApiServiceOptions = {}
  ) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.runtimeService = new PrincipalAwareRuntimeService(repository, registry, {
      createId: this.createId
    });
  }

  describeOperation(operationType: string, schemaVersion: number) {
    return registryRequest(() => this.registry.requireOperation(operationType, schemaVersion));
  }

  listRegistrations() {
    return {
      types: this.registry.listTypes().filter((registration) => registration.status === "active"),
      operations: this.registry
        .listOperations()
        .filter((registration) => registration.status === "active")
    };
  }

  async createIntake(input: RuntimeIntakeRequest, context: TrustedCommandContext) {
    const request = RuntimeIntakeRequestSchema.parse(input);
    const registration = registryRequest(() =>
      this.registry.requireType(request.kind, request.type, request.schema_version)
    );
    return this.repository.appendIntakeRecord({
      stream_id: request.stream_id,
      command_context: context,
      source_refs: request.source_refs,
      record: {
        record_id: request.record_id,
        kind: request.kind,
        type: request.type,
        schema_version: request.schema_version,
        schema_ref: registration.schema_ref,
        subject: request.subject,
        payload: request.payload,
        occurred_at: this.now()
      }
    });
  }

  async createApproval(input: RuntimeApprovalRequest, context: TrustedCommandContext) {
    const request = RuntimeApprovalRequestSchema.parse(input);
    const command = {
      canonicalization_version: "jcs-rfc8785-v1" as const,
      operation_type: request.operation_type,
      operation_schema_version: request.operation_schema_version,
      work_item_id: request.work_item_id,
      action_revision: request.action_revision,
      target: request.target,
      arguments: request.arguments,
      declared_effects: request.declared_effects
    };
    registryRequest(() =>
      this.registry.validateCommand(
        command.operation_type,
        command.operation_schema_version,
        command.arguments
      )
    );
    const digest = commandDigest(command);
    const recordId = this.createId();
    const decidedAt = this.now();
    const payload = ApprovalAttributionPayloadSchema.parse({
      work_item_id: command.work_item_id,
      operation_type: command.operation_type,
      action_revision: command.action_revision,
      command_digest: digest,
      approved_by_principal_ref: context.authenticated_principal_ref,
      effective_approver: context.effective_actor,
      approver_authorization: context.authorization,
      decision: request.decision,
      decided_at: decidedAt
    });
    const result = await this.repository.appendIntakeRecord({
      stream_id: `approval:${command.work_item_id}`,
      command_context: context,
      record: {
        record_id: recordId,
        kind: "approval",
        type: "runtime.command.approval",
        schema_version: 1,
        schema_ref: "runtime://schemas/command-approval/v1",
        operation_type: command.operation_type,
        operation_schema_version: command.operation_schema_version,
        subject: command.target,
        payload,
        occurred_at: decidedAt
      }
    });
    return { status: result.status, approval_id: result.record.record_id, command_digest: digest };
  }

  async executeCommand(
    input: RuntimeCommandRequest,
    context: TrustedCommandContext,
    requestId: string,
    toolInvocationId?: string
  ) {
    const request = RuntimeCommandRequestSchema.parse(input);
    const command = {
      canonicalization_version: "jcs-rfc8785-v1" as const,
      operation_type: request.operation_type,
      operation_schema_version: request.operation_schema_version,
      work_item_id: request.work_item_id,
      action_revision: request.action_revision,
      target: request.target,
      arguments: request.arguments,
      declared_effects: request.declared_effects
    };
    const operation = registryRequest(() =>
      this.registry.requireOperation(command.operation_type, command.operation_schema_version)
    );
    registryRequest(() =>
      this.registry.validateCommand(
        command.operation_type,
        command.operation_schema_version,
        command.arguments
      )
    );
    for (const effect of command.declared_effects) {
      if (!operation.allowed_result_types.includes(effect.result_type)) {
        throw new RuntimeRequestError("A declared effect is not allowed for this operation.");
      }
      const kind = effect.kind ?? "result";
      const registration = registryRequest(() =>
        this.registry.requireType(kind, effect.result_type, effect.schema_version)
      );
      if (registration.schema_ref !== effect.schema_ref) {
        throw new RuntimeRequestError("A declared effect has an invalid schema reference.");
      }
      registryRequest(() =>
        this.registry.validateHistoricalPayload(
          kind,
          effect.result_type,
          effect.schema_version,
          effect.schema_ref,
          effect.payload
        )
      );
    }
    const digest = commandDigest(command);
    const approval = request.approval_id
      ? await this.resolveApproval(request.approval_id)
      : undefined;
    const startedAt = this.now();
    return this.runtimeService.execute({
      stream_id: request.stream_id,
      idempotency_key: request.idempotency_key,
      command,
      command_digest: digest,
      command_context: context,
      ...(approval ? { approval_evidence: approval } : {}),
      action: {
        trigger: request.trigger,
        causation_ref: request.causation_ref,
        correlation_id: request.correlation_id,
        request_id: requestId,
        ...(toolInvocationId ? { tool_invocation_id: toolInvocationId } : {}),
        input_refs: request.input_refs,
        started_at: startedAt,
        finished_at: this.now(),
        outcome: "succeeded"
      }
    });
  }

  getRecord(recordId: string) {
    return this.repository.getRecord(recordId);
  }

  async listRecords(input: RuntimeRecordQuery) {
    const query = RuntimeRecordQuerySchema.parse(input);
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (query.stream_id && cursor && cursor.stream_id !== query.stream_id) {
      throw new RuntimeRequestError("The page cursor does not belong to the requested stream.");
    }
    const page = await this.repository.listRecords({
      ...(query.stream_id ? { stream_id: query.stream_id } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(cursor ? { cursor } : {}),
      limit: query.limit
    });
    return {
      records: page.records,
      next_cursor: page.next_cursor ? encodeCursor(page.next_cursor) : null
    };
  }

  listEdges(recordId: string) {
    return this.repository.listEdges(recordId);
  }

  getProjection(
    streamId: string,
    projectionType: string,
    subject: { type: string; id: string },
    projectionVersion: number
  ) {
    return this.repository.getProjection(streamId, projectionType, subject, projectionVersion);
  }

  recordAccessDenial(input: RuntimeAccessDenialInput) {
    return this.repository.recordAccessDenial(input);
  }

  recordCommandDenial(input: Parameters<PostgresRuntimeRepository["recordAuthorizationDecision"]>[0]) {
    return this.repository.recordAuthorizationDecision(input);
  }

  private async resolveApproval(recordId: string): Promise<RuntimeApprovalEvidence> {
    const record = await this.repository.getRecord(recordId);
    if (!record || record.kind !== "approval" || record.type !== "runtime.command.approval") {
      throw new Error("Approval record was not found.");
    }
    const payload = ApprovalAttributionPayloadSchema.parse(record.payload);
    return {
      record_id: record.record_id,
      work_item_id: payload.work_item_id,
      operation_type: payload.operation_type,
      action_revision: payload.action_revision,
      command_digest: payload.command_digest,
      approved_by_principal_ref: payload.approved_by_principal_ref,
      decision: payload.decision,
      decided_at: payload.decided_at,
      approver_context: record.command_context
    };
  }
}

function registryRequest<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    throw new RuntimeRequestError(undefined, { cause: error });
  }
}

function encodeCursor(cursor: { stream_id: string; record_sequence: number }): string {
  return Buffer.from(
    JSON.stringify({ version: 1, ...cursor }),
    "utf8"
  ).toString("base64url");
}

function decodeCursor(cursor: string) {
  try {
    return RuntimeCursorPayloadSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    );
  } catch {
    throw new RuntimeRequestError("The page cursor is malformed.");
  }
}
