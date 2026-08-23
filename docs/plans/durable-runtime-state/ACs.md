# Durable Typed Runtime State Acceptance Criteria

Plan: `docs/plans/durable-runtime-state/plan.md`

| ID | Plan ref | Acceptance criterion | Executable pass condition | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- |
| AC-CONTRACT-001 | D1 | Independent typing | Tests reject unknown kinds and unsafe type names while preserving independent kind, type, operation, subject, result, and artifact identifiers. | pending | pending | pending |
| AC-CONTRACT-002 | D1 | Trusted command context | Tests prove payload actor/delegation/authorization fields cannot replace server-supplied context. | pending | pending | pending |
| AC-REGISTRY-001 | D2 | Registration lifecycle | Identical registration is idempotent; conflicting digest fails; retirement blocks new writes and preserves historical reads. | pending | pending | pending |
| AC-REGISTRY-002 | D2 | Public fixtures | Startup loads only workflow-neutral `example.*` type and operation fixtures. | pending | pending | pending |
| AC-MIGRATION-001 | D3 | Additive migration | Static and PostgreSQL tests prove all M1 tables remain, legacy rows remain readable, and required backfills use explicit `legacy.*` registrations/principals. | pending | pending | pending |
| AC-MIGRATION-002 | D3 | Empty database | Applying M1 then M2 to an empty PostgreSQL database succeeds without manual intervention. | pending | pending | pending |
| AC-STORE-001 | D4 | Restart persistence | Records, edges, idempotency state, and projections remain readable from a newly constructed repository. | pending | pending | pending |
| AC-STORE-002 | D4 | Atomicity | A forced failure leaves no partial records, edges, idempotency claims, stream advance, or projection checkpoint. | pending | pending | pending |
| AC-STORE-003 | D4 | Stream ordering | Concurrent same-stream appends receive unique contiguous order and commit in that order. | pending | pending | pending |
| AC-PROVENANCE-001 | D4 | Traversable graph | Tests traverse ordered many-to-many edges from event through work, attempt, results/artifacts, approval, and audit. | pending | pending | pending |
| AC-IDEMPOTENCY-001 | D5 | Replay lifecycle | Equal in-progress and terminal retries return one stable operation reference and result. | pending | pending | pending |
| AC-IDEMPOTENCY-002 | D5 | Conflict | Reusing principal/operation/key with a changed canonical version or digest fails and records conflict audit. | pending | pending | pending |
| AC-APPROVAL-001 | D5 | Approval binding | RFC 8785 digest recomputation detects changed target, arguments, or declared effects before execution. | pending | pending | pending |
| AC-SERVICE-001 | D6 | Action attribution | Persisted attempt retains principal, actor/delegation, authorization evidence, origin, operation, subject, trigger, causation, correlation, request/tool IDs, inputs, results, timestamps, and outcome. | pending | pending | pending |
| AC-SERVICE-002 | D6 | Denial boundary | A denied command creates one audit entry and no work item, attempt, result, artifact, or projection effect. | pending | pending | pending |
| AC-API-001 | D7 | Compatibility | Existing `/events` inserted/duplicate behavior and validation tests pass through the injected service boundary. | pending | pending | pending |
| AC-API-002 | D7 | Readiness | Health reports database, migration, and registry readiness independently; startup fails closed on invalid registry or migration state. | pending | pending | pending |
| AC-CONFORMANCE-001 | D8 | Full verification | Typecheck, focused tests, full tests, build, and `git diff --check` pass on the exact head. | pending | pending | pending |
| AC-DOCS-001 | D9 | Public boundary | ADRs and public docs explain generic what/why and contain no private consumer dependency or unpublished process requirement. | pending | pending | pending |
| AC-REVIEW-001 | D10 | Truthful final review | `review.md` records only executed evidence, open risks, and exact-head status. | pending | pending | pending |
