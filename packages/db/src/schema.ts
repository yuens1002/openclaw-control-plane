import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const domains = pgTable("domains", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const pipelines = pgTable("pipelines", {
  id: text("id").primaryKey(),
  domain: text("domain")
    .notNull()
    .references(() => domains.id),
  displayName: text("display_name").notNull(),
  paused: boolean("paused").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const workers = pgTable("workers", {
  id: text("id").primaryKey(),
  domain: text("domain")
    .notNull()
    .references(() => domains.id),
  displayName: text("display_name").notNull(),
  status: text("status").notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const typeRegistrations = pgTable(
  "type_registrations",
  {
    kind: text("kind").notNull(),
    type: text("type").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    schemaRef: text("schema_ref").notNull(),
    schemaDigest: text("schema_digest").notNull(),
    payloadSchema: jsonb("payload_schema").notNull(),
    status: text("status").notNull(),
    owner: text("owner").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true })
  },
  (table) => [primaryKey({ columns: [table.kind, table.type, table.schemaVersion] })]
);

export const operationRegistrations = pgTable(
  "operation_registrations",
  {
    operationType: text("operation_type").notNull(),
    commandSchemaVersion: integer("command_schema_version").notNull(),
    commandSchemaRef: text("command_schema_ref").notNull(),
    commandSchemaDigest: text("command_schema_digest").notNull(),
    commandSchema: jsonb("command_schema").notNull(),
    allowedResultTypes: text("allowed_result_types").array().notNull(),
    handlerId: text("handler_id").notNull(),
    handlerVersion: integer("handler_version").notNull(),
    authorizationAction: text("authorization_action").notNull(),
    approvalRequired: boolean("approval_required").notNull().default(false),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true })
  },
  (table) => [primaryKey({ columns: [table.operationType, table.commandSchemaVersion] })]
);

export const recordStreams = pgTable("record_streams", {
  streamId: text("stream_id").primaryKey(),
  nextRecordSequence: bigint("next_record_sequence", { mode: "number" }).notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const runtimeRecords = pgTable(
  "runtime_records",
  {
    recordId: uuid("record_id").primaryKey().defaultRandom(),
    streamId: text("stream_id")
      .notNull()
      .references(() => recordStreams.streamId),
    recordSequence: bigint("record_sequence", { mode: "number" }).notNull(),
    kind: text("kind").notNull(),
    type: text("type").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    schemaRef: text("schema_ref").notNull(),
    operationType: text("operation_type"),
    commandContext: jsonb("command_context").notNull(),
    authenticatedPrincipalRef: text("authenticated_principal_ref").notNull(),
    effectiveActor: jsonb("effective_actor").notNull(),
    subject: jsonb("subject").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("runtime_records_stream_sequence_idx").on(table.streamId, table.recordSequence),
    index("runtime_records_kind_type_idx").on(table.kind, table.type)
  ]
);

export const events = pgTable(
  "events",
  {
    eventId: uuid("event_id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull(),
    eventType: text("event_type").notNull(),
    registeredType: text("registered_type").notNull().default("legacy.event"),
    schemaVersion: integer("schema_version").notNull().default(1),
    schemaRef: text("schema_ref").notNull().default("legacy://schemas/event/v1"),
    runtimeRecordId: uuid("runtime_record_id")
      .notNull()
      .unique()
      .references(() => runtimeRecords.recordId),
    source: text("source").notNull(),
    domain: text("domain")
      .notNull()
      .references(() => domains.id),
    actor: jsonb("actor").notNull(),
    subject: jsonb("subject").notNull(),
    sensitivity: text("sensitivity").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    idempotencyKeyIdx: uniqueIndex("events_idempotency_key_idx").on(table.idempotencyKey)
  })
);

export const workItems = pgTable("work_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  domain: text("domain")
    .notNull()
    .references(() => domains.id),
  status: text("status").notNull(),
  workType: text("work_type").notNull().default("legacy.work_item"),
  schemaVersion: integer("schema_version").notNull().default(1),
  schemaRef: text("schema_ref").notNull().default("legacy://schemas/work-item/v1"),
  runtimeRecordId: uuid("runtime_record_id")
    .notNull()
    .unique()
    .references(() => runtimeRecords.recordId),
  subjectId: text("subject_id").notNull(),
  subjectType: text("subject_type").notNull(),
  sourceEventId: uuid("source_event_id").references(() => events.eventId),
  idempotencyKey: text("idempotency_key").notNull(),
  currentOwner: text("current_owner").notNull(),
  nextAction: text("next_action"),
  lastEvidence: text("last_evidence"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  nextRunAt: timestamp("next_run_at", { withTimezone: true })
}, (table) => ({
  idempotencyKeyIdx: uniqueIndex("work_items_idempotency_key_idx").on(table.idempotencyKey)
}));

export const workerRuns = pgTable("worker_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workItemId: uuid("work_item_id")
    .notNull()
    .references(() => workItems.id),
  workerId: text("worker_id")
    .notNull()
    .references(() => workers.id),
  status: text("status").notNull(),
  operationType: text("operation_type").notNull().default("legacy.worker_run"),
  operationSchemaVersion: integer("operation_schema_version").notNull().default(1),
  authenticatedPrincipalRef: text("authenticated_principal_ref")
    .notNull()
    .default("principal://legacy/system"),
  runtimeRecordId: uuid("runtime_record_id")
    .notNull()
    .unique()
    .references(() => runtimeRecords.recordId),
  attempt: integer("attempt").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  errorMessage: text("error_message")
});

export const approvalRequests = pgTable("approval_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  workItemId: uuid("work_item_id")
    .notNull()
    .references(() => workItems.id),
  status: text("status").notNull(),
  operationType: text("operation_type").notNull().default("legacy.approval.resolve"),
  canonicalizationVersion: text("canonicalization_version").notNull().default("legacy-v1"),
  commandDigest: text("command_digest").notNull().default("legacy-unavailable"),
  authenticatedPrincipalRef: text("authenticated_principal_ref")
    .notNull()
    .default("principal://legacy/system"),
  runtimeRecordId: uuid("runtime_record_id")
    .notNull()
    .unique()
    .references(() => runtimeRecords.recordId),
  requestedBy: text("requested_by").notNull(),
  reason: text("reason").notNull(),
  payload: jsonb("payload").notNull(),
  resolvedBy: text("resolved_by"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true })
});

