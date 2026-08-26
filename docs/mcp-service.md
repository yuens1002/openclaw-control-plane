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
                                      | short-lived identity bearer token
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
Non-browser clients normally omit `Origin`. Requests that include `Origin` are
rejected unless the exact value is listed in `MCP_ALLOWED_ORIGINS`, protecting
the endpoint from DNS rebinding.
That deployment credential only gates the bridge. The module separately
obtains the identity token presented to the Decision Runtime. OAuth 2.0 client
credentials remain the default. A deployment that already operates an
asymmetric issuer/JWKS trust boundary may instead sign short-lived workload
JWTs from a secret-held PKCS#8 private key. The second mode is a caller
credential, not an authorization server or credential broker.

Service variables use the common transport/runtime fields plus exactly one
downstream-provider set. OAuth fields are not required in workload mode, and
workload fields are not valid in OAuth mode:

| Variable | Purpose |
| --- | --- |
| `MCP_TRANSPORT` | `stdio` or `streamable-http` |
| `RUNTIME_API_URL` | Base URL of the authenticated runtime API |
| `MCP_DOWNSTREAM_AUTH_MODE` | `oidc-client-credentials` (default) or `workload-jwt` |
| `OIDC_TOKEN_ENDPOINT` | OAuth token endpoint |
| `OIDC_CLIENT_ID` | Downstream service client ID |
| `OIDC_CLIENT_SECRET` | Downstream service client secret |
| `OIDC_SCOPE` | Optional requested scope |
| `OIDC_AUDIENCE` | Optional provider audience parameter |
| `OIDC_CLIENT_AUTH_METHOD` | `client_secret_basic` or `client_secret_post` |
| `MCP_WORKLOAD_JWT_ISSUER` | Exact HTTPS issuer already trusted by the runtime |
| `MCP_WORKLOAD_JWT_SUBJECT` | Stable subject mapped to one runtime principal |
| `MCP_WORKLOAD_JWT_AUDIENCE` | Exact runtime audience |
| `MCP_WORKLOAD_JWT_KEY_ID` | Published JWKS key identifier |
| `MCP_WORKLOAD_JWT_ALGORITHM` | `RS256`, `RS384`, `RS512`, `ES256`, `ES384`, `ES512`, or `EdDSA` |
| `MCP_WORKLOAD_JWT_PRIVATE_KEY` | Secret-injected PKCS#8 asymmetric private key |
| `MCP_WORKLOAD_JWT_LIFETIME_SECONDS` | Optional 30-3600 second lifetime; default 300 |
| `MCP_WORKLOAD_JWT_REFRESH_SKEW_SECONDS` | Optional 5-300 second skew shorter than the lifetime |
| `MCP_INBOUND_BEARER_TOKEN` | Hosted bridge credential; not used by stdio |
| `MCP_ALLOWED_ORIGINS` | Optional comma-separated browser origins accepted by hosted MCP |
| `MCP_HOST`, `MCP_PORT` | Optional hosted bind and port; `PORT` is also honored |
| `MCP_REQUEST_TIMEOUT_MS` | Bound for token and Decision Runtime HTTP requests |

Production requires an HTTPS runtime plus an HTTPS OAuth token endpoint or
workload issuer, according to the selected provider. Plain HTTP is accepted
only for loopback hosts and requires `NODE_ENV=development` plus
`MCP_ALLOW_INSECURE_TRANSPORT=true` for disposable local fixtures. Inject
secrets through the process or deployment secret store; do not commit them to
OpenClaw configuration.

Provider configuration is mutually exclusive. OAuth mode rejects workload-key
variables, and workload mode rejects OAuth credentials. Workload mode validates
the PKCS#8 key and its algorithm family before a transport starts. It signs
only bounded `iss`, `sub`, `aud`, `iat`, `exp`, and `jti` claims with protected
`alg`, `kid`, and `typ` headers; tokens and private keys remain in process
memory and never enter readiness or public errors.

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

For a deployment with an existing reviewed JWKS boundary, set the hosted MCP
service's downstream authentication variables through its secret store:

```text
MCP_DOWNSTREAM_AUTH_MODE=workload-jwt
MCP_WORKLOAD_JWT_ISSUER=https://issuer.example
MCP_WORKLOAD_JWT_SUBJECT=example-workload
MCP_WORKLOAD_JWT_AUDIENCE=example-runtime
MCP_WORKLOAD_JWT_KEY_ID=example-key-2
MCP_WORKLOAD_JWT_ALGORITHM=RS256
MCP_WORKLOAD_JWT_PRIVATE_KEY=<secret PKCS#8 PEM>
```

Publish only the matching public JWK. The runtime trust configuration must map
the exact issuer and subject to a stable principal and grant only the required
runtime actions and resources. Do not reuse the hosted MCP inbound bearer as
the private key or as an OAuth client secret.

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
The service needs no PostgreSQL variables. `/health` actively checks token
acquisition and the runtime registration endpoint and reports aggregate module
readiness; `/mcp` is the authenticated protocol endpoint.

Before adoption, use a disposable service identity and non-production runtime
to list tools and execute representative allowed, denied, and approval-required
calls. Confirm durable runtime attribution and provenance through runtime read
tools.

For workload-key rotation, publish the new public JWK beside the current key,
wait for runtime readiness to confirm the JWKS, place the new private key and
key ID on the MCP service, and verify an authenticated read. Retain the old
public key until every old token has expired, then remove it. Roll back by
restoring the prior key ID/private key while its public JWK remains published.
Never log, download into a tracked workspace, or commit the private key.

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
