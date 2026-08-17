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
| AC-COV-001 | D8 | `/project-manager` | Plan exists | Code review: `docs/plans/railway-cli-spawn-contract/plan.md` | Plan names branch, source, current state (incl. the rejected provision→proof chain and the sibling-branch check), approach, deliverables with roles, design decisions, files to create/edit, gate 1/2 pre-check, commit schedule, dependencies, out of scope | PASS - all sections present, incl. rejected-chain rationale and sibling-branch check. | CONFIRMED - re-read after adding the `tests/tsconfig.json` row to Files to Edit (discovered mid-Implement); still complete. | |
| AC-COV-002 | D9 | `/project-manager` | ACs table exists | Code review: `docs/plans/railway-cli-spawn-contract/ACs.md` | Every AC row has a valid Plan ref (D1-D10, or `—` for cross-cutting regression rows) and Role; every deliverable D1-D10 is referenced by at least one row | PASS, WITH A WORDING GAP - agent flagged AC-REG-001/002's `—` Plan ref as technically violating the original "(D1-D10)"-only wording, though every deliverable is still covered. | CONFIRMED-WITH-FIX - Pass cell wording corrected in this row to explicitly allow `—` for regression rows, matching this repo's own `setup-api-basic-auth/ACs.md` convention; no coverage gap existed. | |
| AC-COV-003 | D10 | `/project-manager` | Review scaffold exists | Code review: `docs/plans/railway-cli-spawn-contract/review.md` | Review doc has sections for verdict, deliverables↔code, ACs↔tests, docs drift, recommendations | FAIL - `review.md` did not exist yet at verification time (expected sequencing per Commit Schedule item 5, not a code defect). | CONFIRMED-WITH-FIX - `review.md` authored immediately after this QC pass, in the same session; see that file. | |

## Functional Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-001 | D1 | `/backend-architect` | `runCommand` exported from `cli.ts` with no behavior change | Code review: `packages/openclaw-railway-installer/src/cli.ts` diff | Diff adds only the `export` keyword to the existing `runCommand` declaration; spawn options, stdout/stderr handling, and rejection message are byte-for-byte unchanged | PASS - diff is a single-line change, `export` keyword only. | CONFIRMED - matches. | |

