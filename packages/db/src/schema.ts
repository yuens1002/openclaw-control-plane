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

export const vendingOpportunities = pgTable(
  "vending_opportunities",
  {
    id: uuid("id").primaryKey(),
    locationName: text("location_name").notNull(),
    businessType: text("business_type"),
    address: text("address"),
    contactName: text("contact_name"),
    contactRole: text("contact_role"),
    email: text("email"),
    phone: text("phone"),
    currentMachineStatus: text("current_machine_status"),
    footTrafficSignal: text("foot_traffic_signal"),
    placementFit: text("placement_fit"),
    commissionTerms: text("commission_terms"),
    machineRequirements: text("machine_requirements"),
    decisionMakerStatus: text("decision_maker_status"),
    stage: text("stage").notNull().default("discovered"),
    riskNotes: text("risk_notes"),
    sourceRefs: text("source_refs").array().notNull(),
    lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
    nextFollowupAt: timestamp("next_followup_at", { withTimezone: true }),
    source: text("source").notNull(),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    duplicateLeadIdx: uniqueIndex("vending_leads_company_location_idx").on(
      table.locationName,
      table.address
    )
  })
);

export const vendingCallTranscripts = pgTable("vending_call_transcripts", {
  id: uuid("id").primaryKey(),
  opportunityId: uuid("opportunity_id").references(() => vendingOpportunities.id),
  transcript: text("transcript").notNull(),
  summary: text("summary"),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const vendingFollowups = pgTable("vending_followups", {
  id: uuid("id").primaryKey().defaultRandom(),
  opportunityId: uuid("opportunity_id")
    .notNull()
    .references(() => vendingOpportunities.id),
  callRecordId: uuid("call_record_id").references(() => vendingCallTranscripts.id),
  channel: text("channel").notNull(),
  draftSubject: text("draft_subject").notNull(),
  draftBody: text("draft_body").notNull(),
  approvalRequestId: uuid("approval_request_id").references(() => approvalRequests.id),
  status: text("status").notNull().default("drafted"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});
