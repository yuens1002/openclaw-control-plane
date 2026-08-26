# Denied Tool Invocation Audit Acceptance Criteria

Plan: `docs/plans/denied-tool-invocation-audit/plan.md`

Status: implementation pending

| AC | Plan ref | Role | What | Pass condition | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AC-PLAN-001 | D1 | project-manager | Workflow contract | D1-D5, decisions, non-goals, sequence, and release gates are explicit before implementation. | PASS - contract authored before code changes. | pending | pending |
| AC-CONTRACT-001 | D2 | backend-architect | Typed optional provenance | The denial input and typed audit payload accept a validated optional tool invocation ID and omit it when absent. | pending | pending | pending |
| AC-API-001 | D2 | security | Trusted header propagation | The API forwards only the validated `x-tool-invocation-id`; identity, actor, and authorization remain server-derived. | pending | pending | pending |
| AC-DENIAL-001 | D3 | test-engineer | Tool-origin denial | A policy-denied registered command with the header returns `403` and persists request ID, invocation ID, trusted principal/actor, `request_origin: tool`, and denial evidence. | pending | pending | pending |
| AC-DENIAL-002 | D3 | test-engineer | Effect-free denial | The denied probe creates one audit entry and no action-attempt or result record. | pending | pending | pending |
| AC-COMPAT-001 | D3 | test-engineer | Headerless compatibility | A denied command without the header retains `request_origin: http` and omits `tool_invocation_id`. | pending | pending | pending |
| AC-MCP-001 | D3 | test-engineer | MCP correlation | The MCP integration test proves its generated invocation ID reaches the denied audit path. | pending | pending | pending |
| AC-DOCS-001 | D4 | project-manager | Portable documentation | Public docs and changelog describe generic denied-tool provenance without deployment-specific identities, endpoints, or secrets. | pending | pending | pending |
| AC-REVIEW-001 | D5 | test-engineer | Exact-head verification | Focused/full tests, PostgreSQL, typecheck, build, audit, Docker, diff, CI, and external review pass on the merge head. | pending | pending | pending |
