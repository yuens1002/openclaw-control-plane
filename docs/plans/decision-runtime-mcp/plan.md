# Decision Runtime MCP Bridge Plan

Issue: https://github.com/yuens1002/openclaw-control-plane/issues/63
Branch: `feat/decision-runtime-mcp`
Status: approved for AC authoring; implementation begins after Gate 1/2 pre-check

## Delivery Process

Use the full agentic-workflow cadence: approved plan, role-owned acceptance
criteria, implementation, independent exact-head verification, main-thread QC,
holistic review, human approval, versioned commit/PR, Copilot review, release,
and retro. No pull request is opened for planning alone.

This repository has no project-local verification-status hooks or browser
surface. Phase 0 therefore uses the clean feature worktree and tracked workflow
documents as its state; dev-server and admin-login preflights are not
applicable. Hosted deployment changes remain configuration and disposable
verification work until separately authorized for a particular environment.

## Outcome

Expose the authenticated Decision Runtime as ten workflow-neutral MCP tools so
OpenClaw and other MCP clients can discover and invoke typed runtime work
without constructing HTTP requests or receiving database credentials.

A small reusable MCP service host standardizes module registration, tool-call
context, result/error handling, stdio, and stateless Streamable HTTP. The first
module delegates the ten Decision Runtime tools through
`packages/openclaw-adapter`. It acquires short-lived OIDC client-credentials
tokens for the existing `/v1/runtime` API and preserves the runtime's
validation, authorization, idempotency, approval, attribution, and provenance
contracts. Future service modules can reuse the host without inheriting
Decision Runtime credentials or vocabulary.

## Pre-Implementation Baseline

- `apps/api` exposes the authenticated `/v1/runtime` HTTP API and owns no MCP
  transport.
- `packages/openclaw-adapter` validates typed inputs and responses, obtains a
  bearer token for every call, and forwards `x-tool-invocation-id` for command
  execution.
- The adapter's ten runtime functions exist only as TypeScript methods and
  tests; no MCP client can discover them today.
- OpenClaw supports client-spawned stdio MCP servers and remote Streamable HTTP
  servers through `mcp.servers`. The official MCP TypeScript SDK recommends
  stdio for local integrations and Streamable HTTP for remote integrations.
- Production runtime authentication accepts short-lived OIDC JWT bearer tokens
  but the repository does not yet implement a client-credentials token
  acquirer.
- The root OpenClaw, Decision Runtime API, and optional worker are independent
  deployment targets. The MCP bridge must become another independent target,
  not code embedded into one of those images.

## Architecture Decisions

1. Add `packages/mcp-service` as a deliberately small reusable host. It owns an
   `McpServiceModule`/registrar contract, duplicate-name rejection, standard MCP
   annotations, per-call context (safe invocation ID, module/tool identity,
   transport, and start time), structured-plus-text result conversion, bounded
   error/redaction handling, stdio lifecycle, stateless Streamable HTTP,
   hosted inbound bearer authentication, health aggregation, and graceful
   shutdown. It contains no Decision Runtime, database, workflow, or
   provider-specific authentication code.
2. Keep composition explicit. `packages/mcp-service` does not dynamically
   discover plugins or load arbitrary configuration. A consuming app imports a
   reviewed list of modules and passes it to the host. A fake second module in
   conformance tests must prove reuse without becoming a production tool set.
   The host standardizes first-party module execution; it does not connect to,
   filter, federate, or re-publish tools from arbitrary upstream MCP servers.
3. Add `packages/decision-runtime-mcp` as the first service module. It owns the
   ten tool definitions, contract-backed MCP input/result mapping, OIDC token
   provider, and delegation through `packages/openclaw-adapter`. It does not
   create transports or import Hono, PostgreSQL, `packages/db`, or consumer
   workflows.
4. Add `apps/mcp` as the thin composition/configuration boundary. It validates
   process environment, selects `stdio` or `streamable-http`, creates the
   generic host with the Decision Runtime module, and owns no tool handlers.
5. Register exactly the ten Decision Runtime tools named in issue #63. Reuse
   existing Zod contracts for payload-bearing calls and add only small wrapper
   schemas for scalar path/query arguments. Return MCP structured content plus
   a JSON text representation for clients that do not consume structured
   results. Supply MCP read-only/idempotency/destructive/open-world annotations
   from the reviewed tool definition rather than inferring effects at runtime.
6. Keep identity server-derived. The Decision Runtime module obtains a runtime
   access token through OAuth 2.0 client credentials using a configurable token endpoint,
   client ID, client secret, scope, audience, and supported client-auth method.
   It validates token responses, caches only through a bounded pre-expiry
   window, coalesces concurrent refresh, and reacquires after expiry or a
   single authenticated-runtime rejection. Tokens and secrets never enter tool
   results, diagnostics, readiness, or thrown public messages.
7. Treat the two authentication boundaries separately. For stdio, process
   launch and host permissions are the inbound boundary. For hosted MCP, a
   deployment-secret bearer token is checked before MCP parsing, OIDC token
   acquisition, or runtime access. That outer credential gates the bridge; the
   OIDC token remains the identity presented to the Decision Runtime.
