import { z } from "zod";

const SAFE_NAMESPACED_IDENTIFIER =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const SAFE_LOCAL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const PREFIXED_SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

export const SafeNamespacedIdentifierSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(
    SAFE_NAMESPACED_IDENTIFIER,
    "Identifier must be a safe lowercase namespaced value."
  );
export type SafeNamespacedIdentifier = z.infer<
  typeof SafeNamespacedIdentifierSchema
>;

export const SafeLocalIdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(SAFE_LOCAL_IDENTIFIER, "Identifier contains unsafe characters.");
export type SafeLocalIdentifier = z.infer<typeof SafeLocalIdentifierSchema>;

export const RuntimeKindSchema = z.enum([
  "event",
  "work_item",
  "action_attempt",
  "approval",
  "result",
  "artifact",
  "audit_entry",
  "projection"
]);
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;

export const PayloadRecordKindSchema = z.enum([
  "event",
  "work_item",
  "result",
  "artifact"
]);
export type PayloadRecordKind = z.infer<typeof PayloadRecordKindSchema>;

export const RecordRefSchema = z
  .object({
    kind: RuntimeKindSchema.exclude(["projection"]),
    id: z.string().uuid()
  })
  .strict();
export type RecordRef = z.infer<typeof RecordRefSchema>;

export const RuntimeSubjectSchema = z
  .object({
    type: SafeNamespacedIdentifierSchema,
    id: SafeLocalIdentifierSchema
  })
  .strict();
export type RuntimeSubject = z.infer<typeof RuntimeSubjectSchema>;

export const ExternalRefSchema = z
  .object({
    type: SafeNamespacedIdentifierSchema,
    id: SafeLocalIdentifierSchema
  })
  .strict();
export type ExternalRef = z.infer<typeof ExternalRefSchema>;

export const ActorTypeSchema = z.enum([
  "user",
  "agent",
  "service",
  "system"
]);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const EffectiveActorSchema = z
  .object({
    type: ActorTypeSchema,
    id: SafeLocalIdentifierSchema
  })
  .strict();
export type EffectiveActor = z.infer<typeof EffectiveActorSchema>;

export const AuthorizationEvidenceSchema = z
  .object({
    decision_id: SafeLocalIdentifierSchema,
    action: SafeNamespacedIdentifierSchema,
    result: z.enum(["allowed", "denied"]),
    policy_version: SafeLocalIdentifierSchema,
    reason_codes: z.array(SafeNamespacedIdentifierSchema).default([])
  })
  .strict();
export type AuthorizationEvidence = z.infer<
  typeof AuthorizationEvidenceSchema
>;

export const TrustedCommandContextSchema = z
  .object({
    authenticated_principal_ref: z
      .string()
      .min(13)
      .max(512)
      .regex(
        /^principal:\/\/[A-Za-z0-9][A-Za-z0-9._:@/-]*$/,
        "Principal reference must use the principal:// scheme."
      ),
    effective_actor: EffectiveActorSchema,
    on_behalf_of_principal_ref: z
      .string()
      .min(13)
      .max(512)
      .regex(/^principal:\/\/[A-Za-z0-9][A-Za-z0-9._:@/-]*$/)
      .optional(),
    request_origin: z.enum([
      "http",
      "tool",
      "worker",
      "scheduler",
      "internal"
    ]),
    authorization: AuthorizationEvidenceSchema
  })
  .strict();
export type TrustedCommandContext = z.infer<
  typeof TrustedCommandContextSchema
>;

type RuntimeJsonValue =
  | string
  | number
  | boolean
  | null
  | RuntimeJsonValue[]
  | { [key: string]: RuntimeJsonValue };

const RuntimeJsonValueSchema: z.ZodType<RuntimeJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(RuntimeJsonValueSchema),
    z.record(RuntimeJsonValueSchema)
  ])
);
const JsonObjectSchema = z.record(RuntimeJsonValueSchema);
const RESERVED_TRUST_FIELDS = new Set([
  "actor",
  "effective_actor",
  "authenticated_principal_ref",
  "on_behalf_of_principal_ref",
  "authorization",
  "command_context"
]);

