CREATE TABLE type_registrations (
  kind text NOT NULL,
  type text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  schema_ref text NOT NULL,
  schema_digest text NOT NULL,
  payload_schema jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  owner text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  PRIMARY KEY (kind, type, schema_version)
);

CREATE TABLE operation_registrations (
  operation_type text NOT NULL,
  command_schema_version integer NOT NULL CHECK (command_schema_version > 0),
  command_schema_ref text NOT NULL,
  command_schema_digest text NOT NULL,
  command_schema jsonb NOT NULL,
  allowed_result_types text[] NOT NULL DEFAULT '{}',
  handler_id text NOT NULL,
  handler_version integer NOT NULL CHECK (handler_version > 0),
  authorization_action text NOT NULL,
  approval_required boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  PRIMARY KEY (operation_type, command_schema_version)
);

CREATE TABLE record_streams (
  stream_id text PRIMARY KEY,
  next_record_sequence bigint NOT NULL DEFAULT 1 CHECK (next_record_sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runtime_records (
  record_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id text NOT NULL REFERENCES record_streams(stream_id),
  record_sequence bigint NOT NULL CHECK (record_sequence > 0),
  kind text NOT NULL,
  type text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  schema_ref text NOT NULL,
  operation_type text,
  command_context jsonb NOT NULL,
  authenticated_principal_ref text NOT NULL,
  effective_actor jsonb NOT NULL,
  subject jsonb NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stream_id, record_sequence)
);

CREATE INDEX runtime_records_kind_type_idx ON runtime_records (kind, type);

CREATE FUNCTION reject_runtime_record_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'runtime_records is append-only';
END;
$$;

CREATE TRIGGER runtime_records_append_only
BEFORE UPDATE OR DELETE ON runtime_records
FOR EACH ROW EXECUTE FUNCTION reject_runtime_record_mutation();

-- Call this inside the same transaction that writes runtime_records. The row
-- lock is held until commit, so same-stream allocation and commit are ordered.
CREATE FUNCTION allocate_runtime_record_sequence(requested_stream_id text)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  allocated_sequence bigint;
BEGIN
  INSERT INTO record_streams (stream_id)
  VALUES (requested_stream_id)
  ON CONFLICT (stream_id) DO NOTHING;

  SELECT next_record_sequence
    INTO allocated_sequence
    FROM record_streams
   WHERE stream_id = requested_stream_id
     FOR UPDATE;

  UPDATE record_streams
     SET next_record_sequence = allocated_sequence + 1,
         updated_at = now()
   WHERE stream_id = requested_stream_id;

  RETURN allocated_sequence;
END;
$$;

ALTER TABLE events
  ADD COLUMN registered_type text NOT NULL DEFAULT 'legacy.event',
  ADD COLUMN schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN schema_ref text NOT NULL DEFAULT 'legacy://schemas/event/v1',
  ADD COLUMN runtime_record_id uuid;

ALTER TABLE work_items
  ADD COLUMN work_type text NOT NULL DEFAULT 'legacy.work_item',
  ADD COLUMN schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN schema_ref text NOT NULL DEFAULT 'legacy://schemas/work-item/v1',
  ADD COLUMN runtime_record_id uuid;

ALTER TABLE worker_runs
  ADD COLUMN operation_type text NOT NULL DEFAULT 'legacy.worker_run',
  ADD COLUMN operation_schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN authenticated_principal_ref text NOT NULL DEFAULT 'principal://legacy/system',
  ADD COLUMN runtime_record_id uuid;

ALTER TABLE approval_requests
  ADD COLUMN operation_type text NOT NULL DEFAULT 'legacy.approval.resolve',
  ADD COLUMN canonicalization_version text NOT NULL DEFAULT 'legacy-v1',
  ADD COLUMN command_digest text NOT NULL DEFAULT 'legacy-unavailable',
  ADD COLUMN authenticated_principal_ref text NOT NULL DEFAULT 'principal://legacy/system',
  ADD COLUMN runtime_record_id uuid;

ALTER TABLE artifacts
  ADD COLUMN registered_type text NOT NULL DEFAULT 'legacy.artifact',
  ADD COLUMN schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN schema_ref text NOT NULL DEFAULT 'legacy://schemas/artifact/v1',
  ADD COLUMN authenticated_principal_ref text NOT NULL DEFAULT 'principal://legacy/system',
  ADD COLUMN runtime_record_id uuid;

ALTER TABLE audit_log
  ADD COLUMN operation_type text NOT NULL DEFAULT 'legacy.audit',
  ADD COLUMN authenticated_principal_ref text NOT NULL DEFAULT 'principal://legacy/system',
  ADD COLUMN runtime_record_id uuid;

ALTER TABLE tool_invocations
  ADD COLUMN operation_type text NOT NULL DEFAULT 'legacy.tool.invoke',
  ADD COLUMN authenticated_principal_ref text NOT NULL DEFAULT 'principal://legacy/system',
  ADD COLUMN runtime_record_id uuid;

INSERT INTO type_registrations
  (kind, type, schema_version, schema_ref, schema_digest, payload_schema, status, owner, retired_at)
VALUES
  ('event', 'legacy.event', 1, 'legacy://schemas/event/v1', '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', '{}'::jsonb, 'retired', 'platform', now()),
  ('work_item', 'legacy.work_item', 1, 'legacy://schemas/work-item/v1', '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', '{}'::jsonb, 'retired', 'platform', now()),
  ('result', 'legacy.result', 1, 'legacy://schemas/result/v1', '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', '{}'::jsonb, 'retired', 'platform', now()),
  ('artifact', 'legacy.artifact', 1, 'legacy://schemas/artifact/v1', '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', '{}'::jsonb, 'retired', 'platform', now());

INSERT INTO operation_registrations
  (operation_type, command_schema_version, command_schema_ref, command_schema_digest,
   command_schema, handler_id, handler_version, authorization_action, approval_required, status, retired_at)
VALUES
  ('legacy.worker_run', 1, 'legacy://schemas/worker-run-command/v1', '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', '{}'::jsonb, 'legacy-handler', 1, 'legacy.execute', false, 'retired', now()),
  ('legacy.approval.resolve', 1, 'legacy://schemas/approval-command/v1', '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', '{}'::jsonb, 'legacy-handler', 1, 'legacy.approve', false, 'retired', now()),
  ('legacy.audit', 1, 'legacy://schemas/audit-command/v1', '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', '{}'::jsonb, 'legacy-handler', 1, 'legacy.audit', false, 'retired', now()),
  ('legacy.tool.invoke', 1, 'legacy://schemas/tool-command/v1', '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', '{}'::jsonb, 'legacy-handler', 1, 'legacy.tool.invoke', false, 'retired', now());

UPDATE events SET runtime_record_id = gen_random_uuid() WHERE runtime_record_id IS NULL;
UPDATE work_items SET runtime_record_id = gen_random_uuid() WHERE runtime_record_id IS NULL;
UPDATE worker_runs SET runtime_record_id = gen_random_uuid() WHERE runtime_record_id IS NULL;
UPDATE approval_requests SET runtime_record_id = gen_random_uuid() WHERE runtime_record_id IS NULL;
UPDATE artifacts SET runtime_record_id = gen_random_uuid() WHERE runtime_record_id IS NULL;
UPDATE audit_log SET runtime_record_id = gen_random_uuid() WHERE runtime_record_id IS NULL;
UPDATE tool_invocations SET runtime_record_id = gen_random_uuid() WHERE runtime_record_id IS NULL;

CREATE TEMP TABLE legacy_runtime_record_stage AS
SELECT
  e.runtime_record_id AS record_id,
  'legacy-domain:' || encode(digest(e.domain, 'sha256'), 'hex') AS stream_id,
  'event'::text AS kind,
  e.registered_type AS type,
  e.schema_version,
  e.schema_ref,
  NULL::text AS operation_type,
  jsonb_build_object(
    'authenticated_principal_ref', 'principal://legacy/system',
    'effective_actor', jsonb_build_object('type', 'system', 'id', 'legacy-migration'),
    'request_origin', 'internal',
    'authorization', jsonb_build_object('decision_id', 'legacy', 'action', 'legacy.ingest', 'result', 'allowed', 'policy_version', 'legacy')
  ) AS command_context,
  'principal://legacy/system'::text AS authenticated_principal_ref,
  jsonb_build_object('type', 'system', 'id', 'legacy-migration') AS effective_actor,
  jsonb_build_object('type', 'legacy.event', 'id', e.event_id::text) AS subject,
  (e.payload - ARRAY['actor', 'effective_actor', 'authenticated_principal_ref', 'on_behalf_of_principal_ref', 'authorization', 'command_context'])
    || jsonb_build_object('legacy_subject', e.subject, 'legacy_caller', e.actor) AS payload,
  e.occurred_at,
  e.created_at AS recorded_at
FROM events e
UNION ALL
SELECT
  w.runtime_record_id,
  'legacy-domain:' || encode(digest(w.domain, 'sha256'), 'hex'),
  'work_item',
  w.work_type,
  w.schema_version,
  w.schema_ref,
  NULL::text,
  jsonb_build_object('authenticated_principal_ref', 'principal://legacy/system', 'effective_actor', jsonb_build_object('type', 'system', 'id', 'legacy-migration'), 'request_origin', 'internal', 'authorization', jsonb_build_object('decision_id', 'legacy', 'action', 'legacy.work', 'result', 'allowed', 'policy_version', 'legacy')),
  'principal://legacy/system',
  jsonb_build_object('type', 'system', 'id', 'legacy-migration'),
  jsonb_build_object('type', 'legacy.work_item', 'id', w.id::text),
  jsonb_build_object('status', w.status, 'current_owner', w.current_owner, 'next_action', w.next_action, 'last_evidence', w.last_evidence, 'legacy_subject', jsonb_build_object('type', w.subject_type, 'id', w.subject_id)),
  w.created_at,
  w.created_at
FROM work_items w
UNION ALL
SELECT
  wr.runtime_record_id,
  'legacy-domain:' || encode(digest(w.domain, 'sha256'), 'hex'),
  'action_attempt',
  wr.operation_type,
  wr.operation_schema_version,
  'legacy://schemas/worker-run-command/v1',
  wr.operation_type,
  jsonb_build_object('authenticated_principal_ref', 'principal://legacy/system', 'effective_actor', jsonb_build_object('type', 'system', 'id', 'legacy-migration'), 'request_origin', 'internal', 'authorization', jsonb_build_object('decision_id', 'legacy', 'action', 'legacy.execute', 'result', 'allowed', 'policy_version', 'legacy')),
  'principal://legacy/system',
  jsonb_build_object('type', 'system', 'id', 'legacy-migration'),
  jsonb_build_object('type', 'legacy.work_item', 'id', wr.work_item_id::text),
  jsonb_build_object('status', wr.status, 'attempt', wr.attempt, 'error_message', wr.error_message),
  COALESCE(wr.started_at, wr.finished_at, w.created_at),
  COALESCE(wr.finished_at, wr.started_at, w.created_at)
FROM worker_runs wr
JOIN work_items w ON w.id = wr.work_item_id
UNION ALL
SELECT
  ar.runtime_record_id,
  'legacy-domain:' || encode(digest(w.domain, 'sha256'), 'hex'),
  'approval',
  ar.operation_type,
  1,
  'legacy://schemas/approval-command/v1',
  ar.operation_type,
  jsonb_build_object('authenticated_principal_ref', 'principal://legacy/system', 'effective_actor', jsonb_build_object('type', 'system', 'id', 'legacy-migration'), 'request_origin', 'internal', 'authorization', jsonb_build_object('decision_id', 'legacy', 'action', 'legacy.approve', 'result', 'allowed', 'policy_version', 'legacy')),
  'principal://legacy/system',
  jsonb_build_object('type', 'system', 'id', 'legacy-migration'),
  jsonb_build_object('type', 'legacy.work_item', 'id', ar.work_item_id::text),
  jsonb_build_object('status', ar.status, 'reason', ar.reason, 'payload', ar.payload, 'canonicalization_version', ar.canonicalization_version, 'command_digest', ar.command_digest),
  COALESCE(ar.resolved_at, w.created_at),
  COALESCE(ar.resolved_at, w.created_at)
FROM approval_requests ar
JOIN work_items w ON w.id = ar.work_item_id
UNION ALL
SELECT
  a.runtime_record_id,
  'legacy-domain:' || encode(digest(a.domain, 'sha256'), 'hex'),
  'artifact',
  a.registered_type,
  a.schema_version,
  a.schema_ref,
  NULL::text,
  jsonb_build_object('authenticated_principal_ref', 'principal://legacy/system', 'effective_actor', jsonb_build_object('type', 'system', 'id', 'legacy-migration'), 'request_origin', 'internal', 'authorization', jsonb_build_object('decision_id', 'legacy', 'action', 'legacy.artifact', 'result', 'allowed', 'policy_version', 'legacy')),
  'principal://legacy/system',
  jsonb_build_object('type', 'system', 'id', 'legacy-migration'),
  jsonb_build_object('type', 'legacy.artifact', 'id', a.artifact_id::text),
  jsonb_build_object('legacy_type', a.type, 'title', a.title, 'content_uri', a.content_uri, 'summary', a.summary, 'approval_state', a.approval_state),
  a.created_at,
  a.created_at
FROM artifacts a
UNION ALL
SELECT
  al.runtime_record_id,
  'legacy-domain:' || encode(digest(al.domain, 'sha256'), 'hex'),
  'audit_entry',
  al.operation_type,
  1,
  'legacy://schemas/audit-command/v1',
  al.operation_type,
  jsonb_build_object('authenticated_principal_ref', 'principal://legacy/system', 'effective_actor', jsonb_build_object('type', 'system', 'id', 'legacy-migration'), 'request_origin', 'internal', 'authorization', jsonb_build_object('decision_id', 'legacy', 'action', 'legacy.audit', 'result', 'allowed', 'policy_version', 'legacy')),
  'principal://legacy/system',
  jsonb_build_object('type', 'system', 'id', 'legacy-migration'),
  jsonb_build_object('type', 'legacy.audit_entry', 'id', al.audit_id::text),
  jsonb_build_object('legacy_caller', al.actor, 'action', al.action, 'summary', al.summary, 'diff', al.diff, 'legacy_target', al.target),
  al.occurred_at,
  al.occurred_at
FROM audit_log al
UNION ALL
SELECT
  ti.runtime_record_id,
  'legacy-domain:' || encode(digest(COALESCE(ti.domain, 'legacy-global'), 'sha256'), 'hex'),
  'action_attempt',
  ti.operation_type,
  1,
  'legacy://schemas/tool-command/v1',
  ti.operation_type,
  jsonb_build_object('authenticated_principal_ref', 'principal://legacy/system', 'effective_actor', jsonb_build_object('type', 'system', 'id', 'legacy-migration'), 'request_origin', 'internal', 'authorization', jsonb_build_object('decision_id', 'legacy', 'action', 'legacy.tool.invoke', 'result', 'allowed', 'policy_version', 'legacy')),
  'principal://legacy/system',
  jsonb_build_object('type', 'system', 'id', 'legacy-migration'),
  jsonb_build_object('type', 'legacy.tool_invocation', 'id', ti.id::text),
  jsonb_build_object('input', ti.input, 'output', ti.output, 'status', ti.status, 'legacy_caller', ti.actor, 'legacy_tool_name', ti.tool_name),
  ti.created_at,
  ti.created_at
FROM tool_invocations ti;

INSERT INTO record_streams (stream_id, next_record_sequence)
SELECT DISTINCT stream_id, 1 FROM legacy_runtime_record_stage;

INSERT INTO runtime_records
  (record_id, stream_id, record_sequence, kind, type, schema_version, schema_ref,
   operation_type, command_context, authenticated_principal_ref, effective_actor,
   subject, payload, occurred_at, recorded_at)
SELECT
  record_id,
  stream_id,
  row_number() OVER (
    PARTITION BY stream_id
    ORDER BY recorded_at, occurred_at, kind, record_id
  )::bigint,
  kind,
  type,
  schema_version,
  schema_ref,
  operation_type,
  command_context,
  authenticated_principal_ref,
  effective_actor,
  subject,
  payload,
  occurred_at,
  recorded_at
FROM legacy_runtime_record_stage;

UPDATE record_streams rs
   SET next_record_sequence = ordered.next_sequence,
       updated_at = now()
  FROM (
    SELECT stream_id, max(record_sequence) + 1 AS next_sequence
      FROM runtime_records
     GROUP BY stream_id
  ) ordered
 WHERE ordered.stream_id = rs.stream_id;

ALTER TABLE events
  ALTER COLUMN runtime_record_id SET NOT NULL,
  ADD CONSTRAINT events_runtime_record_id_unique UNIQUE (runtime_record_id),
  ADD CONSTRAINT events_runtime_record_id_fk FOREIGN KEY (runtime_record_id) REFERENCES runtime_records(record_id);

ALTER TABLE work_items
  ALTER COLUMN runtime_record_id SET NOT NULL,
  ADD CONSTRAINT work_items_runtime_record_id_unique UNIQUE (runtime_record_id),
  ADD CONSTRAINT work_items_runtime_record_id_fk FOREIGN KEY (runtime_record_id) REFERENCES runtime_records(record_id);

ALTER TABLE worker_runs
  ALTER COLUMN runtime_record_id SET NOT NULL,
  ADD CONSTRAINT worker_runs_runtime_record_id_unique UNIQUE (runtime_record_id),
  ADD CONSTRAINT worker_runs_runtime_record_id_fk FOREIGN KEY (runtime_record_id) REFERENCES runtime_records(record_id);

ALTER TABLE approval_requests
  ALTER COLUMN runtime_record_id SET NOT NULL,
  ADD CONSTRAINT approval_requests_runtime_record_id_unique UNIQUE (runtime_record_id),
  ADD CONSTRAINT approval_requests_runtime_record_id_fk FOREIGN KEY (runtime_record_id) REFERENCES runtime_records(record_id);

ALTER TABLE artifacts
  ALTER COLUMN runtime_record_id SET NOT NULL,
  ADD CONSTRAINT artifacts_runtime_record_id_unique UNIQUE (runtime_record_id),
  ADD CONSTRAINT artifacts_runtime_record_id_fk FOREIGN KEY (runtime_record_id) REFERENCES runtime_records(record_id);

ALTER TABLE audit_log
  ALTER COLUMN runtime_record_id SET NOT NULL,
  ADD CONSTRAINT audit_log_runtime_record_id_unique UNIQUE (runtime_record_id),
  ADD CONSTRAINT audit_log_runtime_record_id_fk FOREIGN KEY (runtime_record_id) REFERENCES runtime_records(record_id);

ALTER TABLE tool_invocations
  ALTER COLUMN runtime_record_id SET NOT NULL,
  ADD CONSTRAINT tool_invocations_runtime_record_id_unique UNIQUE (runtime_record_id),
  ADD CONSTRAINT tool_invocations_runtime_record_id_fk FOREIGN KEY (runtime_record_id) REFERENCES runtime_records(record_id);

CREATE TABLE results (
  result_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_record_id uuid NOT NULL UNIQUE REFERENCES runtime_records(record_id),
  action_attempt_record_id uuid NOT NULL REFERENCES runtime_records(record_id),
  result_type text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  schema_ref text NOT NULL,
  subject jsonb NOT NULL,
  payload jsonb NOT NULL,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE record_edges (
  from_record_id uuid NOT NULL REFERENCES runtime_records(record_id),
  relation text NOT NULL,
  ordinal integer NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  to_record_id uuid NOT NULL REFERENCES runtime_records(record_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_record_id, relation, ordinal)
);

CREATE INDEX record_edges_to_record_id_idx ON record_edges (to_record_id);

CREATE TABLE idempotency_records (
  authenticated_principal_ref text NOT NULL,
  operation_type text NOT NULL,
  idempotency_key text NOT NULL,
  canonicalization_version text NOT NULL,
  command_digest text NOT NULL,
  status text NOT NULL,
  reserved_operation_id uuid NOT NULL,
  claim_token uuid NOT NULL,
  claim_expires_at timestamptz NOT NULL,
  operation_record_id uuid REFERENCES runtime_records(record_id),
  result_record_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (authenticated_principal_ref, operation_type, idempotency_key)
);

CREATE TABLE projection_states (
  projection_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id text NOT NULL REFERENCES record_streams(stream_id),
  projection_type text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  projection_version integer NOT NULL CHECK (projection_version > 0),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stream_id, projection_type, subject_type, subject_id, projection_version)
);

CREATE TABLE projection_checkpoints (
  projection_id uuid PRIMARY KEY REFERENCES projection_states(projection_id),
  last_record_sequence bigint NOT NULL DEFAULT 0 CHECK (last_record_sequence >= 0),
  last_record_id uuid REFERENCES runtime_records(record_id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
