CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE domains (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pipelines (
  id text PRIMARY KEY,
  domain text NOT NULL REFERENCES domains(id),
  display_name text NOT NULL,
  paused boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workers (
  id text PRIMARY KEY,
  domain text NOT NULL REFERENCES domains(id),
  display_name text NOT NULL,
  status text NOT NULL,
  last_heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO domains (id, display_name) VALUES ('vending', 'Vending');
INSERT INTO pipelines (id, domain, display_name) VALUES ('vending', 'vending', 'Vending pipeline');
INSERT INTO workers (id, domain, display_name, status) VALUES ('vending', 'vending', 'Vending worker', 'pending');

CREATE TABLE events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  event_type text NOT NULL,
  source text NOT NULL,
  domain text NOT NULL REFERENCES domains(id),
  actor jsonb NOT NULL,
  subject jsonb NOT NULL,
  sensitivity text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_domain_created_at_idx
  ON events (domain, created_at DESC);

CREATE TABLE work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL REFERENCES domains(id),
  status text NOT NULL,
  subject_id text NOT NULL,
  subject_type text NOT NULL,
  source_event_id uuid REFERENCES events(event_id),
  idempotency_key text NOT NULL UNIQUE,
  current_owner text NOT NULL,
  next_action text,
  last_evidence text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  next_run_at timestamptz
);

CREATE INDEX work_items_domain_status_idx
  ON work_items (domain, status);

CREATE TABLE worker_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid NOT NULL REFERENCES work_items(id),
  worker_id text NOT NULL REFERENCES workers(id),
  status text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  started_at timestamptz,
  finished_at timestamptz,
  error_message text
);

CREATE INDEX worker_runs_work_item_id_idx
  ON worker_runs (work_item_id);

CREATE TABLE approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid NOT NULL REFERENCES work_items(id),
  status text NOT NULL,
  requested_by text NOT NULL,
  reason text NOT NULL,
  payload jsonb NOT NULL,
  resolved_by text,
  resolved_at timestamptz
);

CREATE INDEX approval_requests_status_idx
  ON approval_requests (status);

CREATE TABLE artifacts (
  artifact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid REFERENCES work_items(id),
  type text NOT NULL,
  domain text NOT NULL REFERENCES domains(id),
  title text NOT NULL,
  source_event_ids uuid[] NOT NULL DEFAULT '{}',
  source_refs text[] NOT NULL DEFAULT '{}',
  approval_state text NOT NULL,
  content_uri text NOT NULL,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX artifacts_work_item_id_idx
  ON artifacts (work_item_id);

CREATE TABLE audit_log (
  audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  domain text NOT NULL REFERENCES domains(id),
  target jsonb NOT NULL,
  source_event_id uuid REFERENCES events(event_id),
  approval_id uuid,
  summary text NOT NULL,
  diff jsonb NOT NULL
);

CREATE INDEX audit_log_domain_occurred_at_idx
  ON audit_log (domain, occurred_at DESC);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL REFERENCES domains(id),
  work_item_id uuid REFERENCES work_items(id),
  status text NOT NULL,
  title text NOT NULL,
  due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL REFERENCES domains(id),
  work_item_id uuid REFERENCES work_items(id),
  description text NOT NULL,
  due_at timestamptz,
  source_event_id uuid REFERENCES events(event_id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tool_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name text NOT NULL,
  domain text REFERENCES domains(id),
  actor text NOT NULL,
  idempotency_key text,
  input jsonb NOT NULL,
  output jsonb,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vending_opportunities (
  id uuid PRIMARY KEY,
  location_name text NOT NULL,
  business_type text,
  address text,
  contact_name text,
  contact_role text,
  email text,
  phone text,
  current_machine_status text,
  foot_traffic_signal text,
  placement_fit text,
  commission_terms text,
  machine_requirements text,
  decision_maker_status text,
  stage text NOT NULL DEFAULT 'discovered',
  risk_notes text,
  source_refs text[] NOT NULL DEFAULT '{}',
  last_contacted_at timestamptz,
  next_followup_at timestamptz,
  source text NOT NULL,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX vending_opportunities_duplicate_location_idx
  ON vending_opportunities (lower(location_name), COALESCE(address, ''));

CREATE TABLE vending_call_transcripts (
  id uuid PRIMARY KEY,
  opportunity_id uuid REFERENCES vending_opportunities(id),
  transcript text NOT NULL,
  summary text,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vending_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES vending_opportunities(id),
  call_record_id uuid REFERENCES vending_call_transcripts(id),
  channel text NOT NULL,
  draft_subject text NOT NULL,
  draft_body text NOT NULL,
  approval_request_id uuid REFERENCES approval_requests(id),
  status text NOT NULL DEFAULT 'drafted',
  created_at timestamptz NOT NULL DEFAULT now()
);
