# OpenClaw Control Plane Architecture

The control plane is a reusable TypeScript monorepo for durable business
processes that OpenClaw can manage through stable tools.

OpenClaw manages the system; it does not become the system. Domain behavior
lives in consumer handlers and workers, shared shapes live in contracts,
persistence lives in the DB package, and OpenClaw-facing functions stay thin.

The public baseline is workflow-neutral. It should boot with no client-specific
pipeline registered, then accept workflows, connectors, credentials, and
business-specific automations from private client repos or plugin packages.

## Packages

- `packages/contracts`: Zod schemas and TypeScript types for registered runtime
  records, commands, approvals, API requests, and responses.
- `packages/runtime-auth`: OIDC/JWKS authentication, stable principal mapping,
  static RBAC, delegation, and trusted command context.
- `packages/db`: PostgreSQL migrations, registration registry, typed runtime
  service/repository, provenance, idempotency, audit, and projections.
- `packages/openclaw-adapter`: bearer-authenticated, schema-validated tools for
  the versioned runtime HTTP API.
- `packages/openclaw-railway-installer`: shell-installs the OpenClaw Railway
  template and verifies the resulting proof instance — see
  [deploy/openclaw-railway](../deploy/openclaw-railway/README.md).
- `packages/openclaw-setup-applier`: reads a generated client profile and
  drives a live OpenClaw instance's `/setup` API idempotently — see
  [docs/setup-profile-applier.md](setup-profile-applier.md).
- `apps/api`: Hono API exposing public health, legacy shell compatibility, and
  the authenticated `/v1/runtime` command/query boundary.
- `apps/worker`: Optional workflow-neutral worker/readiness process.
- `workers/vending`: Fake/manual example worker package.

## Runtime Boundary

- OpenClaw owns user interaction, prioritization, briefings, approvals, scheduling decisions, management commands, and notifications.
- The control plane owns durable entities, state transitions, event ingestion, idempotency, audit records, approval records, artifact records, and worker registry state.
- Workers own domain-specific interpretation, workflows, scoring, and output generation.

The Decision Runtime is the path for operational typed work. Requests cross
authentication and authorization before the runtime service validates a
registration or executes a command. PostgreSQL stores ordered records and
edges; agents access that state only through the API or typed adapter. See
[Decision Runtime](decision-runtime.md) for the full architecture and usage.

## Public Baseline

The repository includes the durable typed runtime, a production API target, an
optional worker target, generic `example.*` registrations and handlers, and a
public conformance suite. A deployment adds its own namespaced registrations,
handlers, identity policy, connectors, and private credentials.

External connectors and consumer-specific workflows remain out of scope for the
public baseline.
