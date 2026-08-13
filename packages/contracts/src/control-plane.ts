import { z } from "zod";

export const DomainSchema = z.enum(["vending"]);
export type Domain = z.infer<typeof DomainSchema>;

export const WorkItemStatusSchema = z.enum([
  "captured",
  "classified",
  "planned",
  "dispatched",
  "running",
  "awaiting_approval",
  "awaiting_external",
  "completed",
  "failed",
  "canceled"
]);
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>;

export const WorkerRunStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "retrying",
  "blocked"
]);
export type WorkerRunStatus = z.infer<typeof WorkerRunStatusSchema>;

export const ApprovalStatusSchema = z.enum([
  "not_required",
  "pending",
  "approved",
  "rejected",
  "expired",
  "superseded"
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ArtifactKindSchema = z.enum([
  "briefing",
  "lead_snapshot",
  "call_transcript",
  "call_summary",
  "follow_up_draft",
  "audit_note"
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const AuditActionSchema = z.enum([
  "event_ingested",
  "work_item_created",
  "worker_run_started",
  "approval_requested",
  "approval_resolved",
  "pipeline_paused",
  "pipeline_resumed",
  "run_retried",
  "artifact_created",
  "opportunity_updated"
]);
export type AuditAction = z.infer<typeof AuditActionSchema>;

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema)
  ])
);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const WorkItemSchema = z.object({
  id: z.string().uuid(),
  domain: DomainSchema,
  status: WorkItemStatusSchema,
  subject_id: z.string().min(1),
  subject_type: z.string().min(1),
  source_event_id: z.string().uuid().nullable(),
  idempotency_key: z.string().min(8),
  current_owner: z.enum(["user", "agent", "worker", "external"]),
  next_action: z.string().min(1).nullable(),
  last_evidence: z.string().min(1).nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  next_run_at: z.string().datetime().nullable()
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

export const WorkerRunSchema = z.object({
  id: z.string().uuid(),
  work_item_id: z.string().uuid(),
  worker_id: z.string().min(1),
  status: WorkerRunStatusSchema,
  attempt: z.number().int().positive(),
  started_at: z.string().datetime().nullable(),
  finished_at: z.string().datetime().nullable(),
  error_message: z.string().nullable()
});
export type WorkerRun = z.infer<typeof WorkerRunSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string().uuid(),
  work_item_id: z.string().uuid(),
  status: ApprovalStatusSchema,
  requested_by: z.string().min(1),
  reason: z.string().min(1),
  payload: JsonValueSchema,
  resolved_by: z.string().min(1).nullable(),
  resolved_at: z.string().datetime().nullable()
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ArtifactSchema = z.object({
  artifact_id: z.string().uuid(),
  type: ArtifactKindSchema,
  domain: DomainSchema,
  title: z.string().min(1),
  source_event_ids: z.array(z.string().uuid()),
  source_refs: z.array(z.string()),
  approval_state: ApprovalStatusSchema,
  content_uri: z.string().min(1),
  summary: z.string().min(1),
  created_at: z.string().datetime()
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const AuditEventSchema = z.object({
  audit_id: z.string().uuid(),
  occurred_at: z.string().datetime(),
  actor: z.string().min(1),
  domain: DomainSchema,
  action: AuditActionSchema,
  target: z.object({
    type: z.string().min(1),
    id: z.string().min(1).nullable()
  }),
  source_event_id: z.string().uuid().nullable(),
  approval_id: z.string().uuid().nullable(),
  summary: z.string().min(1),
  diff: JsonValueSchema
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const PipelineStateSchema = z.object({
  domain: DomainSchema,
  paused: z.boolean(),
  active_opportunities: z.number().int().nonnegative(),
  followups_due_today: z.number().int().nonnegative(),
  blocked_items: z.number().int().nonnegative(),
  pending_approvals: z.number().int().nonnegative(),
  recent_activity: z.array(z.string()),
  last_audit_event_at: z.string().datetime().nullable()
});
export type PipelineState = z.infer<typeof PipelineStateSchema>;
