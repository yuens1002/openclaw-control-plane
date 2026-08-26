# Denied Tool Invocation Audit Review

Plan: `docs/plans/denied-tool-invocation-audit/plan.md`

Corrected implementation SHA: `c4efe6d6021638a6bcff66863b59f227c5b73a6b`

Status: local implementation verification passed; independent QC, CI, and PR
review pending

## Verdict

PASS for local implementation verification. Publication and merge remain
blocked on independent exact-head review and CI.

## Executed Evidence

| Gate | Result |
| --- | --- |
| Focused contract/API/PostgreSQL/MCP | 50/50 passed after Copilot corrections |
| Full regression | 434/434 passed across 52 files with disposable PostgreSQL |
| TypeScript and build | `npm run typecheck` and `npm run build` passed |
| Production dependency audit | `npm audit --omit=dev` found zero vulnerabilities |
| Runtime image | Decision Runtime Docker image built; production prune found zero vulnerabilities |
| MCP image | Decision Runtime MCP Docker image built; production prune found zero vulnerabilities |
| Public-language scan | No deployment identity, live endpoint, or credential material found; the repository issue URL and generic `principal://` contract examples were the only expected matches |
| Diff check | `git diff --check` passed before implementation commit |

## Findings

The implementation preserves the validated optional identifier in the typed
denial payload and canonical denial evidence. API tests prove malformed values
fail before persistence, PostgreSQL proves tool and headerless compatibility,
and the existing stdio MCP process test still proves server-generated IDs.

Copilot's first review found two blockers: the command-denial constructor did
not parse its payload before persistence, and an explicitly empty invocation
header was treated as absent. The correction validates at the repository
boundary, distinguishes header absence from an empty value, and adds direct
repository plus API regression cases. Corrected focused and full suites pass.

## Residual Risks

- CI and independent exact-head review have not run yet.
- The change correlates denied command calls; it does not add successful read
  authorization auditing.
