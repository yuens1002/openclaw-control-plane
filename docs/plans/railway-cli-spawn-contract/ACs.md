# Railway CLI Spawn Contract Acceptance Criteria

**Branch:** `feat/railway-cli-spawn-contract`
**Plan:** `docs/plans/railway-cli-spawn-contract/plan.md`

## Context

`cli.ts` and `client-cli.ts` each wrap `child_process.spawn` in their own
`runCommand`, but every orchestration test drives them through a fake
`RailwayRunner` — the real spawn/stdin/stdout/exit-code path has almost no
test coverage, and that gap already caused one real secret-leak incident.
This plan adds real-process spawn-contract tests for both `runCommand`
implementations and dedupes the three near-identical `FakeRailwayRunner`
classes used elsewhere. Single session, D1-D10. No live Railway/network
access anywhere in this scope.

## Column Definitions

| Column | Filled by | When |
| --- | --- | --- |
| Plan ref | Author | At AC authoring; links each row to a plan deliverable ID. |
| Role | Author | At AC authoring; names the role that owns verification. |
| Agent | Verification sub-agent | During AC verification; PASS/FAIL with evidence. |
| QC | Main thread agent | After reading verification evidence; confirms or overrides. |
| Reviewer | Human reviewer | During manual review; final sign-off per AC. |

## Coverage Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-COV-001 | D8 | `/project-manager` | Plan exists | Code review: `docs/plans/railway-cli-spawn-contract/plan.md` | Plan names branch, source, current state (incl. the rejected provision→proof chain and the sibling-branch check), approach, deliverables with roles, design decisions, files to create/edit, gate 1/2 pre-check, commit schedule, dependencies, out of scope | | | |
| AC-COV-002 | D9 | `/project-manager` | ACs table exists | Code review: `docs/plans/railway-cli-spawn-contract/ACs.md` | Every AC row has a valid Plan ref (D1-D10) and Role; every deliverable D1-D10 is referenced by at least one row | | | |
| AC-COV-003 | D10 | `/project-manager` | Review scaffold exists | Code review: `docs/plans/railway-cli-spawn-contract/review.md` | Review doc has sections for verdict, deliverables↔code, ACs↔tests, docs drift, recommendations | | | |

## Functional Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-001 | D1 | `/backend-architect` | `runCommand` exported from `cli.ts` with no behavior change | Code review: `packages/openclaw-railway-installer/src/cli.ts` diff | Diff adds only the `export` keyword to the existing `runCommand` declaration; spawn options, stdout/stderr handling, and rejection message are byte-for-byte unchanged | | | |

## Test Coverage Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-TST-001 | D2 | `/test-engineer` | `cli.ts`'s `runCommand` — stdin round-trips byte-identical through a real spawned child | Test run: `npm test -- --run tests/openclaw-railway-cli.test.ts` | A real child process (via `process.execPath`, no fake `RailwayRunner` in the path) reads a stdin string containing characters that would reveal BOM/CRLF corruption (leading/trailing whitespace, non-ASCII) and the captured output equals that exact string; no literal pin against a value already living in source | | | |
| AC-TST-002 | D2 | `/test-engineer` | `cli.ts`'s `runCommand` — stdout is captured for parsing AND echoed to `process.stdout` | Test run: same file | A real spawned child's stdout appears both in the resolved `{stdout}` value and in a `process.stdout.write` spy call — asserts the relation (both sinks receive it), not a hardcoded string | | | |
| AC-TST-003 | D2 | `/test-engineer` | `cli.ts`'s `runCommand` — non-zero exit code | Test run: same file | A real spawned child exiting non-zero rejects with an `Error` whose message matches `railway <args> failed with exit code <code>: <stderr>`, built from that child's actual captured stderr, not a fake string | | | |
| AC-TST-004 | D3 | `/test-engineer` | `client-cli.ts`'s `runCommand` — stdin round-trips byte-identical through a real spawned child (closes the "issue #18" gap: previously only checked against the fake `RailwayRunner`) | Test run: `npm test -- --run tests/openclaw-railway-client-cli.test.ts` | Same invariant as AC-TST-001, applied to `client-cli.ts`'s `runCommand` | | | |
| AC-TST-005 | D3 | `/test-engineer` | `client-cli.ts`'s `runCommand` — non-zero exit code | Test run: same file | Same invariant as AC-TST-003, applied to `client-cli.ts`'s `runCommand` | | | |
| AC-TST-006 | D4, D5, D6, D7 | `/test-engineer` | Shared `FakeRailwayRunner` fixture — behavior-preserving migration | Test run: `npm test -- --run tests/openclaw-railway-installer.test.ts tests/openclaw-railway-provision-client.test.ts tests/openclaw-railway-update-client-ref.test.ts` | All three files pass with their pre-existing assertions unchanged; no test file under `tests/` defines its own `FakeRailwayRunner` class anymore (only `tests/fixtures/fake-railway-runner.ts` does) | | | |

## Regression Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-REG-001 | — | `/test-engineer` | All existing tests pass | Test run: `npm test` | Full suite passes with the new/migrated test files included, 0 failures | | | |
| AC-REG-002 | — | `/devops` | Typecheck and build stay clean | Test run: `npm run typecheck`, `npm run build` | 0 type errors, build succeeds | | | |

---

## Agent Notes

{Sub-agent writes: overall result, test counts, notable findings, anything that deviated from the Pass criteria description}

## QC Notes

{Main thread writes: fix descriptions, override rationale, iteration count}

## Reviewer Feedback

*Human fills this section during review.*
