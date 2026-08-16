# /review report — railway-cli-spawn-contract

**Branch:** `feat/railway-cli-spawn-contract`
**Generated:** 2026-08-16
**Iterations to reach verified:** 1 (Phase 3 sub-agent verification surfaced no code defects; two ACs-doc wording-precision gaps, fixed in QC before this report)

## Verdict

**Clear.** All 12 ACs pass (10 CONFIRMED, 2 CONFIRMED-WITH-FIX — both doc-wording corrections, not code fixes — now that `review.md` exists and the two overbroad Pass-cell wordings are narrowed). The Phase 3 sub-agent found zero implementation defects: every named test genuinely spawns a real child process where the AC claims it does, `cli.ts`'s export is a single-line, logic-free change, and the fixture-dedup migration preserves every pre-existing assertion in the three orchestration test files unchanged. Ready for human review.

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|---|---|---|
| D1 | `packages/openclaw-railway-installer/src/cli.ts:114` — `runCommand` exported, no logic change | ✓ shipped |
| D2 | `tests/openclaw-railway-cli.test.ts:32-76` — real-spawn contract tests (stdin round-trip, capture+echo, non-zero exit) | ✓ shipped |
| D3 | `tests/openclaw-railway-client-cli.test.ts:69-87` — real-spawn stdin round-trip + non-zero exit tests added (no-echo case already covered, not duplicated) | ✓ shipped |
| D4 | `tests/fixtures/fake-railway-runner.ts` (97 lines) — shared `FakeRailwayRunner`, union of the three prior fakes | ✓ shipped |
| D5 | `tests/openclaw-railway-installer.test.ts` — migrated onto D4, private class removed | ✓ shipped |
| D6 | `tests/openclaw-railway-provision-client.test.ts` — migrated onto D4, private class + duplicated `serviceDomain`/`domainList` helpers removed | ✓ shipped |
| D7 | `tests/openclaw-railway-update-client-ref.test.ts` — migrated onto D4, private class removed | ✓ shipped |
| D8 | `docs/plans/railway-cli-spawn-contract/plan.md` | ✓ shipped |
| D9 | `docs/plans/railway-cli-spawn-contract/ACs.md` | ✓ shipped |
| D10 | `docs/plans/railway-cli-spawn-contract/review.md` (this file) | ✓ shipped |

### Code changes not tied to any deliverable

None — `git diff origin/main --stat` (plus the untracked new fixture file) shows exactly the 8 tracked files the plan's Files to Create/Edit tables name, plus the new fixture. One file, `tests/tsconfig.json`, was not in the plan's *original* Files to Edit table — discovered mid-Implement (D4's new `.ts` fixture failed to compile under the `tests` TS project's `include` pattern, TS6307) and added to the table at that point, per this workflow's own retro lesson about updating the files table in the same edit that necessitates it, rather than leaving the plan silently stale.

## ACs ↔ Tests (Gate 3 spot-check, holistic)

| AC | Test file | Asserts invariant? | Notes |
|----|-----------|---------------------|-------|
| AC-TST-001 | `tests/openclaw-railway-cli.test.ts:39-49` | ✓ | Real `process.execPath` spawn, no fake `RailwayRunner`; payload includes leading/trailing whitespace, a non-ASCII glyph, and an embedded newline — a genuine byte-fidelity check, not a literal pin. |
| AC-TST-002 | `:58-68` | ✓ | Spy on `process.stdout.write` plus the resolved `{stdout}` value, both checked against the same real child output — proves the relation (both sinks receive it), not a hardcoded string. |
| AC-TST-003 | `:70-74` | ✓ | Real child exits 3 with real stderr `boom`; message built from that actual stderr, not fabricated. |
| AC-TST-004 | `tests/openclaw-railway-client-cli.test.ts:69-79` | ✓ | Identical invariant to AC-TST-001, now covering `client-cli.ts`'s `runCommand` — closes the gap where the "issue #18" BOM/CRLF claim was previously only checked against a fake `RailwayRunner`. |
| AC-TST-005 | `:81-85` | ✓ | Same non-zero-exit invariant as AC-TST-003, for `client-cli.ts`. |
| AC-TST-006 | `tests/fixtures/fake-railway-runner.ts` + 3 migrated test files | ✓ (after wording fix) | Fixture is a faithful union of the three prior fakes (confirmed line-by-line: every pre-existing `expect(...)` in the three orchestration test files is unchanged). Original Pass wording ("no test file under `tests/`...") was overbroad — three other, explicitly out-of-scope files still define their own private fakes. Narrowed in QC to name D5/D6/D7's three files specifically. |

