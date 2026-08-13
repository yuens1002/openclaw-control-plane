# OpenClaw Control Plane Architecture

The control plane is a private-first TypeScript monorepo for durable business processes that OpenClaw can manage through stable tools.

OpenClaw manages the system; it does not become the system. Domain behavior lives in workers, shared shapes live in contracts, persistence lives in the DB package, and OpenClaw-facing functions stay thin.

## Packages

- `packages/contracts`: Zod schemas and TypeScript types for events, work items, worker runs, approvals, artifacts, audit events, and vending payloads.
- `packages/db`: Postgres migrations, Drizzle schema, and persistence primitives.
- `packages/openclaw-adapter`: OpenClaw-facing wrappers around the HTTP API.
- `apps/api`: Hono HTTP API for ingesting events and controlling pipelines.
- `apps/worker`: Background runner entrypoint.
- `workers/vending`: First vertical worker.

## Runtime Boundary

- OpenClaw owns user interaction, prioritization, briefings, approvals, scheduling decisions, management commands, and notifications.
- The control plane owns durable entities, state transitions, event ingestion, idempotency, audit records, approval records, artifact records, and worker registry state.
- Workers own domain-specific interpretation, workflows, scoring, and output generation.

## M1 Scope

M1 includes contracts, Postgres migrations, API stubs, a vending worker skeleton, OpenClaw adapter stubs, sample fixtures, and tests for event validation and idempotency.

External connectors are intentionally out of scope.
