# ADR 0002: Durable Typed Work and Action Attribution

## Status

Accepted and implemented

## Context

The control plane already models events, work items, worker runs, approvals,
artifacts, tool invocations, and audit entries. It also has initial PostgreSQL
and Drizzle migrations. The API still defaults to an in-memory event store,
however, and the existing records do not form one explicit durable graph from
an observed event to work performed, effects produced, and outputs retained.

The public baseline must remain workflow-neutral. A deployment, external
message, reconciliation, report, review, or any future operation should not
require a new platform-level workflow concept. Storing untyped JSON is not an
acceptable alternative: validation, authorization, migration, handler
selection, and replay would become private conventions that the control plane
cannot enforce.

## Decision

### 1. Persist generic runtime primitives

The durable model consists of:

- **Event:** something observed, received, or triggered.
- **Work item:** a durable unit of actionable work derived from records.
- **Action attempt:** one attempt to perform an operation for a work item.
- **Approval:** an authenticated decision about an immutable command revision.
- **Result:** a typed outcome or effect receipt produced by an action attempt.
- **Artifact:** a typed retained output produced by an action attempt.
- **Audit entry:** an append-only account of an attempted or completed
  operation and its result.
- **Projection:** rebuildable current state derived from durable records.

Artifacts are one result shape, not the universal result model. An external
message receipt, deployment identifier, reconciliation delta, state-transition
receipt, or retained document can all be linked results of an action attempt.

These are storage and execution primitives, not business workflow concepts.
Consumers map their own vocabulary onto them through typed registrations.

### 2. Type each payload-bearing layer independently

The following keys are independent:

- `event_type`
- `work_type`
- `operation_type`
- `subject_type`
- `result_type`
- `artifact_type`

Each payload-bearing record identifies exactly one registration by
`(kind, type, schema_version)`. Its `schema_ref` is copied from that
registration and stored with the record.

`subject_type` is different: it is a namespaced identifier category, not a
payload-bearing record registration. A subject contains only `type` and `id`;
any typed subject state is represented by a registered event, result, or
projection whose subject points to that identifier.

```yaml
kind: work_item
type: example.state.reconcile
schema_version: 1
schema_ref: example://schemas/state-reconcile/v1
subject:
  type: example.environment
  id: production
payload: {}
```

Type names are namespaced strings rather than PostgreSQL enums. Adding a
consumer type does not require a platform migration.

### 3. Use an explicit type registry

A registration has this public shape:

```yaml
kind: event | work_item | result | artifact
type: namespaced_type
schema_version: 1
schema_ref: versioned_schema_reference
schema_digest: sha256_of_schema
payload_schema: JSON_Schema_2020_12
status: active | retired
owner: registration_owner
```

The unique key is `(kind, type, schema_version)`. At startup, the registry
loads built-in and injected registrations, validates each JSON Schema, and
fails on duplicate keys with different schema digests. Re-registering an
identical key and digest is idempotent.

New commands require an active registration. Retiring a registration prevents
new writes but does not make historical records unreadable. Historical records
retain their schema reference and payload; projection rebuild or action replay
may use a matching retired registration, while a missing or changed
registration fails explicitly rather than silently interpreting the payload.

Operation registrations are separate because an operation consumes a command
and may produce several result types:

```yaml
operation_type: example.state.reconcile
command_schema_version: 1
command_schema_ref: example://schemas/reconcile-command/v1
command_schema_digest: sha256_of_schema
command_schema: JSON_Schema_2020_12
allowed_result_types:
  - example.reconciliation.delta
handler_id: reconcile-handler
handler_version: 1
authorization_action: state.reconcile
status: active | retired
```

The repository provides a public `example.*` registry fixture and conformance
suite. Real consumer schemas remain outside the baseline.

### 4. Represent provenance as typed edges

Every durable primitive has a globally unique record ID. Relationships use
typed record references:

```yaml
record_ref:
  kind: event | work_item | action_attempt | approval | result | artifact | audit_entry
  id: stable_record_id
```

A durable edge contains:

```yaml
from: record_ref
relation: caused_by | derived_from | attempted_by | produced | approved_by | supersedes
to: record_ref
ordinal: 0
created_at: timestamp
```

