import { z } from "zod";

import {
  CanonicalCommandEnvelopeSchema,
  RecordRefSchema,
  RuntimeKindSchema,
  RuntimePayloadSchema,
  RuntimeSubjectSchema,
  SafeLocalIdentifierSchema,
  SafeNamespacedIdentifierSchema,
  TrustedCommandContextSchema,
  TypeRegistrationSchema,
  OperationRegistrationSchema,
  CommandDigestSchema
} from "./runtime.js";

const RuntimeRecordKindSchema = RuntimeKindSchema.exclude(["projection"]);

export const RuntimeIntakeRequestSchema = z
  .object({
    record_id: z.string().uuid(),
    stream_id: SafeLocalIdentifierSchema,
    kind: z.enum(["event", "work_item"]),
    type: SafeNamespacedIdentifierSchema,
    schema_version: z.number().int().positive(),
    subject: RuntimeSubjectSchema,
    payload: RuntimePayloadSchema,
    source_refs: z.array(RecordRefSchema).max(100).default([])
  })
  .strict();
export type RuntimeIntakeRequest = z.infer<typeof RuntimeIntakeRequestSchema>;

export const RuntimeApprovalRequestSchema = CanonicalCommandEnvelopeSchema.omit({
  canonicalization_version: true
})
  .extend({ decision: z.enum(["approved", "rejected"]) })
  .strict();
export type RuntimeApprovalRequest = z.infer<typeof RuntimeApprovalRequestSchema>;

export const RuntimeCommandRequestSchema = CanonicalCommandEnvelopeSchema.omit({
  canonicalization_version: true
})
  .extend({
    stream_id: SafeLocalIdentifierSchema,
    idempotency_key: SafeLocalIdentifierSchema,
    approval_id: z.string().uuid().optional(),
    trigger: z
      .object({
        type: z.enum(["event", "schedule", "user_request", "retry", "internal"]),
        ref: RecordRefSchema
      })
      .strict(),
    causation_ref: RecordRefSchema,
    correlation_id: SafeLocalIdentifierSchema,
    input_refs: z.array(RecordRefSchema).max(100).default([])
  })
  .strict();
export type RuntimeCommandRequest = z.infer<typeof RuntimeCommandRequestSchema>;

export const RuntimeRecordQuerySchema = z
  .object({
    stream_id: SafeLocalIdentifierSchema.optional(),
    kind: RuntimeRecordKindSchema.optional(),
    type: SafeNamespacedIdentifierSchema.optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(100).default(50)
  })
  .strict();
export type RuntimeRecordQuery = z.infer<typeof RuntimeRecordQuerySchema>;

export const RuntimeRecordSchema = z
  .object({
    record_id: z.string().uuid(),
    stream_id: SafeLocalIdentifierSchema,
    record_sequence: z.number().int().positive(),
    kind: RuntimeRecordKindSchema,
    type: SafeNamespacedIdentifierSchema,
    schema_version: z.number().int().positive(),
    schema_ref: z.string().min(1).max(2048),
    operation_type: SafeNamespacedIdentifierSchema.optional(),
    operation_schema_version: z.number().int().positive().optional(),
    command_context: TrustedCommandContextSchema,
    subject: RuntimeSubjectSchema,
    payload: RuntimePayloadSchema,
    occurred_at: z.string().datetime(),
    recorded_at: z.string().datetime()
  })
  .strict();

export const RuntimeEdgeSchema = z
  .object({
    from_record_id: z.string().uuid(),
    relation: z.enum([
      "caused_by",
      "derived_from",
      "attempted_by",
      "produced",
      "approved_by",
      "supersedes"
    ]),
    to_record_id: z.string().uuid(),
    ordinal: z.number().int().nonnegative()
  })
  .strict();

export const RuntimeRegistrationCatalogSchema = z
  .object({
    types: z.array(TypeRegistrationSchema),
    operations: z.array(OperationRegistrationSchema)
  })
  .strict();
export const RuntimeIntakeResponseSchema = z
  .object({ status: z.enum(["inserted", "replayed"]), record: RuntimeRecordSchema })
  .strict();
export const RuntimeApprovalResponseSchema = z
  .object({
    status: z.enum(["inserted", "replayed"]),
    approval_id: z.string().uuid(),
    command_digest: CommandDigestSchema
  })
  .strict();
export const RuntimeOperationResponseSchema = z
  .object({
    status: z.enum(["inserted", "replayed"]),
    terminal_status: z.enum(["in_progress", "succeeded", "failed"]),
    operation_record_id: z.string().uuid(),
    result_record_ids: z.array(z.string().uuid())
  })
  .strict();
export const RuntimeRecordResponseSchema = z.object({ record: RuntimeRecordSchema }).strict();
export const RuntimeRecordPageResponseSchema = z
  .object({ records: z.array(RuntimeRecordSchema), next_cursor: z.string().nullable() })
  .strict();
export const RuntimeEdgesResponseSchema = z
  .object({ edges: z.array(RuntimeEdgeSchema) })
  .strict();
export const RuntimeProjectionResponseSchema = z
  .object({
    projection: z
      .object({
        state: RuntimePayloadSchema,
        last_record_sequence: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();

export const RuntimeErrorSchema = z
  .object({
    error: z.object({
      code: SafeNamespacedIdentifierSchema,
      message: z.string().min(1).max(512),
      request_id: SafeLocalIdentifierSchema
    })
  })
  .strict();
