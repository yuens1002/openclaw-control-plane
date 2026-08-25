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

## Deployment Topology

The repository builds and deploys three independent Railway services from one
Git history. Each service owns its own project boundary, build boundary,
deployment boundary, and runtime boundary — they are not phases of one release.

- **Project boundary**: one repository, one default branch, three services.
- **Service boundary**: each service selects its own config-as-code file
  (`railway.toml` for OpenClaw at the repository root;
  `deploy/decision-runtime/railway.toml` for the API;
  `deploy/decision-runtime/worker.railway.toml` for the worker) and its own
  `dockerfilePath`. Railway otherwise discovers the root `railway.toml` by
  default, so every non-root service must point at its file explicitly.
- **Build boundary**: every Dockerfile shares the same Docker build context
  (the repository root, filtered by `.dockerignore`), but each Dockerfile's
  `COPY` instructions name a distinct, narrower set of source paths — its
  app directory plus the shared packages and root manifests it actually
  compiles against. A service's build boundary is exactly what its
  Dockerfile copies, nothing more.
- **Deployment boundary**: the decision-runtime API and worker each declare
  `build.watchPatterns` matching their own Dockerfile's build boundary; root
  OpenClaw declares none and deploys on every commit (see the diagram
  below). A commit that touches only paths outside a service's watch
  patterns does not create a deployment for that service — **rebuilding one
  sibling service does not rebuild another**. See [Private Decision Runtime
  Deployment](decision-runtime-deployment.md) for the API/worker trigger
  matrix.
- **Runtime boundary**: OpenClaw and the decision-runtime services do not
  call each other directly at deploy time. The API and worker share one
  PostgreSQL database; OpenClaw reaches the Decision Runtime only through the
  authenticated `/v1/runtime` HTTP boundary described in [Decision
  Runtime](decision-runtime.md), never through shared process state or a
  build-time dependency.

```text
repo (one default branch)
 ├─ railway.toml                              → OpenClaw service
 │                                               (no watchPatterns; deploys
 │                                                on every commit)
 ├─ deploy/decision-runtime/railway.toml       → decision-runtime API service
 │                                               (watchPatterns scoped to its
 │                                                Dockerfile's build input)
 └─ deploy/decision-runtime/worker.railway.toml → decision-runtime worker service
                                                   (watchPatterns scoped to its
                                                    Dockerfile's build input)
```
