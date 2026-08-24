# Durable Typed Runtime State Plan

Issue: https://github.com/yuens1002/openclaw-control-plane/issues/38
Branch: `feat/durable-runtime-state`
Status: approved for implementation

## Outcome

Replace the API's process-local event persistence with a generic, typed runtime
service backed by PostgreSQL. Preserve the M1 schema and public event behavior
while adding durable registrations, streams, provenance, action attribution,
idempotency, results, projections, and bounded denial auditing from ADR 0002.

## Boundaries

- This repository owns generic runtime primitives and `example.*` fixtures.
- Consumer workflow schemas and presentation concepts remain external.
- Issue #38 accepts trusted command context through dependency injection.
- Credential verification and authorization-policy evaluation belong to #39
  and ADR 0003.
- Existing M1 rows and domain tables are preserved through additive migration.

## Deliverables

| ID | Deliverable | Evidence |
| --- | --- | --- |
| D1 | Runtime Zod contracts for kinds, registrations, command context, references, commands, and records | contract tests |
| D2 | Deterministic type/operation registry with active/retired lifecycle and `example.*` fixtures | registry tests |
| D3 | Additive M2 Drizzle schema and SQL migration preserving every M1 table | schema/migration tests |
| D4 | PostgreSQL runtime repository with transactional stream ordering, typed records, edges, idempotency, and projections | repository integration tests |
| D5 | RFC 8785 canonical command digest, replay/conflict semantics, and approval binding | canonicalization/idempotency tests |
| D6 | Principal-aware runtime service, action attribution, and bounded denial-audit operation | service tests |
| D7 | API dependency injection and PostgreSQL startup/readiness wiring while preserving `/events` compatibility | API tests |
| D8 | Public conformance suite covering restart, rollback, provenance, projection rebuild, spoof resistance, and migration | focused and full test runs |
| D9 | ADR 0002 plus workflow-neutral updates to related public architecture documentation | documentation review |
| D10 | Final review with acceptance evidence, residual risk, and exact-head status | `review.md` |

## Implementation Order

1. Add public contracts and failing contract/registry tests.
2. Add the M2 schema and migration, then migration-shape tests.
3. Implement canonicalization, registry, and repository transactions.
4. Add the principal-aware service and compatibility event adapter.
5. Wire API construction and readiness through injected dependencies.
6. Run focused tests, PostgreSQL integration tests, full regression, build, and
   static checks.
7. Perform independent review and correct every current-head blocker.

## Release Gates

- Every acceptance row has executed Agent and QC evidence.
- M1 data is preserved; no destructive migration appears in the diff.
- Same-stream writes serialize through a transactional stream counter.
- Equal retries produce one effect; changed payloads conflict and are audited.
- Actor identity comes only from trusted command context.
- Denied authorization creates audit only, with no work or effect.
- Projection rebuild is deterministic from durable sequence and checkpoint.
- Existing event and control-plane tests remain green.
- No consumer-specific workflow or private repository is required.