## Docs drift

**None found.** No README, architecture doc, or in-tree comment makes a claim this feature invalidates — this is a test-only change with one already-internal function (`runCommand`) gaining an `export` keyword; nothing public-facing changed.

## Plan accuracy

No corrections needed to the plan's technical claims. The plan's rejected-composition analysis (provision→proof chaining doesn't correspond to any real production data flow — see plan.md's Current State) was verified independently by the Phase 3 sub-agent's code read and holds.

One process note, not a technical inaccuracy: `tests/tsconfig.json` was added to the Files to Edit table mid-Implement rather than being anticipated at planning time (see Deliverables ↔ Code above) — a reasonable outcome of TypeScript project-reference wiring being invisible until the new file is actually compiled, not something the plan could have caught by inspection alone.

## Recommendations

1. None blocking.
2. Optional, non-blocking, explicitly out of this feature's scope: three other test files (`tests/openclaw-setup-applier-railway-variables.test.ts`, `tests/openclaw-setup-applier-apply-profile.test.ts`, `tests/openclaw-railway-installer-readiness.test.ts`) still define their own private Railway-CLI-shaped fakes, independent of this plan's `tests/fixtures/fake-railway-runner.ts`. Not this plan's job (different command surfaces, different package — `openclaw-setup-applier`'s "profile layer" is explicitly out of scope per this plan's Out of Scope section, and `readiness.test.ts` predates and is unrelated to this feature), but worth a future look if the DRY concern this plan addressed recurs there too.

## Inputs for /retro

- **Route:** `/test-engineer` → `~/.claude/commands/test-engineer.md`
  **Draft principle:** *"When an AC's Pass cell states a negative/universal claim about the wider test suite (e.g. 'no test file under `tests/` does X anymore'), scope the wording explicitly to the files this plan actually touches at authoring time, not the whole directory — a codebase can have pre-existing, legitimately out-of-scope instances of the same pattern elsewhere, and a universally-worded Pass cell reads as a broken promise instead of the narrower true claim."*
  **Triggered by:** AC-TST-006's original Pass cell claimed no test file under `tests/` defines its own `FakeRailwayRunner`. Three other, unrelated, pre-existing test files still do — correctly out of this plan's scope — but the wording didn't say so, and the Phase 3 sub-agent had to flag the gap between the AC's literal text and what the plan actually intended.

- **Route:** `/project-manager` → `~/.claude/commands/project-manager.md`
  **Draft principle:** *"When an AC doc's Column Definitions/precedent allow `—` as a valid Plan-ref value for cross-cutting rows (e.g. AC-REG-*), the per-row Pass-cell wording for the coverage-check AC (e.g. 'every AC row has a valid Plan ref') should say so explicitly ('D1-Dn, or `—` for cross-cutting rows') rather than naming only the deliverable-ID range — otherwise a literal read of that AC's own Pass cell flags the doc's own established, correct convention as a violation."*
  **Triggered by:** AC-COV-002's original Pass cell said "every AC row has a valid Plan ref (D1-D10)," which AC-REG-001/002's `—` technically fails under a literal reading, even though `—` for regression rows matches this repo's own prior convention (`setup-api-basic-auth/ACs.md`'s AC-COV-002 already allows it explicitly). Caught by the Phase 3 sub-agent, fixed by narrowing the wording rather than changing the rows.
