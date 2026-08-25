# Authenticated Typed-Work API Plan

Issue: https://github.com/yuens1002/openclaw-control-plane/issues/39
Branch: `feat/authenticated-typed-work-api`
Status: implemented and independently verified; pending human review and PR publication

## Delivery Process

Use this repository's plan, acceptance, implementation, independent
verification, review, and release convention. Implementation begins only after
the plan is approved; no pull request is opened for planning alone.

## Outcome

Turn the durable runtime delivered by issues #38 and #53 into a portable,
authenticated service. HTTP and tool callers authenticate with OIDC bearer
tokens, resolve to stable configured principals, pass a replaceable
authorization boundary, and reach bounded typed commands and queries using only
server-derived trusted context. The existing production target gains identity
and JWKS readiness, smoke, backup/restore, and rollback evidence.

## Pre-Implementation Baseline

The following observations describe the repository at planning time, before the
issue #39 implementation commits. They are retained as decision context, not as
claims about the implemented branch.

- ADR 0002 and issue #38 provide the typed registry, PostgreSQL repository,
  principal-aware command service, provenance, idempotency, approvals,
  projections, and bounded denial audit.
- Issue #53 provides the compiled API image, startup migrations, pooled/direct
  database connections, and a private production service profile.
- Operational POST routes currently fail closed because `server.ts` does not
  construct trusted command context.
- The API exposes legacy shell routes and only persistence readiness. The
  repository has record, stream, edge, and projection reads but no bounded,
  paginated public query contract.
- `packages/openclaw-adapter` is an unauthenticated client for the legacy shell
  routes. `apps/worker` is a workflow-neutral placeholder.

## Architecture Decisions

1. Add a transport-neutral `packages/runtime-auth` package. It owns versioned
   identity/policy configuration, OIDC verification, principal resolution,
   delegation, static RBAC, and trusted-context construction. It may depend on
   `jose` for standards-compliant JWT/JWK/JWKS behavior; it does not depend on
   Hono or PostgreSQL.
2. Keep HTTP concerns in `apps/api`. Authentication middleware supplies a
   verified caller. Each route declares an authorization action and resource,
   asks the injected policy provider for a decision, and constructs trusted
   context on the server. Request bodies cannot supply identity, roles,
   delegation decisions, authorization evidence, digests, request IDs, or
   timestamps that the server owns.
3. Add one versioned `/v1/runtime` surface. Events and work items accept
   registered typed payloads. Approval decisions are authenticated and stored
   against a server-built immutable command revision. Execution accepts that
   approval record's ID rather than caller-authored approver evidence, rebuilds
   and digests the actual command, and invokes `PrincipalAwareRuntimeService`.
   Queries expose bounded registration, record, stream, provenance, projection,
   and audit views that cover every runtime kind without workflow-specific
   routes.
4. Preserve `/events` compatibility, but route authenticated writes through the
   same identity and authorization coordinator. Legacy pipeline stubs are not
   expanded as part of this issue.
5. Make `packages/openclaw-adapter` a thin typed client of the versioned API.
   It receives bearer tokens through an injected async token provider and never
   accepts or forwards trusted-context fields.
6. Extend the deployment delivered by #53. Do not create a second runtime or
   require a particular database/identity vendor. The production profile must
   disable Basic Auth, validate identity/policy configuration before serving,
   report identity and required-JWKS readiness separately, and support an
   optional independently deployed workflow-neutral worker process.
7. Treat denied command and query attempts as service operations. Adapters call
   the bounded runtime denial-audit boundary and never write audit tables. Any
   small service-boundary extension needed for query denials must preserve ADR
   0002's invariant that a denial cannot create work, attempts, results,
   artifacts, or projection effects.

## Public Surface

The implementation may refine names during role-level design, but it must keep
this bounded shape and version prefix:

- `POST /v1/runtime/events` ingests a registered typed event.
- `POST /v1/runtime/work-items` creates a registered typed work item derived
  from authorized record references.
- `POST /v1/runtime/approvals` records an authenticated approve/reject decision
  for a server-canonicalized command revision and returns its immutable ID.
- `POST /v1/runtime/commands` validates a registered operation, rebuilds the
  canonical command, resolves optional approval evidence by immutable record
  ID, and executes it.
- `GET /v1/runtime/registrations` lists active public type and operation
  registrations with bounded filters.
- `GET /v1/runtime/records/:recordId` reads one authorized runtime record.
- `GET /v1/runtime/streams/:streamId/records` lists authorized records with
  kind/type/sequence filters and a bounded cursor page.
- `GET /v1/runtime/records/:recordId/edges` traverses authorized provenance.
- `GET /v1/runtime/projections/:projectionType/:subjectType/:subjectId` reads
  one authorized projection version.
- `GET /v1/runtime/audit` lists authorized audit history with bounded filters
  and a cursor page.
- `GET /health` remains public and reports non-secret readiness dimensions.

All error responses use one stable, documented envelope. Authentication and
authorization failures reveal no private configuration, token claims, or
cross-resource existence. Query limits and cursor validation are server-owned.

## Deliverables

