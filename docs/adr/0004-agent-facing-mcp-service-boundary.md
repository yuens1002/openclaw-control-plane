# ADR 0004: Agent-Facing MCP Service Boundary

## Status

Accepted and implemented

## Context

The Decision Runtime already exposes an authenticated, versioned HTTP API and a
typed TypeScript adapter. Those are appropriate service and application
boundaries, but an agent host should not need prompt instructions for URL
construction, headers, response parsing, or command attribution. It needs a
discoverable tool contract with machine-readable schemas and safety hints.

The repository is also likely to expose other first-party services to agents.
Copying MCP transport, authentication, health, error, and shutdown behavior into
each service would create inconsistent trust and operating boundaries.

## Decision

Use MCP as the agent-facing discovery and invocation boundary while retaining
HTTP as the internal service API.

`packages/mcp-service` is a small reusable host for explicitly composed
first-party modules. It owns stdio and stateless Streamable HTTP, hosted bearer
gating, tool-call context, schema-aware results, bounded errors, health, and
shutdown. A module owns its tool vocabulary, schemas, annotations, credentials,
and delegation to its service adapter.

`packages/decision-runtime-mcp` is the first module. It obtains short-lived OIDC
client-credentials tokens and delegates exactly ten tools through
`packages/openclaw-adapter`. The Decision Runtime remains responsible for
identity resolution, authorization, approvals, registrations, idempotency,
execution, audit, and durable provenance. Tool discovery is not authorization.

Composition is static and reviewed in `apps/mcp`. The host does not discover,
filter, federate, rewrite, broker credentials for, or re-publish arbitrary
upstream MCP servers. A general MCP proxy or gateway requires a separate trust
model and is outside this decision.

## Consequences

- Agents receive stable discoverable tools without constructing HTTP calls.
- Services keep their existing HTTP contracts and can still support non-agent
  clients directly.
- New first-party modules can reuse transport and lifecycle behavior while
  retaining service-specific credentials and policy.
- Stdio trusts the launching process boundary. Hosted MCP adds a separate
  deployment bearer gate before MCP parsing; its outbound OIDC token identifies
  the bridge to the downstream service.
- Operators must provision both the MCP inbound credential and the downstream
  service identity, then apply OpenClaw tool filters and agent policy separately.
- Model behavior still requires consumer-owned policy and evaluation; protocol
  availability alone does not decide when a tool should be called.

## Alternatives Considered

- **Have agents call HTTP directly.** Rejected as the default agent boundary
  because discovery, schemas, safety metadata, attribution, and error behavior
  would be reconstructed in prompts or client-specific code.
- **Expose only a CLI.** Retained as an operator/debugging option, but rejected
  as the primary agent boundary because process output parsing and command-line
  composition are weaker typed contracts.
- **Build a generic MCP proxy.** Rejected from this baseline because upstream
  filtering, credential brokerage, and re-publication introduce a different and
  broader security model.
