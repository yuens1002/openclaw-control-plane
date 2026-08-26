# MCP Workload JWT Authentication Acceptance Criteria

Plan: `docs/plans/mcp-workload-jwt-auth/plan.md`

Status: implementation and verification pending

| AC | Plan ref | Role | What | Pass condition | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AC-PLAN-001 | D1 | project-manager | Workflow contract | D1-D6 have coverage; decisions, boundaries, sequence, and release gates are explicit before implementation. | pending | pending | pending |
| AC-TOKEN-001 | D2 | security | Valid workload token | Exact claims and protected header are signed with each supported algorithm family and verify against deterministic public keys. | pending | pending | pending |
| AC-TOKEN-002 | D2 | security | Configuration bounds | Missing fields, unsafe issuer, unsupported algorithm, wrong key family, malformed/non-PKCS#8 key, invalid lifetime, and invalid skew fail closed before transport startup. | pending | pending | pending |
| AC-TOKEN-003 | D2 | security | Cache and concurrency | Tokens are reused only before refresh/expiry, concurrent signing coalesces, invalidation works, and no credential is persisted. | pending | pending | pending |
| AC-TOKEN-004 | D2 | security | Secret-safe failures | Sentinel private keys, tokens, and credentials never enter errors, logs, status, readiness, or public results. | pending | pending | pending |
| AC-CONFIG-001 | D3 | backend-architect | Provider discrimination | OAuth remains the default; workload mode requires only its fields; missing, mixed, and inactive-provider credentials fail startup. | pending | pending | pending |
| AC-CONFIG-002 | D3 | backend-architect | Thin composition | `apps/mcp` selects a provider and otherwise retains the same module, host, transport, health, and shutdown behavior. | pending | pending | pending |
| AC-INTEGRATION-001 | D4 | test-engineer | Runtime verification | A workload JWT is accepted by the real runtime authentication service and resolves the expected configured principal. | pending | pending | pending |
| AC-INTEGRATION-002 | D4 | test-engineer | Hosted readiness | The production-shaped hosted app reaches ready with workload JWT auth, serves a representative runtime read, and degrades safely on signing or upstream failure. | pending | pending | pending |
| AC-REGRESSION-001 | D4 | test-engineer | OAuth and repository regression | Existing OAuth conformance plus full tests, typecheck, build, audit, Docker proof, and diff checks pass. | pending | pending | pending |
| AC-DOCS-001 | D5 | project-manager | Portable guidance | Docs explain mode selection, variables, secret placement, key publication/rotation, health, and rollback without consumer-specific details. | pending | pending | pending |
| AC-REVIEW-001 | D6 | test-engineer | Exact-head review | Review records exact SHA, commands, evidence, residual risks, and no unresolved blocker before PR publication or merge. | pending | pending | pending |