export const artifacts = pgTable("artifacts", {
  artifactId: uuid("artifact_id").primaryKey().defaultRandom(),
  workItemId: uuid("work_item_id").references(() => workItems.id),
  type: text("type").notNull(),
  registeredType: text("registered_type").notNull().default("legacy.artifact"),
  schemaVersion: integer("schema_version").notNull().default(1),
  schemaRef: text("schema_ref").notNull().default("legacy://schemas/artifact/v1"),
  authenticatedPrincipalRef: text("authenticated_principal_ref")
    .notNull()
    .default("principal://legacy/system"),
  runtimeRecordId: uuid("runtime_record_id")
    .notNull()
    .unique()
    .references(() => runtimeRecords.recordId),
  domain: text("domain")
    .notNull()
    .references(() => domains.id),
  title: text("title").notNull(),
  sourceEventIds: uuid("source_event_ids").array().notNull(),
  sourceRefs: text("source_refs").array().notNull(),
  approvalState: text("approval_state").notNull(),
  contentUri: text("content_uri").notNull(),
  summary: text("summary").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const auditLog = pgTable("audit_log", {
  auditId: uuid("audit_id").primaryKey().defaultRandom(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  actor: text("actor").notNull(),
  operationType: text("operation_type").notNull().default("legacy.audit"),
  authenticatedPrincipalRef: text("authenticated_principal_ref")
    .notNull()
    .default("principal://legacy/system"),
  runtimeRecordId: uuid("runtime_record_id")
    .notNull()
    .unique()
    .references(() => runtimeRecords.recordId),
  action: text("action").notNull(),
  domain: text("domain")
    .notNull()
    .references(() => domains.id),
  target: jsonb("target").notNull(),
  sourceEventId: uuid("source_event_id").references(() => events.eventId),
  approvalId: uuid("approval_id"),
  summary: text("summary").notNull(),
  diff: jsonb("diff").notNull()
});

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  domain: text("domain").notNull().references(() => domains.id),
  workItemId: uuid("work_item_id").references(() => workItems.id),
  status: text("status").notNull(),
  title: text("title").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const commitments = pgTable("commitments", {
  id: uuid("id").primaryKey().defaultRandom(),
  domain: text("domain").notNull().references(() => domains.id),
  workItemId: uuid("work_item_id").references(() => workItems.id),
  description: text("description").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  sourceEventId: uuid("source_event_id").references(() => events.eventId),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const toolInvocations = pgTable("tool_invocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  toolName: text("tool_name").notNull(),
  domain: text("domain").references(() => domains.id),
  actor: text("actor").notNull(),
  operationType: text("operation_type").notNull().default("legacy.tool.invoke"),
  authenticatedPrincipalRef: text("authenticated_principal_ref").notNull().default("principal://legacy/system"),
  runtimeRecordId: uuid("runtime_record_id").notNull().unique().references(() => runtimeRecords.recordId),
  idempotencyKey: text("idempotency_key"),
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const results = pgTable("results", {
  resultId: uuid("result_id").primaryKey().defaultRandom(),
  runtimeRecordId: uuid("runtime_record_id").notNull().unique().references(() => runtimeRecords.recordId),
  actionAttemptRecordId: uuid("action_attempt_record_id").notNull().references(() => runtimeRecords.recordId),
  resultType: text("result_type").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  schemaRef: text("schema_ref").notNull(),
  subject: jsonb("subject").notNull(),
  payload: jsonb("payload").notNull(),
  outcome: text("outcome").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const recordEdges = pgTable(
  "record_edges",
  {
    fromRecordId: uuid("from_record_id").notNull().references(() => runtimeRecords.recordId),
    relation: text("relation").notNull(),
    ordinal: integer("ordinal").notNull().default(0),
    toRecordId: uuid("to_record_id").notNull().references(() => runtimeRecords.recordId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.fromRecordId, table.relation, table.ordinal] })]
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    authenticatedPrincipalRef: text("authenticated_principal_ref").notNull(),
    operationType: text("operation_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    canonicalizationVersion: text("canonicalization_version").notNull(),
    commandDigest: text("command_digest").notNull(),
    status: text("status").notNull(),
    reservedOperationId: uuid("reserved_operation_id").notNull(),
    operationRecordId: uuid("operation_record_id").references(() => runtimeRecords.recordId),
    resultRecordIds: uuid("result_record_ids").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.authenticatedPrincipalRef, table.operationType, table.idempotencyKey] })]
);

export const projectionStates = pgTable(
  "projection_states",
  {
    projectionId: uuid("projection_id").primaryKey().defaultRandom(),
    streamId: text("stream_id").notNull().references(() => recordStreams.streamId),
    projectionType: text("projection_type").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    projectionVersion: integer("projection_version").notNull(),
    state: jsonb("state").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("projection_states_identity_idx").on(
    table.streamId,
    table.projectionType,
    table.subjectType,
    table.subjectId,
    table.projectionVersion
  )]
);

export const projectionCheckpoints = pgTable("projection_checkpoints", {
  projectionId: uuid("projection_id").primaryKey().references(() => projectionStates.projectionId),
  lastRecordSequence: bigint("last_record_sequence", { mode: "number" }).notNull().default(0),
  lastRecordId: uuid("last_record_id").references(() => runtimeRecords.recordId),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
