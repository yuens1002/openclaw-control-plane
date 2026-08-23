# Durable Typed Runtime State Acceptance Criteria

Plan: `docs/plans/durable-runtime-state/plan.md`

Evidence notation: `pass` means the acceptance-specific test named by the
executable condition passed in the final 285-test run. `QC 3704a47` records the
independent implementation review of that exact SHA. The Reviewer column stays
open for pull-request review.

| ID | Plan ref | Acceptance criterion | Executable pass condition | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- |
| AC-CONTRACT-001 | D1 | Independent typing | Tests reject unknown kinds and unsafe type names while preserving independent kind, type, operation, subject, result, and artifact identifiers. | pass | QC 3704a47 | pending PR review |
| AC-CONTRACT-002 | D1 | Trusted command context | Tests prove payload actor/delegation/authorization fields cannot replace server-supplied context. | pass | QC 3704a47 | pending PR review |
| AC-REGISTRY-001 | D2 | Registration lifecycle | Identical registration is idempotent; conflicting digest fails; retirement blocks new writes and preserves historical reads. | pass | QC 3704a47 | pending PR review |
| AC-REGISTRY-002 | D2 | Public fixtures | Startup loads only workflow-neutral `example.*` type and operation fixtures. | pass | QC 3704a47 | pending PR review |
| AC-MIGRATION-001 | D3 | Additive migration | Static and PostgreSQL tests prove all M1 tables remain, legacy rows remain readable, and required backfills use explicit `legacy.*` registrations/principals. | pass | QC 3704a47 | pending PR review |
| AC-MIGRATION-002 | D3 | Empty database | Applying M1 then M2 to an empty PostgreSQL database succeeds without manual intervention. | pass | QC 3704a47 | pending PR review |
| AC-STORE-001 | D4 | Restart persistence | Records, edges, idempotency state, and projections remain readable from a newly constructed repository. | pass | QC 3704a47 | pending PR review |
| AC-STORE-002 | D4 | Atomicity | A forced failure leaves no partial records, edges, idempotency claims, stream advance, or projection checkpoint. | pass | QC 3704a47 | pending PR review |
| AC-STORE-003 | D4 | Stream ordering | Concurrent same-stream appends receive unique contiguous order and commit in that order. | pass | QC 3704a47 | pending PR review |
| AC-PROVENANCE-001 | D4 | Traversable graph | Tests traverse ordered many-to-many edges from event through work, attempt, results/artifacts, approval, and audit. | pass | QC 3704a47 | pending PR review |
| AC-IDEMPOTENCY-001 | D5 | Replay lifecycle | Equal in-progress and terminal retries return one stable operation reference and result. | pass | QC 3704a47 | pending PR review |
| AC-IDEMPOTENCY-002 | D5 | Conflict | Reusing principal/operation/key with a changed canonical version or digest fails and records conflict audit. | pass | QC 3704a47 | pending PR review |
| AC-APPROVAL-001 | D5 | Approval binding | RFC 8785 digest recomputation detects changed target, arguments, or declared effects before execution. | pass | QC 3704a47 | pending PR review |
| AC-SERVICE-001 | D6 | Action attribution | Persisted attempt retains principal, actor/delegation, authorization evidence, origin, operation, subject, trigger, causation, correlation, request/tool IDs, inputs, results, timestamps, and outcome. | pass | QC 3704a47 | pending PR review |
| AC-SERVICE-002 | D6 | Denial boundary | A denied command creates one audit entry and no work item, attempt, result, artifact, or projection effect. | pass | QC 3704a47 | pending PR review |
| AC-API-001 | D7 | Compatibility | Existing `/events` inserted/duplicate behavior and validation tests pass through the injected service boundary. | pass | QC 3704a47 | pending PR review |
| AC-API-002 | D7 | Readiness | Health reports database, migration, and registry readiness independently; startup fails closed on invalid registry or migration state. | pass | QC 3704a47 | pending PR review |
| AC-CONFORMANCE-001 | D8 | Full verification | Typecheck, focused tests, full tests, build, and `git diff --check` pass on the exact head. | pass | QC 3704a47 | pending PR review |
| AC-DOCS-001 | D9 | Public boundary | ADRs and public docs explain generic what/why and contain no private consumer dependency or unpublished process requirement. | pass | QC 3704a47 | pending PR review |
| AC-REVIEW-001 | D10 | Truthful final review | `review.md` records only executed evidence, open risks, and exact-head status. | pass | QC 3704a47 | pending PR review |
