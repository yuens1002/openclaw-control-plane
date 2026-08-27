# Denied Tool Invocation Audit Review

Plan: `docs/plans/denied-tool-invocation-audit/plan.md`

Corrected implementation SHA: `03817e8878930864dd48d2fb059c4ea9973aa996`

Independently reviewed evidence SHA:
`231b149ff4aa252128d3ccaea2d8ac3e5bf5d6e6`

Status: local implementation verification and independent exact-head Copilot
review passed; final publication-head CI and operating-owner merge gate pending

## Verdict

PASS for implementation and independent review. Copilot recommended approval on
the exact evidence head with no new findings. Publication and merge remain
blocked until CI and the operating-owner gate clear on the final PR head.

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
| Independent review | Copilot recommended approval on exact head `231b149` after verifying the empty-value correction; no current-head finding was added |

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

Copilot's re-review then found the repository's conditional construction still
used truthiness, allowing a direct caller's empty value to be omitted before
schema parsing. The final correction uses explicit `undefined` checks for both
typed payload and canonical evidence, with direct PostgreSQL coverage for empty
and malformed values. The 434-test full suite and runtime image build pass.

## Residual Risks

- Final publication-head CI and the operating-owner merge gate remain pending.
- The change correlates denied command calls; it does not add successful read
  authorization auditing.
