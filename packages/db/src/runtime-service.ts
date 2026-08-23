import { randomUUID } from "node:crypto";

import {
  ActionAttributionSchema,
  CanonicalCommandEnvelopeSchema,
  CommandDigestSchema,
  RuntimePayloadSchema,
  TrustedCommandContextSchema,
  type ActionTrigger,
  type CanonicalCommandEnvelope,
  type RecordRef,
  type RuntimePayload,
  type TrustedCommandContext
} from "@openclaw-control-plane/contracts";

import { commandDigest } from "./canonical-command.js";
import type {
  AppendRuntimeCommand,
  AuthorizationDenialInput,
  RuntimeOperationResult,
  RuntimeProjectionUpdate,
  RuntimeRecordDraft
} from "./runtime-repository.js";
import { RuntimeTypeRegistry } from "./runtime-registry.js";

export interface RuntimeRepositoryBoundary {
  appendCommand(command: AppendRuntimeCommand): Promise<RuntimeOperationResult>;
  recordAuthorizationDecision(input: AuthorizationDenialInput): Promise<RuntimeOperationResult>;
}

export interface RuntimeActionMetadata {
  trigger: ActionTrigger;
  causation_ref: RecordRef;
  correlation_id: string;
  request_id: string;
  tool_invocation_id?: string;
  input_refs: readonly RecordRef[];
  started_at: string;
  finished_at: string;
  outcome: "succeeded" | "failed" | "cancelled";
}

export interface ExecuteRuntimeCommandInput {
  stream_id: string;
  idempotency_key: string;
  command: unknown;
  command_digest: string;
  approved_command_digest?: string;
  command_context: unknown;
  action: RuntimeActionMetadata;
  projection_updates?: readonly RuntimeProjectionUpdate[];
}

export interface RuntimeServiceOptions {
  createId?: () => string;
}

export class PrincipalAwareRuntimeService {
  private readonly createId: () => string;

  constructor(
    private readonly repository: RuntimeRepositoryBoundary,
    private readonly registry: RuntimeTypeRegistry,
    options: RuntimeServiceOptions = {}
  ) {
    this.createId = options.createId ?? randomUUID;
  }

  async execute(input: ExecuteRuntimeCommandInput): Promise<RuntimeOperationResult> {
    const command = CanonicalCommandEnvelopeSchema.parse(input.command);
    const context = TrustedCommandContextSchema.parse(input.command_context);
    const suppliedDigest = CommandDigestSchema.parse(input.command_digest);
    const computedDigest = commandDigest(command);

    if (suppliedDigest !== computedDigest) {
      throw new Error("Supplied command digest does not match the canonical command envelope.");
    }
    if (
      input.approved_command_digest !== undefined &&
      CommandDigestSchema.parse(input.approved_command_digest) !== computedDigest
    ) {
      throw new Error("Approved command digest does not match the canonical command envelope.");
    }

    if (context.authorization.result === "denied") {
      return this.repository.recordAuthorizationDecision({
        stream_id: input.stream_id,
        operation_type: command.operation_type,
        target: command.target,
        request_id: input.action.request_id,
        command_context: context
      });
    }

    const operation = this.validateCommand(command);
    for (const effect of command.declared_effects) {
      if (!operation.allowed_result_types.includes(effect.result_type)) {
        throw new Error(
          `Result type ${effect.result_type} is not allowed for ${command.operation_type}.`
        );
      }
      const registration = this.registry.requireType(
        "result",
        effect.result_type,
        effect.schema_version
      );
      if (registration.schema_ref !== effect.schema_ref) {
        throw new Error(`Schema reference for ${effect.result_type} does not match its registration.`);
      }
      this.registry.validatePayload(
        "result",
        effect.result_type,
        effect.schema_version,
        effect.payload
      );
    }

    const actionRecordId = this.createId();
    const resultRecords = command.declared_effects.map(
      (effect) =>
        ({
          record_id: this.createId(),
          kind: "result" as const,
          type: effect.result_type,
          schema_version: effect.schema_version,
          schema_ref: effect.schema_ref,
          subject: effect.target,
          payload: effect.payload,
          occurred_at: input.action.finished_at,
          operation_type: command.operation_type
        }) satisfies RuntimeRecordDraft
    );
    const actionAttribution = ActionAttributionSchema.parse({
      id: actionRecordId,
      work_item_id: command.work_item_id,
      operation_type: command.operation_type,
      handler_id: operation.handler_id,
      handler_version: operation.handler_version,
      command_context: context,
      subject: command.target,
      trigger: input.action.trigger,
      causation_ref: input.action.causation_ref,
      correlation_id: input.action.correlation_id,
      request_id: input.action.request_id,
      ...(input.action.tool_invocation_id
        ? { tool_invocation_id: input.action.tool_invocation_id }
        : {}),
      canonicalization_version: command.canonicalization_version,
      input_refs: [...input.action.input_refs],
      command_digest: computedDigest,
      started_at: input.action.started_at,
      finished_at: input.action.finished_at,
      outcome: input.action.outcome,
      result_refs: resultRecords.map((record) => ({ kind: "result" as const, id: record.record_id }))
    });
    const { command_context: _trustedContext, id: _id, ...actionPayload } = actionAttribution;
    RuntimePayloadSchema.parse(actionPayload);

    return this.repository.appendCommand({
      stream_id: input.stream_id,
      operation_type: command.operation_type,
      operation_schema_version: command.operation_schema_version,
      idempotency_key: input.idempotency_key,
      canonicalization_version: command.canonicalization_version,
      command_digest: computedDigest,
      command_arguments: command.arguments,
      command_context: context,
      records: [
        {
          record_id: actionRecordId,
          kind: "action_attempt",
          type: "runtime.action.attempt",
          schema_version: 1,
          schema_ref: "runtime://schemas/action-attribution/v1",
          subject: command.target,
          payload: actionPayload as RuntimePayload,
          occurred_at: input.action.finished_at,
          operation_type: command.operation_type
        },
        ...resultRecords
      ],
      edges: [
        {
          from_record_id: actionRecordId,
          relation: "caused_by",
          to_record_id: input.action.causation_ref.id,
          ordinal: 0
        },
        ...input.action.input_refs.map((ref, ordinal) => ({
          from_record_id: actionRecordId,
          relation: "derived_from" as const,
          to_record_id: ref.id,
          ordinal
        })),
        ...resultRecords.map((record, ordinal) => ({
          from_record_id: actionRecordId,
          relation: "produced" as const,
          to_record_id: record.record_id,
          ordinal
        }))
      ],
      ...(input.projection_updates
        ? { projection_updates: input.projection_updates }
        : {}),
      terminal_status: input.action.outcome === "succeeded" ? "succeeded" : "failed"
    });
  }

  private validateCommand(command: CanonicalCommandEnvelope) {
    const operation = this.registry.requireOperation(
      command.operation_type,
      command.operation_schema_version
    );
    this.registry.validateCommand(
      command.operation_type,
      command.operation_schema_version,
      command.arguments
    );
    return operation;
  }
}
