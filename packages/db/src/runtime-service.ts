import { randomUUID } from "node:crypto";

import {
  ActionAttributionPayloadSchema,
  ActionAttributionSchema,
  ApprovalAttributionPayloadSchema,
  CanonicalCommandEnvelopeSchema,
  CommandDigestSchema,
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
  approval_evidence?: RuntimeApprovalEvidence;
  command_context: unknown;
  action: RuntimeActionMetadata;
  projection_updates?: readonly RuntimeProjectionUpdate[];
}

export interface RuntimeApprovalEvidence {
  record_id?: string;
  work_item_id: string;
  operation_type: string;
  action_revision: number;
  command_digest: string;
  approved_by_principal_ref: string;
  decision: "approved" | "rejected";
  decided_at: string;
  approver_context: unknown;
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

    const operation = this.validateCommand(command);
    if (context.authorization.action !== operation.authorization_action) {
      throw new Error(
        `Authorization action ${context.authorization.action} does not match registered action ${operation.authorization_action}.`
      );
    }

    if (context.authorization.result === "denied") {
      return this.repository.recordAuthorizationDecision({
        stream_id: input.stream_id,
        operation_type: command.operation_type,
        operation_schema_version: command.operation_schema_version,
        target: command.target,
        request_id: input.action.request_id,
        command_context: context
      });
    }

    if (operation.approval_required && input.approval_evidence === undefined) {
      throw new Error(`Operation ${command.operation_type} requires approval evidence.`);
    }
    if (!operation.approval_required && input.approval_evidence !== undefined) {
      throw new Error(`Operation ${command.operation_type} does not accept approval evidence.`);
    }
    const approval = input.approval_evidence
      ? validateApprovalEvidence(input.approval_evidence, command, computedDigest)
      : undefined;
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
    const approvalRecordId = approval?.record_id ?? (approval ? this.createId() : undefined);
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
          operation_type: command.operation_type,
          operation_schema_version: command.operation_schema_version
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
    const { command_context: _trustedContext, id: _id, ...unvalidatedActionPayload } =
      actionAttribution;
    const actionPayload = ActionAttributionPayloadSchema.parse(unvalidatedActionPayload);

    return this.repository.appendCommand({
      stream_id: input.stream_id,
      operation_type: command.operation_type,
      operation_schema_version: command.operation_schema_version,
      idempotency_key: input.idempotency_key,
      canonicalization_version: command.canonicalization_version,
      command_digest: computedDigest,
      command_arguments: command.arguments,
      canonical_command: command,
      command_context: context,
      ...(approval ? { approval_context: approval.context } : {}),
      ...(approval?.record_id ? { approval_record_id: approval.record_id } : {}),
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
          operation_type: command.operation_type,
          operation_schema_version: command.operation_schema_version
        },
        ...(approval && approvalRecordId && !approval.record_id
          ? [
              {
                record_id: approvalRecordId,
                kind: "approval" as const,
                type: "runtime.command.approval",
                schema_version: 1,
                schema_ref: "runtime://schemas/command-approval/v1",
                subject: command.target,
                payload: approval.payload,
                occurred_at: approval.decided_at,
                operation_type: command.operation_type,
                operation_schema_version: command.operation_schema_version
              }
            ]
          : []),
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
        ...(approvalRecordId
          ? [
              {
                from_record_id: actionRecordId,
                relation: "approved_by" as const,
                to_record_id: approvalRecordId,
                ordinal: 0
              }
            ]
          : []),
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

function validateApprovalEvidence(
  evidence: RuntimeApprovalEvidence,
  command: CanonicalCommandEnvelope,
  computedDigest: string
): {
  record_id?: string;
  decided_at: string;
  payload: RuntimePayload;
  context: TrustedCommandContext;
} {
  const approverContext = TrustedCommandContextSchema.parse(evidence.approver_context);
  const payload = ApprovalAttributionPayloadSchema.parse({
    work_item_id: evidence.work_item_id,
    operation_type: evidence.operation_type,
    action_revision: evidence.action_revision,
    command_digest: evidence.command_digest,
    approved_by_principal_ref: evidence.approved_by_principal_ref,
    effective_approver: approverContext.effective_actor,
    approver_authorization: approverContext.authorization,
    decision: evidence.decision,
    decided_at: evidence.decided_at
  });

  if (payload.work_item_id !== command.work_item_id) {
    throw new Error("Approval work item does not match the canonical command envelope.");
  }
  if (payload.operation_type !== command.operation_type) {
    throw new Error("Approval operation type does not match the canonical command envelope.");
  }
  if (payload.action_revision !== command.action_revision) {
    throw new Error("Approval action revision does not match the canonical command envelope.");
  }
  if (payload.command_digest !== computedDigest) {
    throw new Error("Approved command digest does not match the canonical command envelope.");
  }
  if (payload.decision !== "approved") {
    throw new Error("Approval evidence must contain an approved decision.");
  }
  if (payload.approved_by_principal_ref !== approverContext.authenticated_principal_ref) {
    throw new Error("Approval principal does not match the trusted approver context.");
  }
  if (approverContext.authorization.result !== "allowed") {
    throw new Error("Approver context must contain an allowed authorization decision.");
  }
  if (approverContext.authorization.action !== "runtime.command.approve") {
    throw new Error("Approver authorization action must be runtime.command.approve.");
  }

  return {
    ...(evidence.record_id ? { record_id: evidence.record_id } : {}),
    decided_at: payload.decided_at,
    payload,
    context: approverContext
  };
}