export const RuntimePayloadSchema = JsonObjectSchema.superRefine((payload, ctx) => {
  for (const key of Object.keys(payload)) {
    if (RESERVED_TRUST_FIELDS.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is reserved for trusted command context.`
      });
    }
  }
});
export type RuntimePayload = z.infer<typeof RuntimePayloadSchema>;

export const TypeRegistrationSchema = z
  .object({
    kind: PayloadRecordKindSchema,
    type: SafeNamespacedIdentifierSchema,
    schema_version: z.number().int().positive(),
    schema_ref: z.string().min(1).max(2048),
    schema_digest: z.string().regex(SHA256_DIGEST),
    payload_schema: JsonObjectSchema,
    status: z.enum(["active", "retired"]),
    owner: SafeLocalIdentifierSchema
  })
  .strict();
export type TypeRegistration = z.infer<typeof TypeRegistrationSchema>;

export const OperationRegistrationSchema = z
  .object({
    operation_type: SafeNamespacedIdentifierSchema,
    command_schema_version: z.number().int().positive(),
    command_schema_ref: z.string().min(1).max(2048),
    command_schema_digest: z.string().regex(SHA256_DIGEST),
    command_schema: JsonObjectSchema,
    allowed_result_types: z.array(SafeNamespacedIdentifierSchema),
    handler_id: SafeLocalIdentifierSchema,
    handler_version: z.number().int().positive(),
    authorization_action: SafeNamespacedIdentifierSchema,
    approval_required: z.boolean(),
    status: z.enum(["active", "retired"])
  })
  .strict();
export type OperationRegistration = z.infer<
  typeof OperationRegistrationSchema
>;

export const DeclaredEffectSchema = z
  .object({
    result_type: SafeNamespacedIdentifierSchema,
    schema_version: z.number().int().positive(),
    schema_ref: z.string().min(1).max(2048),
    target: RuntimeSubjectSchema,
    payload: RuntimePayloadSchema
  })
  .strict();
export type DeclaredEffect = z.infer<typeof DeclaredEffectSchema>;

export const CanonicalCommandEnvelopeSchema = z
  .object({
    canonicalization_version: z.literal("jcs-rfc8785-v1"),
    operation_type: SafeNamespacedIdentifierSchema,
    operation_schema_version: z.number().int().positive(),
    work_item_id: z.string().uuid(),
    action_revision: z.number().int().positive(),
    target: RuntimeSubjectSchema,
    arguments: RuntimePayloadSchema,
    declared_effects: z.array(DeclaredEffectSchema)
  })
  .strict();
export type CanonicalCommandEnvelope = z.infer<
  typeof CanonicalCommandEnvelopeSchema
>;

export const CommandDigestSchema = z
  .string()
  .regex(
    PREFIXED_SHA256_DIGEST,
    "Command digest must use the sha256:<lowercase hex> format."
  );
export type CommandDigest = z.infer<typeof CommandDigestSchema>;

export const TypedRecordEnvelopeSchema = z
  .object({
    id: z.string().uuid(),
    kind: PayloadRecordKindSchema,
    type: SafeNamespacedIdentifierSchema,
    schema_version: z.number().int().positive(),
    schema_ref: z.string().min(1).max(2048),
    stream_id: SafeLocalIdentifierSchema,
    record_sequence: z.number().int().positive(),
    subject: RuntimeSubjectSchema,
    payload: RuntimePayloadSchema,
    created_at: z.string().datetime()
  })
  .strict();
export type TypedRecordEnvelope = z.infer<typeof TypedRecordEnvelopeSchema>;

export const ActionTriggerSchema = z
  .object({
    type: z.enum(["event", "schedule", "user_request", "retry", "internal"]),
    ref: z.union([RecordRefSchema, ExternalRefSchema])
  })
  .strict();
export type ActionTrigger = z.infer<typeof ActionTriggerSchema>;

export const ActionAttributionSchema = z
  .object({
    id: z.string().uuid(),
    work_item_id: z.string().uuid(),
    operation_type: SafeNamespacedIdentifierSchema,
    handler_id: SafeLocalIdentifierSchema,
    handler_version: z.number().int().positive(),
    command_context: TrustedCommandContextSchema,
    subject: RuntimeSubjectSchema,
    trigger: ActionTriggerSchema,
    causation_ref: RecordRefSchema,
    correlation_id: SafeLocalIdentifierSchema,
    request_id: SafeLocalIdentifierSchema,
    tool_invocation_id: SafeLocalIdentifierSchema.optional(),
    canonicalization_version: z.literal("jcs-rfc8785-v1"),
    input_refs: z.array(RecordRefSchema),
    command_digest: CommandDigestSchema,
    started_at: z.string().datetime(),
    finished_at: z.string().datetime(),
    outcome: z.enum(["succeeded", "failed", "cancelled"]),
    result_refs: z.array(RecordRefSchema)
  })
  .strict();
export type ActionAttribution = z.infer<typeof ActionAttributionSchema>;

export const ActionAttributionPayloadSchema = ActionAttributionSchema.omit({
  id: true,
  command_context: true
});
export type ActionAttributionPayload = z.infer<
  typeof ActionAttributionPayloadSchema
>;

export const ApprovalAttributionSchema = z
  .object({
    id: z.string().uuid(),
    work_item_id: z.string().uuid(),
    operation_type: SafeNamespacedIdentifierSchema,
    action_revision: z.number().int().positive(),
    command_digest: CommandDigestSchema,
    approved_by_principal_ref: z
      .string()
      .min(13)
      .max(512)
      .regex(/^principal:\/\/[A-Za-z0-9][A-Za-z0-9._:@/-]*$/),
    effective_approver: EffectiveActorSchema,
    approver_authorization: AuthorizationEvidenceSchema,
    decision: z.enum(["approved", "rejected"]),
    decided_at: z.string().datetime()
  })
  .strict();
export type ApprovalAttribution = z.infer<typeof ApprovalAttributionSchema>;

export const ApprovalAttributionPayloadSchema = ApprovalAttributionSchema.omit({
  id: true
});
export type ApprovalAttributionPayload = z.infer<
  typeof ApprovalAttributionPayloadSchema
>;

export const AuthorizationDenialAuditPayloadSchema = z
  .object({
    request_id: SafeLocalIdentifierSchema,
    decision_id: SafeLocalIdentifierSchema,
    policy_version: SafeLocalIdentifierSchema,
    reason_codes: z.array(SafeNamespacedIdentifierSchema)
  })
  .strict();

export const IdempotencyConflictAuditPayloadSchema = z
  .object({
    operation_type: SafeNamespacedIdentifierSchema
  })
  .strict();

export const IdempotencyAbandonedAuditPayloadSchema = z
  .object({
    operation_type: SafeNamespacedIdentifierSchema,
    reason: z.literal("claim_lease_expired")
  })
  .strict();

export const OperationAuditPayloadSchema = z
  .object({
    outcome: z.enum(["succeeded", "failed", "cancelled"]),
    authorization_decision_id: SafeLocalIdentifierSchema.optional(),
    result_refs: z.array(RecordRefSchema).optional()
  })
  .strict();