Multiple ordered edges represent work derived from several events or results.
The tuple `(from, relation, ordinal)` is unique. Both record endpoints must
exist in the transaction before an edge is accepted. External resources use a
separate `external_ref` value and do not pretend to be internal record IDs.

This graph is the basis for attribution traversal; singular `source_event_id`
fields may remain as compatibility shortcuts but are not the complete
provenance model.

### 5. Separate authenticated command context from transport authentication

The service/repository layer accepts a trusted command context:

```yaml
command_context:
  authenticated_principal_ref: principal://stable-id
  effective_actor:
    type: user | agent | service | system
    id: stable-actor-id
  on_behalf_of_principal_ref: optional-principal-ref
  request_origin: http | tool | worker | scheduler | internal
  authorization:
    decision_id: stable-decision-id
    action: registered-authorization-action
    result: allowed | denied
    policy_version: authorization-policy-version
```

The persistence feature accepts this context through dependency injection and
tests with a test principal. It never derives identity from submitted payload
fields. Transport adapters, credential verification, role mapping, and
authorization-policy evaluation are a separate delivery concern; they must
produce this trusted context before calling the service layer.

When a service acts on behalf of another principal, both the authenticated
service principal and `on_behalf_of_principal_ref` are retained. The effective
actor is derived from that authenticated/delegated context, not asserted by the
consumer payload.

The service boundary exposes a bounded `recordAuthorizationDecision`
operation. A denied context records an audit entry containing the request,
principal/delegation, attempted operation and target, policy version, decision
ID, result, and reason codes; it cannot create a work item, action attempt, or
effect. Transport adapters call this operation after a denial rather than
writing audit tables directly.

### 6. Attribute every action attempt and effect

An action attempt records:

```yaml
id: action-attempt-id
work_item_id: work-item-id
operation_type: registered-operation-type
handler_id: registered-handler
handler_version: 1
command_context: trusted-command-context
subject:
  type: namespaced-subject-type
  id: stable-subject-id
trigger:
  type: event | schedule | user_request | retry | internal
  ref: typed-record-or-external-reference
causation_ref: typed-record-reference
correlation_id: stable-workflow-id
request_id: stable-request-id
tool_invocation_id: optional-tool-invocation-id
canonicalization_version: jcs-rfc8785-v1
input_refs: []
command_digest: sha256-of-canonical-command
started_at: timestamp
finished_at: timestamp
outcome: succeeded | failed | cancelled
result_refs: []
```

`result_refs` may point to result receipts or artifacts. Audit entries retain
the authorization decision, action attempt, target, operation, result refs,
and outcome. This makes event-to-work-to-attempt-to-effect traversal possible
without assuming that all work generates a document.

### 7. Define idempotency independently of payload comparison

The idempotency uniqueness tuple is:

```text
(authenticated_principal_ref, operation_type, idempotency_key)
```

The stored idempotency record also contains the canonicalization version and
command digest, but neither is part of the lookup key.

- If no tuple exists, the command claims it transactionally and enters
  `in_progress`.
- An equal retry while `in_progress` returns the stable operation reference and
  current status; it does not start a second attempt.
- An equal retry after `succeeded` or `failed` returns the stored terminal
  result. Retrying a failed operation requires a new idempotency key.
- Reusing the tuple with a different canonicalization version or digest fails
  as a conflict and creates an audit entry.
- Concurrent claims of the same tuple produce one winner and the same replay
  behavior for all other callers.

### 8. Use a public canonical command envelope

Consequential commands and approvals share this envelope:

```yaml
canonicalization_version: jcs-rfc8785-v1
operation_type: registered-operation-type
operation_schema_version: 1
work_item_id: stable-work-item-id
action_revision: 1
target:
  type: namespaced-subject-type
  id: stable-subject-id
arguments: {}
declared_effects:
  - result_type: namespaced-result-type
    schema_version: 1
    schema_ref: example://schemas/result/v1
    target:
      type: namespaced-subject-type
      id: stable-subject-id
    payload: {}
```

The digest is SHA-256 over the UTF-8 bytes of this envelope serialized using
RFC 8785 JSON Canonicalization Scheme. The platform owns the envelope and
algorithm. The operation registration validates `arguments`; each declared
effect is validated against its active `(result, result_type, schema_version)`
registration, and its stored `schema_ref` must match that registration.

