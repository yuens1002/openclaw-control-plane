# Decision Runtime

The Decision Runtime is the control plane's authenticated, durable execution
boundary for typed work. It accepts observations, derives work, records
approvals, executes registered operations, retains results, and exposes the
provenance needed to explain what happened and why.

It is workflow-neutral. The control plane supplies runtime primitives and
validation; a consumer supplies namespaced type and operation registrations,
handlers, policy, and business-specific schemas.

## Architecture

```text
OpenClaw, an agent, or another service
              |
              | OIDC bearer token
              v
packages/openclaw-adapter or direct HTTP client
              |
              v
apps/api: /v1/runtime
  authentication -> authorization -> runtime service
              |                         |
              |                         +-> operation handlers
              v
packages/db: PostgreSQL records, edges, idempotency, audit, projections
```

The boundaries are deliberate:

- `packages/contracts` owns public request, response, registration, and record
  schemas.
- `packages/runtime-auth` verifies identity and produces authorization
  decisions and trusted command context.
- `apps/api` owns the versioned HTTP transport and route authorization.
- `packages/db` owns registration validation, command execution state,
  append-only records, provenance edges, idempotency, and projections.
- `packages/openclaw-adapter` is a typed bearer-authenticated client. It does
  not write PostgreSQL or invent trusted identity fields.
- Consumer packages own business schemas and handlers. They do not add a new
  platform endpoint for each workflow.

The durable architecture decision and data model are recorded in
[ADR 0002](adr/0002-durable-runtime-state-and-action-attribution.md). The
reference authentication boundary is recorded in
[ADR 0003](adr/0003-reference-authentication-and-authorization.md).

## Runtime Model

The normal lifecycle is:

1. An `event` records something observed.
2. A `work_item` describes actionable work derived from one or more records.
3. An optional `approval` binds an approve/reject decision to one canonical
   command revision.
4. A command creates an `action_attempt` and invokes a registered operation.
5. The attempt produces typed `result` and/or `artifact` records.
6. Typed edges retain causation, derivation, attempts, outputs, and approvals.
7. A `projection` provides rebuildable current state derived from ordered
   records; `audit_entry` records retain authorization and execution evidence.

Every payload-bearing record is validated against an active registration
identified by `kind`, namespaced `type`, and `schema_version`. Operation
registrations separately define command schemas, handlers, authorization
actions, allowed result types, and whether approval is required.

Attribution is server-derived. Durable action records retain the authenticated
principal, effective actor, optional delegation, authorization decision,
request origin, operation, request/tool IDs, inputs, outputs, timestamps, and
ordered provenance. Callers cannot submit those trusted fields in request
bodies.

## API

All operational routes use the `/v1/runtime` prefix and require an OIDC bearer
token. `/health` is public for platform readiness.

| Method | Route | Purpose | Authorization action |
| --- | --- | --- | --- |
| `GET` | `/v1/runtime/registrations` | List active public type and operation registrations | `runtime.record.read` |
| `POST` | `/v1/runtime/events` | Append a registered event | `runtime.event.ingest` |
| `POST` | `/v1/runtime/work-items` | Append a registered work item | `runtime.work-item.create` |
| `POST` | `/v1/runtime/approvals` | Record an immutable approve/reject decision | `runtime.command.approve` |
| `POST` | `/v1/runtime/commands` | Execute a registered operation idempotently | Operation registration value |
| `GET` | `/v1/runtime/records/:recordId` | Read one record | `runtime.record.read` |
| `GET` | `/v1/runtime/records/:recordId/edges` | Traverse record provenance | `runtime.record.read` |
| `GET` | `/v1/runtime/streams/:streamId/records` | Page through one ordered stream | `runtime.record.read` |
| `GET` | `/v1/runtime/audit` | Page through audit entries | `runtime.record.read` |
| `GET` | `/v1/runtime/projections/:projectionType/:subjectType/:subjectId` | Read one projection version | `runtime.record.read` |

Responses use typed JSON schemas from `packages/contracts`. Failures use one
stable envelope:

```json
{
  "error": {
    "code": "runtime.example_error",
    "message": "A bounded public explanation.",
    "request_id": "request-id"
  }
}
```

Request bodies are limited to 256 KiB. Record pages accept `kind`, `type`,
`limit` (maximum 100), and an opaque `cursor`. Return `next_cursor` unchanged
on the next request; do not parse or construct it.

## HTTP Example

The repository ships an `example.*` registry for conformance and local
exploration. Replace these names and schemas with consumer registrations in a
real deployment.