8. Have the generic host generate one safe UUID invocation identifier for every
   MCP tool call. The Decision Runtime module passes that value through the
   existing adapter for `execute_runtime_command`.
   Preserve caller-authored runtime idempotency keys unchanged. MCP tool availability
   does not change operation authorization or approval rules.
9. Support stateless Streamable HTTP for the hosted service. Do not add legacy
   SSE. Bind the MCP endpoint and health endpoint in one Node process, keep MCP
   sessions stateless, and fail startup on invalid production configuration.
10. Add a dedicated MCP Dockerfile and Railway config that copy only
   `apps/mcp`, `packages/mcp-service`, `packages/decision-runtime-mcp`,
   `packages/openclaw-adapter`, `packages/contracts`, and required root build
   manifests. The image receives no PostgreSQL variables and does not change
   the root OpenClaw or Decision Runtime API deployment files.
11. Keep deployment adoption separate from public implementation. This branch
   documents generic OpenClaw stdio/remote configuration and disposable proof.
   Enabling the bridge for a named agent, principal, or hosted environment is a
   follow-up issue in that deployment's private profile/configuration repo.

## Public Tool Surface

| Tool | Runtime boundary | Consequential effect |
| --- | --- | --- |
| `list_runtime_registrations` | `GET /v1/runtime/registrations` | Read only |
| `create_runtime_event` | `POST /v1/runtime/events` | Append event |
| `create_runtime_work_item` | `POST /v1/runtime/work-items` | Append work item |
| `create_runtime_approval` | `POST /v1/runtime/approvals` | Record immutable decision |
| `execute_runtime_command` | `POST /v1/runtime/commands` | Execute authorized operation |
| `get_runtime_record` | `GET /v1/runtime/records/:recordId` | Read only |
| `get_runtime_edges` | `GET /v1/runtime/records/:recordId/edges` | Read only |
| `list_runtime_stream_records` | `GET /v1/runtime/streams/:streamId/records` | Read only |
| `list_runtime_audit` | `GET /v1/runtime/audit` | Read only |
| `get_runtime_projection` | `GET /v1/runtime/projections/...` | Read only |

No legacy shell/pipeline adapter method is exposed by this MCP server.

## Configuration Contract

Names may be refined during AC authoring, but the configuration must retain
these distinct concerns:

- Runtime API URL.
- MCP transport mode and hosted bind/port settings.
- Hosted MCP inbound bearer credential.
- OIDC token endpoint, client ID, client secret, optional scope/audience, and
  client authentication method.
- Token refresh skew and bounded request/connection timeouts.
- Explicit local-only insecure transport opt-in.

Production validates HTTPS for runtime and token endpoints. Hosted MCP binds
behind the deployment platform's TLS boundary and never places literal secrets
in committed OpenClaw examples.

## Deliverables

| ID | Deliverable | Kind | Owning role | Concrete artifacts |
| --- | --- | --- | --- | --- |
| D1 | Plan, ACs, and review contract | docs/workflow | project-manager | `docs/plans/decision-runtime-mcp/{plan.md,ACs.md,review.md}` with role ownership and exact-head evidence |
| D2 | Reusable MCP service host | MCP host/library | backend-architect | `packages/mcp-service` module/registrar contract, standard tool-call context and annotations, result/error boundary, stdio and stateless Streamable HTTP hosts, remote bearer gate, health aggregation, and shutdown |
| D3 | Short-lived OIDC client-credentials provider | authentication client | security | Decision Runtime module provider with validated configuration/response schemas, safe caching, concurrent refresh coalescing, bounded retry, and redacted failures |
| D4 | Decision Runtime MCP service module | MCP adapter | backend-architect | `packages/decision-runtime-mcp` module registration, ten tools, contract-backed inputs, structured results, reviewed annotations, and invocation-ID forwarding through `packages/openclaw-adapter` |
| D5 | Thin MCP composition application | executable/config | backend-architect | `apps/mcp` environment loader and explicit assembly of the reusable host plus Decision Runtime module, with no duplicated host or tool behavior |
| D6 | Independent production deployment target | deployment/config | devops | Dedicated MCP Dockerfile and Railway config, narrow image contents, no database dependency, readiness contract, generic rollback guidance, and no changes to sibling deployment behavior |
| D7 | Reuse, protocol, security, and integration conformance | tests | test-engineer | Official MCP client fixtures, a fake second service module, and token/runtime stubs covering host reuse, discovery, all ten mappings, invalid input, annotations, auth/refresh, redaction, both transports, attribution, idempotency, and failure order |
| D8 | Generic architecture, operations, and OpenClaw usage | docs | project-manager | Architecture boundary update, reusable module contract, MCP reference, generic `mcp.servers` examples, tool policy/allowlist, `openclaw mcp doctor --probe`, secret injection, deployment, rollback, and follow-up adoption boundary |
| D9 | Exact-head independent verification and holistic review | review | test-engineer | Agent/QC-filled AC rows plus `review.md` covering plan/code/test/docs consistency, dependency audit, Docker proof, public-language audit, residual risks, and exact commit SHA |

