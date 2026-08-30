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
- `packages/mcp-service`: workflow-neutral MCP module host, transports, call
  context, results/errors, hosted bearer gate, health, and lifecycle.
- `packages/decision-runtime-mcp`: ten Decision Runtime MCP tools and
  short-lived downstream OAuth client-credentials or asymmetric workload-JWT
  providers.
- `packages/openclaw-railway-installer`: shell-installs the OpenClaw Railway
  template and verifies the resulting proof instance — see
  [deploy/openclaw-railway](../deploy/openclaw-railway/README.md).
- `packages/openclaw-setup-applier`: reads a generated client profile and
  drives a live OpenClaw instance's `/setup` API idempotently — see
  [docs/setup-profile-applier.md](setup-profile-applier.md).
- `apps/api`: Hono API exposing public health, legacy shell compatibility, and
  the authenticated `/v1/runtime` command/query boundary.
- `apps/worker`: Optional workflow-neutral worker/readiness process.
- `apps/mcp`: Thin explicit composition of the MCP host and reviewed service
  modules; independently deployable from the API and worker.
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

Agents may consume the runtime through the MCP service. MCP supplies discovery,
schemas, annotations, and a server-generated tool invocation ID; the module
delegates through the same HTTP adapter and adds no authority. Successful
commands and denied command audits retain that invocation ID when present, so
transport calls remain correlated without making identity caller-controlled.
See [MCP Service Host And Decision Runtime Module](mcp-service.md). The HTTP
API remains the service boundary and PostgreSQL remains inaccessible to agents.

## Public Baseline

The repository includes the durable typed runtime, a production API target, an
optional worker target, generic `example.*` registrations and handlers, and a
public conformance suite. A deployment adds its own namespaced registrations,
handlers, identity policy, connectors, and private credentials.

External connectors and consumer-specific workflows remain out of scope for the
public baseline.

## Deployment Topology

The repository builds and deploys four independent Railway services from one
Git history. Each service owns its own project boundary, build boundary,
deployment boundary, and runtime boundary — they are not phases of one release.

- **Project boundary**: one repository, one default branch, four services.
- **Project placement**: the Decision Runtime services are provisioned in the
  same Railway project as a provisioned client instance, not in the project
  named for this repository. Because they are git-connected to the tracked
  branch, a merge that matches their watch patterns deploys them there — so a
  merge is a production event inside a client-facing project, with no promotion
  step between review and a running service. Placement is also what makes the
  deployment per-client rather than shared: a second such project would get its
  own Decision Runtime services, and one commit would reach every copy at once.

  This is an **accepted tradeoff**, not an oversight (issue #90). Relocating
  them into this repository's own project — with client instances reaching them
  over the authenticated `/v1/runtime` boundary that already exists — would
  remove both properties, but it means re-provisioning services, re-supplying
  every secret from its source of truth, and cutting a live client instance
  over to new URLs. That cost is not currently justified, because the practical
  symptom is already gone: scoping the watch patterns (issues #86, #89) means
  these services now deploy only on real Decision Runtime code changes rather
  than on every commit.

  Revisit if any of the following becomes true: a second project needs its own
  Decision Runtime services (fan-out stops being hypothetical), they start
  changing often enough that client-facing deploys become routine, or a client
  instance and the runtime need to be operated or handed off separately.
- **Service boundary**: each service selects its own config-as-code file
  (`railway.toml` for OpenClaw at the repository root;
  `deploy/decision-runtime/railway.toml` for the API;
  `deploy/decision-runtime/worker.railway.toml` for the worker;
  `deploy/decision-runtime-mcp/railway.toml` for the MCP service) and its own
  `dockerfilePath`. Railway otherwise discovers the root `railway.toml` by
  default, so every non-root service must point at its file explicitly.
- **Build boundary**: every Dockerfile shares the same Docker build context
  (the repository root, filtered by `.dockerignore`), but each Dockerfile's
  `COPY` instructions name a distinct, narrower set of source paths — its
  app directory plus the shared packages and root manifests it actually
  compiles against. A service's build boundary is exactly what its
  Dockerfile copies, nothing more.
- **Deployment boundary**: the decision-runtime API, worker, and MCP service
  each declare `build.watchPatterns` matching their own Dockerfile's build
  boundary; root OpenClaw declares none and deploys on every commit (see the
  diagram below). A commit that touches only paths outside a service's watch
  patterns does not create a deployment for that service — **rebuilding one
  sibling service does not rebuild another**. An *absent* `watchPatterns` is
  not a narrower boundary but the widest one — it deploys on every commit,
  which is deliberate for root OpenClaw and was a defect for the MCP service
  (issue #89). See [Private Decision Runtime
  Deployment](decision-runtime-deployment.md) for the full trigger
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
 ├─ deploy/decision-runtime/worker.railway.toml → decision-runtime worker service
 │                                                 (watchPatterns scoped to its
 │                                                  Dockerfile's build input)
 └─ deploy/decision-runtime-mcp/railway.toml   → decision-runtime MCP service
                                                 (watchPatterns scoped to its
                                                  Dockerfile's build input)
```