## Test Coverage Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-TST-001 | D2 | `/test-engineer` | `cli.ts`'s `runCommand` — stdin round-trips byte-identical through a real spawned child | Test run: `npm test -- --run tests/openclaw-railway-cli.test.ts` | A real child process (via `process.execPath`, no fake `RailwayRunner` in the path) reads a stdin string containing characters that would reveal BOM/CRLF corruption (leading/trailing whitespace, non-ASCII) and the captured output equals that exact string; no literal pin against a value already living in source | PASS - `tests/openclaw-railway-cli.test.ts:39-49`, real `process.execPath` spawn, no fake runner; asserts `result.stdout === payload` plus explicit no-BOM/no-CRLF checks. 5/5 tests pass. | CONFIRMED - matches. | |
| AC-TST-002 | D2 | `/test-engineer` | `cli.ts`'s `runCommand` — stdout is captured for parsing AND echoed to `process.stdout` | Test run: same file | A real spawned child's stdout appears both in the resolved `{stdout}` value and in a `process.stdout.write` spy call — asserts the relation (both sinks receive it), not a hardcoded string | PASS - `:58-68`, spy + `result.stdout` both asserted against the real child's output. | CONFIRMED - matches. | |
| AC-TST-003 | D2 | `/test-engineer` | `cli.ts`'s `runCommand` — non-zero exit code | Test run: same file | A real spawned child exiting non-zero rejects with an `Error` whose message matches `railway <args> failed with exit code <code>: <stderr>`, built from that child's actual captured stderr, not a fake string | PASS - `:70-74`, real child exits 3 with stderr `boom`; rejection message asserted. | CONFIRMED - matches. | |
| AC-TST-004 | D3 | `/test-engineer` | `client-cli.ts`'s `runCommand` — stdin round-trips byte-identical through a real spawned child (closes the "issue #18" gap: previously only checked against the fake `RailwayRunner`) | Test run: `npm test -- --run tests/openclaw-railway-client-cli.test.ts` | Same invariant as AC-TST-001, applied to `client-cli.ts`'s `runCommand` | PASS - `tests/openclaw-railway-client-cli.test.ts:69-79`. 9/9 tests pass; pre-existing no-echo test not duplicated. | CONFIRMED - matches. | |
| AC-TST-005 | D3 | `/test-engineer` | `client-cli.ts`'s `runCommand` — non-zero exit code | Test run: same file | Same invariant as AC-TST-003, applied to `client-cli.ts`'s `runCommand` | PASS - `:81-85`. | CONFIRMED - matches. | |
| AC-TST-006 | D4, D5, D6, D7 | `/test-engineer` | Shared `FakeRailwayRunner` fixture — behavior-preserving migration | Test run: `npm test -- --run tests/openclaw-railway-installer.test.ts tests/openclaw-railway-provision-client.test.ts tests/openclaw-railway-update-client-ref.test.ts` | All three files pass with their pre-existing assertions unchanged; none of D5's/D6's/D7's three files defines its own `FakeRailwayRunner` class anymore (only `tests/fixtures/fake-railway-runner.ts` does) | PASS, WITH A WORDING GAP - fixture + all three migrations verified line-by-line against `origin/main`, assertions unchanged, 17/17 pass. Agent flagged the original Pass wording ("no test file under `tests/`...") as overbroad: 3 other, out-of-scope files (`openclaw-setup-applier-railway-variables.test.ts`, `openclaw-setup-applier-apply-profile.test.ts`, `openclaw-railway-installer-readiness.test.ts`) still define their own private fakes, untouched by this branch. | CONFIRMED-WITH-FIX - Pass cell wording narrowed in this row to D5/D6/D7's three files specifically, matching the plan's actual Out-of-Scope section; not a code gap, a wording-precision fix. | |

## Regression Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-REG-001 | — | `/test-engineer` | All existing tests pass | Test run: `npm test` | Full suite passes with the new/migrated test files included, 0 failures | PASS - 21 files, 133 tests, 0 failures. | CONFIRMED - re-ran after ACs.md wording fixes; unaffected (docs-only), still 133/133. | |
| AC-REG-002 | — | `/devops` | Typecheck and build stay clean | Test run: `npm run typecheck`, `npm run build` | 0 type errors, build succeeds | PASS - typecheck clean, build clean. | CONFIRMED - unchanged. | |

---

## Agent Notes

Scope check clean: `git diff origin/main` (working tree) touches exactly the files named in the plan's Files to Create/Edit tables, no extras. 12/12 ACs reviewed; 10 straightforward PASS, 1 sequencing FAIL (AC-COV-003 — `review.md` not yet written at verification time, expected per Commit Schedule ordering), 2 wording-precision gaps in the ACs doc itself (AC-COV-002, AC-TST-006) where the Pass cell's literal text was broader than what the plan actually scoped. No code defects found — the `cli.ts` export, both spawn-contract test suites, and the fixture-dedup migration all do exactly what the plan and ACs describe, and every named test genuinely exercises a real spawned child process where claimed (not a fake `RailwayRunner`), which was the entire point of this feature. Full test/typecheck/build run clean (133 tests, 0 failures; 0 type errors).

## QC Notes

Fix count: 2 ACs-doc wording fixes (AC-COV-002, AC-TST-006), 1 new file (`review.md`, this session, immediately after this QC pass). No test or source code changes needed — the sub-agent found zero implementation defects. One iteration; no re-verification loop was required since all findings were doc-wording only, not code drift. Confirmed `tests/tsconfig.json`'s inclusion in the plan's Files to Edit table (added earlier, mid-Implement, when the fixture file first failed to compile — see plan.md's Files to Edit entry and its note) accounts for the one file the sub-agent's scope check found beyond the plan's original file list; no unexplained drift.

## Reviewer Feedback

*Human fills this section during review.*