## Session Breakdown

### Session 1: Contract And Credentials

Approve D1, author ACs, then implement D2-D3 and the contract/schema portion of
D4 with failing tests first. Exit when a fake service module and the Decision
Runtime module both register through one host contract, and token acquisition,
refresh, redaction, and tool input/output contracts pass without starting a
transport.

### Session 2: MCP Transports

Complete D4-D5 and the transport portion of D2. Exit when official MCP clients
can initialize, list exactly ten Decision Runtime tools, exercise representative
read/write calls over both transports, and prove hosted authentication fails
before module/downstream access.

### Session 3: Production Shape And Documentation

Complete D6-D8 and the remaining D7 coverage. Exit when the production image,
configuration, generic OpenClaw examples, disposable probe, full suite,
typecheck, build, dependency audit, and public-language audit pass.

### Session 4: Verification And Release

Complete D9 through an independent exact-head verification pass and main-thread
QC. Correct every blocker, present the plan/AC/review set for human approval,
then version, commit, open the implementation PR, complete CI and Copilot review,
merge only after approval, and run retro.

## Commit Schedule

1. Plan: `docs: add plan for Decision Runtime MCP bridge`
2. ACs: `docs: add ACs for Decision Runtime MCP bridge`
3. Host: `feat(mcp): add reusable service host`
4. Credentials: `feat(mcp): add short-lived runtime token provider`
5. Module: `feat(mcp): expose typed Decision Runtime tools`
6. Composition: `feat(mcp): compose Decision Runtime service`
7. Deployment: `feat(deploy): add Decision Runtime MCP service target`
8. Conformance: `test(mcp): prove host reuse and attribution contracts`
9. Documentation: `docs(mcp): publish reusable service integration guide`
10. Verification: `docs: record Decision Runtime MCP verification`

Before each commit, inspect every staged file for unrelated concurrent hunks.
Each logical implementation commit runs focused tests, typecheck, build, and
`git diff --check`; the final verification runs the complete release gate.

## Release Gates

- Every D1-D9 deliverable has at least one AC and every AC has independent Agent
  and main-thread QC evidence on the exact head.
- One reusable host serves both transports and accepts a fake second module
  without transport, auth-gate, health, result, or error-handling duplication.
- One Decision Runtime module exposes exactly the ten runtime tools over both
  transports with no legacy shell tools or workflow-specific vocabulary.
- All Decision Runtime calls delegate through `packages/openclaw-adapter`;
  neither the generic host nor the domain module imports `packages/db` or
  receives database credentials.
- Invalid tool input fails before token acquisition/runtime access. Invalid
  hosted MCP credentials fail before MCP parsing, token acquisition, or runtime
  access.
- OIDC credentials remain short-lived, safely refreshed, concurrency bounded,
  and absent from every public/error surface.
- Command calls preserve the runtime idempotency key and durable
  server-generated principal, actor, authorization, request origin, and tool
  invocation attribution.
- stdio emits protocol frames only on stdout. Hosted MCP uses stateless
  Streamable HTTP with bounded health/readiness and no legacy SSE.
- The MCP deployment image contains no database package, migrations, or
  credentials and does not alter sibling service build/runtime contracts.
- Official MCP client conformance, disposable HTTP/token/runtime integration,
  full tests, typecheck, build, production dependency audit, Docker image
  build/inspection, `git diff --check`, and public-repository hygiene checks
  pass.
- Architecture and OpenClaw documentation explain HTTP versus MCP boundaries,
  secret injection, tool filtering, probing, and the private follow-up adoption
  boundary without naming a deployment.

## Non-Goals

- Replacing the Decision Runtime HTTP API or bypassing its authorization,
  approval, idempotency, registration, or audit behavior.
- Giving an MCP caller raw PostgreSQL access or database credentials.
- Defining consumer-specific workflows, registrations, prompts, operating
  policy, authority, principals, or actors.
- Treating MCP discovery or tool visibility as permission to execute work.
- Supporting legacy MCP HTTP+SSE transport.
- Dynamic plugin discovery, a module marketplace, runtime code loading,
  per-module process isolation, or a general-purpose MCP framework beyond the
  behavior exercised by this service and the conformance fixture.
- A general MCP proxy or gateway: upstream MCP discovery, tool federation,
  schema rewriting, credential brokering, filtering, or re-publication belongs
  in separately reviewed service-specific adoption work.
- Publishing a package to a public registry as part of this issue.
- Installing or enabling the bridge for a named agent or modifying a private
  profile/configuration repo in this branch.
- Mutating a particular hosted environment without separate release and
  deployment authorization.

## Authoritative References

- [OpenClaw MCP configuration reference](https://github.com/openclaw/openclaw/blob/main/docs/gateway/configuration-reference.md)
- [OpenClaw MCP CLI and probe reference](https://github.com/openclaw/openclaw/blob/main/docs/cli/mcp.md)
- [MCP TypeScript SDK server guide](https://ts.sdk.modelcontextprotocol.io/server)
