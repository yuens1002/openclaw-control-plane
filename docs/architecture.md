# OpenClaw Control Plane Architecture

The control plane is a reusable TypeScript monorepo for durable business processes that OpenClaw can manage through stable tools.

OpenClaw manages the system; it does not become the system. Domain behavior lives in workers, shared shapes live in contracts, persistence lives in the DB package, and OpenClaw-facing functions stay thin.

The public baseline is workflow-neutral. It should boot with no client-specific
pipeline registered, then accept workflows, connectors, credentials, and
business-specific automations from private client repos or plugin packages.

## Packages

- `packages/contracts`: Zod schemas and TypeScript types for generic events, work items, worker runs, approvals, artifacts, and audit events.
- `packages/db`: Postgres migrations, Drizzle schema, and persistence primitives.
- `packages/openclaw-adapter`: OpenClaw-facing wrappers around the HTTP API.
- `packages/openclaw-railway-installer`: shell-installs the OpenClaw Railway
  template and verifies the resulting proof instance — see
  [deploy/openclaw-railway](../deploy/openclaw-railway/README.md).
- `packages/openclaw-setup-applier`: reads a generated client profile and
  drives a live OpenClaw instance's `/setup` API idempotently — see
  [docs/setup-profile-applier.md](setup-profile-applier.md).
- `apps/api`: Hono HTTP API for ingesting events and controlling pipelines.
- `apps/worker`: Background runner entrypoint.
- `workers/vending`: Fake/manual example worker package.

## Runtime Boundary

- OpenClaw owns user interaction, prioritization, briefings, approvals, scheduling decisions, management commands, and notifications.
- The control plane owns durable entities, state transitions, event ingestion, idempotency, audit records, approval records, artifact records, and worker registry state.
- Workers own domain-specific interpretation, workflows, scoring, and output generation.

## M1 Scope

M1 includes contracts, Postgres migrations, shell-neutral API stubs, an example
worker skeleton, OpenClaw adapter stubs, sample fixtures, and tests for event
validation and idempotency.

External connectors are intentionally out of scope.
