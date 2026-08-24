import { z } from "zod";

import {
  CanonicalCommandEnvelopeSchema,
  RecordRefSchema,
  RuntimeKindSchema,
  RuntimePayloadSchema,
  RuntimeSubjectSchema,
  SafeLocalIdentifierSchema,
  SafeNamespacedIdentifierSchema
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
    after_sequence: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50)
  })
  .strict();
export type RuntimeRecordQuery = z.infer<typeof RuntimeRecordQuerySchema>;

export const RuntimeErrorSchema = z
  .object({
    error: z.object({
      code: SafeNamespacedIdentifierSchema,
      message: z.string().min(1).max(512),
      request_id: SafeLocalIdentifierSchema
    })
  })
  .strict();