| ID | Deliverable | Kind | Owning role | Concrete artifacts |
| --- | --- | --- | --- | --- |
| D1 | Plan, ACs, and review scaffold | docs | project-manager | `docs/plans/authenticated-typed-work-api/{plan.md,ACs.md,review.md}` |
| D2 | Versioned identity and policy contracts | schema/config | security | Public Zod schemas and loader for issuer, principal, actor, role, grant, delegation, provider, environment-mode, and bounded readiness configuration; generic `example.*` fixtures |
| D3 | OIDC verification and stable principal resolution | authentication service | security | `packages/runtime-auth` JWT verifier using configured issuer/JWKS/audience/algorithm/clock-skew rules, deterministic JWKS refresh behavior, and `(issuer, subject)` mapping |
| D4 | Replaceable authorization and trusted-context coordinator | authorization service | security | Authorization interface, `static-rbac-v1`, delegation checks, server-derived actor/context, stable decisions/reasons, and bounded denial routing |
| D5 | Bounded runtime command/query service boundary | repository/service API | backend-architect | Typed event/work-item creation, authenticated immutable approval recording/resolution, registered-type/operation reads, kind-complete record/provenance/projection/audit queries, cursor bounds, and denial-audit support without direct adapter persistence |
| D6 | Authenticated versioned HTTP API | endpoint/middleware | backend-architect | OIDC middleware, route authorization catalog, `/v1/runtime` command/query routes, stable error envelope, `/events` compatibility, and server startup wiring |
| D7 | Authenticated tool adapter | adapter/client | backend-architect | Bearer token-provider support and typed command/query tools in `packages/openclaw-adapter`, with no caller-supplied trusted context |
| D8 | Production profile and recovery operations | deployment/operations | devops | Existing decision-runtime image/profile updates, optional worker target, production auth guard, expanded readiness, deterministic smoke command, backup/restore validation, key-rotation and rollback runbook |
| D9 | Public conformance and security test suite | tests | test-engineer | Local issuer/JWKS fixtures plus unit, API, PostgreSQL, container, smoke, restart, and recovery tests covering issue #39 |
| D10 | Generic public documentation and ADR synchronization | docs | project-manager | API/auth configuration reference, operator guide updates, ADR status/implementation notes, and repo-wide public-boundary audit with no external process dependency |
| D11 | Exact-head consolidated review | review | test-engineer | Final `review.md` with per-AC evidence, independent QC, residual risks, dependency audit, and exact commit SHA |

## Session Breakdown

### Session 1: Trust Boundary

Implement D2-D4 with failing fixtures first. The exit gate is deterministic
OIDC verification, stable principal resolution, configuration validation,
static RBAC, delegation, and denial routing without any HTTP dependency.

### Session 2: Runtime Interfaces

Implement D5-D7. The exit gate is a versioned HTTP surface and tool client that
preserve typed validation, idempotency, approval binding, attribution, and
bounded reads while rejecting every trust-field spoof.

### Session 3: Production Proof

Implement D8-D10 and complete D9 across the integrated system. The exit gate is
an empty-database deploy smoke, restart proof, backup/restore reconstruction,
key-rotation proof, production-auth check, full regression suite, build, image
inspection, and public documentation audit.

### Session 4: Verification And Release

Complete D11 through an independent exact-head review. Correct every blocker,
fill Agent and QC evidence per AC, present the result for human review, then
open the implementation PR only after approval.

## Commit Schedule

1. Plan: `docs: add plan for authenticated typed-work API`
2. ACs: `docs: add ACs for authenticated typed-work API`
3. Contracts: `feat(runtime-auth): add versioned identity and policy config`
4. Authentication: `feat(runtime-auth): verify OIDC tokens and resolve principals`
5. Authorization: `feat(runtime-auth): add static RBAC and trusted context`
6. Query boundary: `feat(runtime): add bounded typed-work queries`
7. HTTP adapter: `feat(api): expose authenticated typed-work routes`
8. Tool adapter: `feat(adapter): add authenticated typed-work tools`
9. Operations: `feat(deploy): harden authenticated runtime profile and recovery`
10. Conformance: `test(runtime): prove authenticated API and recovery contract`
11. Documentation: `docs: publish runtime authentication and operations guide`
12. Verification: `docs: record authenticated runtime verification`

Before every shared-branch push, fetch and compare the exact branch head. Each
logical implementation commit must pass focused tests, typecheck, build, and
`git diff --check`; the final verification commit must pass the full release
gate.

## Release Gates

- Every D1-D11 deliverable has acceptance coverage and every AC has executed
  Agent and independent QC evidence on the exact head.
- Valid OIDC credentials resolve stable identity; every invalid credential and
  invalid production configuration fails closed before typed-work execution.
- The authorization provider is replaceable and the reference static RBAC
  implementation obeys exact action/resource and delegation rules from ADR
  0003.
- No transport payload can control trusted identity, delegation, authorization,
  digest, request ID, or server timestamps.
- Denials are durably auditable through the service boundary and create no
  operational effect.
- Commands and reads cover every runtime primitive through bounded generic
  contracts; no consumer workflow is built into the public baseline.
- HTTP and tool paths preserve registry lifecycle, idempotency, approval digest,
  provenance, attribution, and stable error behavior.
- Readiness distinguishes API, database, migrations, registry, identity/policy,
  and required JWKS state without leaking secrets.
- Production disables Basic Auth and proves migrate, command, query, restart,
  backup/restore, and rollback behavior against PostgreSQL.
- Full tests, PostgreSQL integration, typecheck, build, container build/smoke,
  production dependency audit, generic-language audit, and `git diff --check`
  pass.

## Non-Goals

- Replacing ADR 0002's persistence model or creating consumer-specific tables.
- Requiring a particular hosted identity, policy, database, or deployment
  vendor.
- Publishing private principals, policies, repositories, agents, organizations,
  domains, credentials, or workflow schemas.
- Giving callers raw database access or exposing unbounded record scans.
- Building a consumer workflow into `apps/worker`; the reference worker remains
  modular and workflow-neutral.
- Expanding the legacy pipeline-control stubs into a second public API.
- Mutating a named live environment during implementation without a separate,
  explicit release authorization.
