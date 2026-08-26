# OpenClaw Tools

The OpenClaw adapter exposes stable, typed functions that call the control-plane
API without embedding business-specific workflow logic or writing persistence
directly.

## Decision Runtime Tools

- `list_runtime_registrations()`
- `create_runtime_event(input)`
- `create_runtime_work_item(input)`
- `create_runtime_approval(input)`
- `execute_runtime_command(input)`
- `get_runtime_record(recordId)`
- `get_runtime_edges(recordId)`
- `list_runtime_stream_records(streamId, query)`
- `list_runtime_audit(query)`
- `get_runtime_projection(projectionType, subjectType, subjectId, streamId, version)`

Create the client with `createOpenClawControlPlaneTools`. Supply an async token
provider so each invocation receives a current OIDC bearer token. Supplying a
tool-invocation ID provider attributes commands to the originating tool call.
Inputs and responses are validated against `packages/contracts`; trusted
principal, actor, policy, digest, request, and timestamp fields are always
server-derived.

See [Decision Runtime](decision-runtime.md#typed-tool-client) for setup and
usage.

For model-facing discovery, the same ten functions are exposed as reviewed MCP
tools through the reusable host. See
[MCP Service Host And Decision Runtime Module](mcp-service.md) for stdio,
Streamable HTTP, OpenClaw filters, authentication, and deployment.

## Legacy Shell Surface

The adapter retains the early shell methods for compatibility:

- `ingest_event(eventEnvelope)`
- `get_pipeline_state(domain)`
- `run_pipeline(domain, input)`
- `pause_pipeline(domain)`
- `resume_pipeline(domain)`
- `retry_run(runId)`

The legacy pipeline-control routes remain stubs and are not an alternative
unauthenticated write path in production. New operational integrations should
use the authenticated Decision Runtime tools. The adapter remains a transport
wrapper; workflow behavior belongs in consumer handlers or workers.
