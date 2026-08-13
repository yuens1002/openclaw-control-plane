import {
  boolean,
  integer,
  jsonb,
  pgTable,
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

export const events = pgTable(
  "events",
  {
    eventId: uuid("event_id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull(),
    eventType: text("event_type").notNull(),
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