```bash
export RUNTIME_URL=https://runtime.example.test
export ACCESS_TOKEN='<short-lived OIDC access token>'
export EVENT_ID=00000000-0000-4000-8000-000000000101
export WORK_ID=00000000-0000-4000-8000-000000000102

curl --fail-with-body "$RUNTIME_URL/v1/runtime/registrations" \
  -H "Authorization: Bearer $ACCESS_TOKEN"

curl --fail-with-body "$RUNTIME_URL/v1/runtime/events" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "{
    \"record_id\": \"$EVENT_ID\",
    \"stream_id\": \"example-stream\",
    \"type\": \"example.observation\",
    \"schema_version\": 1,
    \"subject\": {\"type\": \"example.environment\", \"id\": \"production\"},
    \"payload\": {\"statement\": \"Configuration drift observed.\"},
    \"source_refs\": []
  }"

curl --fail-with-body "$RUNTIME_URL/v1/runtime/work-items" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "{
    \"record_id\": \"$WORK_ID\",
    \"stream_id\": \"example-stream\",
    \"type\": \"example.state.reconcile\",
    \"schema_version\": 1,
    \"subject\": {\"type\": \"example.environment\", \"id\": \"production\"},
    \"payload\": {\"requested_state\": {\"ready\": true}},
    \"source_refs\": [{\"kind\": \"event\", \"id\": \"$EVENT_ID\"}]
  }"
```

Execute the work with a stable idempotency key:

```bash
curl --fail-with-body "$RUNTIME_URL/v1/runtime/commands" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "{
    \"stream_id\": \"example-stream\",
    \"idempotency_key\": \"reconcile-2026-08-24-001\",
    \"operation_type\": \"example.state.reconcile\",
    \"operation_schema_version\": 1,
    \"work_item_id\": \"$WORK_ID\",
    \"action_revision\": 1,
    \"target\": {\"type\": \"example.environment\", \"id\": \"production\"},
    \"arguments\": {\"desired\": {\"ready\": true}},
    \"declared_effects\": [{
      \"kind\": \"result\",
      \"result_type\": \"example.reconciliation.delta\",
      \"schema_version\": 1,
      \"schema_ref\": \"example://schemas/reconciliation-delta/v1\",
      \"target\": {\"type\": \"example.environment\", \"id\": \"production\"},
      \"payload\": {\"changed\": true}
    }],
    \"trigger\": {\"type\": \"user_request\", \"ref\": {\"kind\": \"work_item\", \"id\": \"$WORK_ID\"}},
    \"causation_ref\": {\"kind\": \"work_item\", \"id\": \"$WORK_ID\"},
    \"correlation_id\": \"example-reconcile-001\",
    \"input_refs\": []
  }"
```

An equal retry with the same principal, operation type, idempotency key, and
canonical command returns the same operation. Reusing that tuple with changed
content returns a conflict and creates no duplicate effect.

Read the ordered history or traverse a returned record ID:

```bash
curl --fail-with-body \
  "$RUNTIME_URL/v1/runtime/streams/example-stream/records?limit=25" \
  -H "Authorization: Bearer $ACCESS_TOKEN"

curl --fail-with-body \
  "$RUNTIME_URL/v1/runtime/records/<record-id>/edges" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

Approval-required operations first send the same immutable command envelope to
`POST /v1/runtime/approvals` with `decision: approved` or `rejected`. Execute
the exact command with the returned `approval_id`. Any change to the target,
arguments, effects, revision, operation, or approver binding requires a new
approval; a rejected approval cannot execute.

## Typed Tool Client

Agents normally use `createOpenClawControlPlaneTools` rather than constructing
HTTP requests. The token provider is invoked for every call so short-lived
credentials can rotate without rebuilding the client.

```ts
import { createOpenClawControlPlaneTools } from "@openclaw-control-plane/openclaw-adapter";

const tools = createOpenClawControlPlaneTools({
  baseUrl: process.env.RUNTIME_URL!,
  tokenProvider: async () => obtainRuntimeAccessToken(),
  toolInvocationIdProvider: async () => crypto.randomUUID()
});

const registrations = await tools.list_runtime_registrations();
const page = await tools.list_runtime_stream_records("example-stream", {
  kind: "result",
  limit: 25
});
```

The adapter exposes typed methods for registrations, events, work items,
approvals, commands, records, edges, stream pages, audit pages, and projections.
Bearer-authenticated clients require HTTPS unless an explicit local-development
override is supplied.

## Operating And Extending The Runtime

1. Define namespaced JSON Schema registrations for each event, work item,
   result, artifact, and operation owned by the consumer.
2. Inject the registrations and matching handlers at startup. Do not modify the
   public runtime model for consumer-specific vocabulary.
3. Configure issuers, stable principals, roles, grants, and delegation through
   secret-backed `RUNTIME_AUTH_CONFIG_JSON` as described in
   [Runtime Authentication And Authorization](runtime-authentication.md).
4. Deploy the private API service and PostgreSQL migrations using
   [Private Decision Runtime Deployment](decision-runtime-deployment.md).
5. Verify `/health`, query the registration catalog, and run a non-production
   end-to-end command before allowing an agent or service to send real work.

The control plane remains the system of record for runtime execution state.
OpenClaw or another agent decides what work to request; the runtime validates,
authorizes, executes, and preserves the evidence of that work.