Immediately before approved execution, the server rebuilds the envelope from
the actual operation, target, arguments, and declared effects. A mismatch with
the approved digest requires a new action revision and approval.

### 9. Order projection inputs durably

Every accepted append-only record belongs to a durable `stream_id`, normally a
control-plane domain. A `record_streams` row stores the next sequence. An
append transaction locks that row with `SELECT ... FOR UPDATE`, assigns the
next `record_sequence`, writes all records and edges, advances the counter, and
commits while holding the lock. Another append to the same stream cannot assign
or commit a later sequence until the earlier transaction commits or rolls
back. This transactional per-stream counter, not a PostgreSQL sequence object,
defines replay order.

`occurred_at` remains business time and does not reorder late arrivals. Streams
may progress concurrently; a projection consuming multiple streams must define
and persist its own merge order rather than comparing timestamps.

A single-stream projection is identified by
`(stream_id, projection_type, subject_type, subject_id, projection_version)`
and stores `last_record_sequence`. Rebuild selects the projection's registered
input record types, processes records in ascending sequence, and produces the
same state and checkpoint. New late-arriving events append at a later sequence
and are applied from the existing checkpoint.

Projection code changes require a new projection version and a rebuild or
backfill path. A checkpoint update and projected state update commit
atomically.

### 10. Preserve existing M1 data through an additive migration

The first implementation extends rather than destructively replaces the M1
schema:

- `events` and `work_items` remain and gain typed-registration, sequence, and
  attribution fields.
- `worker_runs` is retained as the action-attempt storage and gains operation,
  command-context, canonicalization, digest, trigger, correlation, request,
  and outcome fields.
- `approval_requests`, `artifacts`, `audit_log`, and `tool_invocations` remain
  and gain typed references needed by this ADR.
- New tables hold type/operation registrations, idempotency records, typed
  edges, generic results, and projection checkpoints/state.
- Existing `tasks` and `commitments` remain supported domain tables; this ADR
  does not reinterpret or delete them.
- Existing rows are preserved and backfilled with documented `legacy.*`
  registrations. Unknown historical principals use an explicit legacy/system
  principal marker rather than fabricated attribution.

Post-migration tests assert unchanged row counts and readability for every M1
table, valid backfilled registrations, and successful traversal for newly
written records. No existing durable row is discarded.

### 11. Prove the contract with public conformance tests

The repository ships `example.*` event, work, operation, result, and artifact
registrations plus tests for:

- Registration startup, duplicate collision, retirement, historical reads,
  and missing-schema replay failure.
- Restart persistence and additive migration from M1 fixtures.
- Idempotent in-progress, succeeded, failed, conflict, and concurrent cases.
- Transaction rollback with no partial records, edges, or projection updates.
- Many-to-many ordered provenance traversal.
- Action attribution, delegation, authorization evidence, results, artifacts,
  and tool invocation linkage.
- Deterministic projection rebuild, checkpoints, and late arrivals.
- Actor-payload spoof rejection at the service boundary.
- Denied authorization audit with no work item, attempt, or effect.
- Approval digest recomputation and mismatch.

## Consequences

- The public baseline remains usable by unrelated workflows and organizations.
- Consumers add typed behavior without public tables for each use case.
- Operators can trace events through work, attempts, effects, artifacts,
  approvals, and audit history.
- Authentication and authorization transports remain replaceable while the
  persistence service consumes one stable trusted context.
- The schema gains registrations, typed edges, sequences, and projection
  checkpoints, increasing implementation scope in exchange for deterministic
  behavior.
- Consumer-specific policy remains outside this repository and is tested by
  consumer adapters or conformance suites.

## Alternatives Considered

- **Dedicated tables and endpoints per workflow.** Rejected: every consumer
  becomes a platform migration.
- **Arbitrary JSON with no registry.** Rejected: validation, authorization,
  migration, and replay become inconsistent.
- **Payload digest as part of idempotency identity.** Rejected: changed content
  would evade conflict detection by becoming a different lookup key.
- **Timestamps as replay order.** Rejected: concurrent and late records make
  timestamps nondeterministic.
- **Artifacts as the only action result.** Rejected: many actions produce
  external effects or receipts rather than retained documents.
- **Trust caller actor or digest fields.** Rejected: callers could self-assign
  identity or execute content different from what was approved.
