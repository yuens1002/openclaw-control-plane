# MCP Service Host And Decision Runtime Module

The MCP service gives OpenClaw and other MCP clients a discoverable tool surface
over the existing Decision Runtime HTTP API. It does not replace that API or
grant new authority.

```text
agent / MCP client
        |
        | stdio, or authenticated Streamable HTTP
        v
apps/mcp -> packages/mcp-service -> packages/decision-runtime-mcp
                                      |
                                      | short-lived OIDC bearer token
                                      v
                         packages/openclaw-adapter -> /v1/runtime
```

The MCP host has no database dependency. The API remains the service boundary
that validates identity, policy, approvals, idempotency, registrations, and
durable state.

## Tool Surface

The server exposes exactly these tools:

- `list_runtime_registrations`
- `create_runtime_event`
- `create_runtime_work_item`
- `create_runtime_approval`
- `execute_runtime_command`
- `get_runtime_record`
- `get_runtime_edges`
- `list_runtime_stream_records`
- `list_runtime_audit`
- `get_runtime_projection`

Every result includes MCP `structuredContent` and an equivalent JSON text block.
Each tool declares read-only, idempotency, destructive, and open-world hints.
These annotations help clients reason about calls; downstream authorization is
still authoritative.

The host generates a UUID for every call. Command execution forwards it as
`x-tool-invocation-id`; the runtime's caller-provided `idempotency_key` remains
unchanged.

## Authentication Boundaries

Stdio is launched and owned by the MCP client. Its inbound trust boundary is the
local process account and filesystem/environment permissions.

Hosted mode uses stateless Streamable HTTP at `/mcp`. It requires
`MCP_INBOUND_BEARER_TOKEN`, checked before request parsing or downstream access.
That deployment credential only gates the bridge. The module separately uses
OAuth 2.0 client credentials to obtain the identity token presented to the
Decision Runtime.

Required service variables:

| Variable | Purpose |
| --- | --- |
| `MCP_TRANSPORT` | `stdio` or `streamable-http` |
| `RUNTIME_API_URL` | Base URL of the authenticated runtime API |
| `OIDC_TOKEN_ENDPOINT` | OAuth token endpoint |
| `OIDC_CLIENT_ID` | Downstream service client ID |
| `OIDC_CLIENT_SECRET` | Downstream service client secret |
| `OIDC_SCOPE` | Optional requested scope |
| `OIDC_AUDIENCE` | Optional provider audience parameter |
| `OIDC_CLIENT_AUTH_METHOD` | `client_secret_basic` or `client_secret_post` |
| `MCP_INBOUND_BEARER_TOKEN` | Hosted bridge credential; not used by stdio |
| `MCP_HOST`, `MCP_PORT` | Optional hosted bind and port; `PORT` is also honored |

Production requires HTTPS runtime and token endpoints. Plain HTTP requires
`NODE_ENV=development` and `MCP_ALLOW_INSECURE_TRANSPORT=true` for disposable
local fixtures only. Inject secrets through the process or deployment secret
store; do not commit them to OpenClaw configuration.

## OpenClaw Configuration

For a local checked-out build, configure stdio with an absolute working
directory and environment-backed values:

```json5
{
  mcp: {
    servers: {
      decisionRuntime: {
        command: "node",
        args: ["apps/mcp/dist/server.js"],
        cwd: "/absolute/path/to/openclaw-control-plane",
        env: {
          MCP_TRANSPORT: "stdio",
          RUNTIME_API_URL: "${RUNTIME_API_URL}",
          OIDC_TOKEN_ENDPOINT: "${OIDC_TOKEN_ENDPOINT}",
          OIDC_CLIENT_ID: "${OIDC_CLIENT_ID}",
          OIDC_CLIENT_SECRET: "${OIDC_CLIENT_SECRET}"
        },
        toolFilter: {
          include: [
            "list_runtime_registrations",
            "get_runtime_record",
            "get_runtime_edges",
            "list_runtime_stream_records",
            "list_runtime_audit",
            "get_runtime_projection"
          ]
        }
      }
    }
  }
}
```

For an independently deployed service:

```json5
{
  mcp: {
    servers: {
      decisionRuntime: {
        url: "https://mcp.example.com/mcp",
        transport: "streamable-http",
        headers: {
          Authorization: "Bearer ${MCP_REMOTE_TOKEN}"
        },
        connectionTimeoutMs: 5000,
        requestTimeoutMs: 20000,
        supportsParallelToolCalls: true,
        toolFilter: {
          include: ["list_runtime_*", "get_runtime_*"]
        }
      }
    }
  }
}
```

Start with the smallest tool allowlist needed by the agent. Read-only visibility
does not provision runtime permission, and enabling write tools does not bypass
runtime approval or authorization.

After saving configuration, verify static configuration and a live connection:

```bash
openclaw mcp status --verbose
openclaw mcp doctor decisionRuntime --probe
openclaw mcp tools decisionRuntime --include 'list_runtime_*,get_runtime_*'
```

## Deployment And Rollback

Build the independent image with:

```bash
docker build -f deploy/decision-runtime-mcp/Dockerfile \
  -t openclaw-control-plane-mcp .
```

Railway users select
`/deploy/decision-runtime-mcp/railway.toml` as the service config-as-code path.
The service needs no PostgreSQL variables. `/health` reports the aggregate MCP
module readiness contract; `/mcp` is the authenticated protocol endpoint.

Before adoption, use a disposable service identity and non-production runtime
to list tools and execute representative allowed, denied, and approval-required
calls. Confirm durable runtime attribution and provenance through runtime read
tools.

To roll back, disable or remove the OpenClaw `mcp.servers` entry first, then
restore the prior MCP image or remove the independent service. No database
rollback is required because the MCP service owns no state. Runtime records
already created through valid calls remain authoritative audit history.

## Adding A First-Party Module

Implement `McpServiceModule` with a stable module ID, reviewed tool names,
Zod input/output schemas, MCP annotations, handlers, and an optional non-secret
health probe. Register the module explicitly in a consuming app.

Use `tests/mcp-service.test.ts` as the conformance fixture. A module receives
transport, module/tool identity, start time, and a server-generated invocation
ID from the host. It must own its downstream client and credentials rather than
receiving another module's identity.

Dynamic plugin loading, upstream MCP discovery, proxy filtering, federation,
credential brokerage, and tool re-publication are not part of this host.
