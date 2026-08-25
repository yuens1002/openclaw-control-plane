# /review report — decision-runtime-watch-patterns

**Branch:** `feat/decision-runtime-watch-patterns`
**Generated:** 2026-08-25
**Iterations to reach verified:** 1 (Phase 3 sub-agent verification surfaced zero implementation defects; two doc-sync gaps found by a second advisor pass on the plan itself, fixed in QC before this report)

## Verdict

**Clear, with one explicitly non-blocking deferral.** 22 of 23 ACs PASS/CONFIRMED; AC-OPS-001 (hosted smoke) is DEFERRED by design, confirmed with the user, and documented as a deferral rather than marked PASS off substitute evidence. AC-COV-003 and AC-REG-004 flagged that `review.md` didn't exist yet at verification time — expected Commit Schedule sequencing, resolved by this file. The Phase 3 sub-agent independently re-derived both services' expected `watchPatterns` sets straight from the real Dockerfiles (not trusted from the plan's claims) and hand-traced the parity (AC-TST-007) and drift-detection (AC-TST-008) tests against real files and a synthetic fragment rather than just observing green output — no test found passing for the wrong reason. Ready for human review.

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|---|---|---|
| D1 | `deploy/decision-runtime/railway.toml` — `[build] watchPatterns`, 15 entries | ✓ shipped |
| D2 | `deploy/decision-runtime/worker.railway.toml` — `[build] watchPatterns`, 15 entries | ✓ shipped |
| D3 | `tests/decision-runtime-watch-patterns.test.ts` — 11 tests: representative changed-path matches/no-matches, config parity (set-equality against each Dockerfile's derived COPY sources), and drift detection | ✓ shipped |
| D4 | `docs/architecture.md` — "Deployment Topology" section; `docs/README.md`'s Architecture one-liner kept in sync | ✓ shipped |
| D5 | `docs/decision-runtime-deployment.md` — "Build triggers" section: trigger matrix, maintenance rule, generic verification procedure | ✓ shipped |
| D6 | `docs/plans/decision-runtime-watch-patterns/plan.md` | ✓ shipped |
| D7 | `docs/plans/decision-runtime-watch-patterns/ACs.md` | ✓ shipped |
| D8 | `docs/plans/decision-runtime-watch-patterns/review.md` (this file) | ✓ shipped |

### Code changes not tied to any deliverable

None. `git diff origin/main --stat` shows exactly the files named across the plan's Files to Create/Edit tables (`deploy/decision-runtime/{railway.toml,worker.railway.toml}`, `docs/architecture.md`, `docs/README.md`, `docs/decision-runtime-deployment.md`, `docs/plans/decision-runtime-watch-patterns/{plan.md,ACs.md,review.md}`, `tests/decision-runtime-watch-patterns.test.ts`) — no extras. `docs/README.md` was not in the plan's *original* Files to Edit table — discovered mid-Implement (a second advisor pass on the plan flagged that `docs/README.md`'s Architecture one-liner would go stale against the new Deployment Topology section, matching this repo's own retro lesson about README/architecture-doc list drift) and added to the table in the same edit that added the design-decision prose, per this workflow's retro rule on mid-plan updates.

## ACs ↔ Tests (Gate 3 spot-check, holistic)

| AC | Test file | Asserts invariant? | Notes |
|----|-----------|---------------------|-------|
| AC-TST-001/002 | `tests/decision-runtime-watch-patterns.test.ts:81-91` | ✓ | Real `matchesAnyPattern` evaluated against real parsed pattern arrays from both `railway.toml` files — API-only and worker-only paths correctly cross-checked against *both* services' lists, not just their own. |
| AC-TST-003/004 | `:93-110` | ✓ | Shared-package and shared-config paths, including a `packages/db/migrations/` path, checked against both lists. |
| AC-TST-005 | `:112-117` | ✓ | Deployment-target files cross-checked both ways (API config doesn't leak into worker's list, and vice versa). |
| AC-TST-006 | `:119-133` | ✓ | Docs, both OpenClaw-wrapper packages, root OpenClaw config, and an unrelated workspace package all confirmed to match neither list. |
| AC-TST-007 | `:135-149` | ✓ | `deriveExpectedPatterns` reads the real Dockerfile text and mechanically reconstructs the same set `parseWatchPatterns` extracts from the real TOML text — two independently-sourced extractions from two real files compared for set equality, not one literal duplicated in two places. |
| AC-TST-008 | `:160-177` | ✓ | Synthetic Dockerfile fragment with one extra `COPY` source, diffed against a deliberately stale 2-entry pattern set, correctly isolates the one missing pattern — proves the parity check has teeth against a future Dockerfile addition, not just that today's real files happen to agree. |

## Docs drift

**One found, fixed.** `docs/README.md`'s "Start Here" one-liner for `architecture.md` said "current package and ownership boundaries" — no longer complete once `docs/architecture.md` gained a Deployment Topology section describing build/deploy/runtime boundaries too. Updated to "current package, ownership, and deployment-topology boundaries" in the same commit as the `docs/architecture.md` change. No other README, architecture doc, or in-tree comment made a claim this feature invalidates.

## Plan accuracy

No corrections needed to the plan's technical claims. The plan's central premise — that each Dockerfile's build-stage `COPY` instructions are the complete, provable transitive build input for that image — was independently re-verified by the Phase 3 sub-agent against the real Dockerfiles, not just trusted from the plan's prose.

One process note: the plan's in-progress-branch collision check (local `feat/decision-runtime-mcp`, no open PR, touches `docs/architecture.md` and `docs/README.md`) was re-run immediately before this handoff (`git fetch origin` + `git diff origin/main...feat/decision-runtime-mcp --stat`) and confirms the same non-overlapping line ranges found during planning — no PR has opened for that branch since. Re-check once more immediately before merge if a meaningful delay occurs between this review and the human's approval.

## Recommendations

1. None blocking.
2. Non-blocking, out of this feature's scope: `AC-OPS-001`'s live hosted-smoke run (pushing representative commits to a provisioned decision-runtime service and confirming deploy/no-deploy behavior matches the trigger matrix) is deferred — no decision-runtime API/worker Railway service is currently provisioned, and the user confirmed provisioning one for this session's sake is out of scope. Tracked by issue [#65](https://github.com/yuens1002/openclaw-control-plane/issues/65), using the generic procedure already documented in `docs/decision-runtime-deployment.md`'s "Build triggers" section.
3. Non-blocking, flagged by the Phase 3 sub-agent: `deriveExpectedPatterns`'s file-vs-directory heuristic (a dot in the basename means "file") is correct for every path in both current Dockerfiles but is a basename guess, not a filesystem stat. It fails loudly (breaks set-equality) rather than silently if a future Dockerfile ever copies a directory with a dot in its name — acceptable as-is, but worth a one-line comment if this test file is next touched for an unrelated reason.

## Inputs for /retro

- **Route:** `/project-manager` → `~/.claude/commands/project-manager.md`
  **Draft principle:** *"When authoring an AC for a config file whose exact intended contents ARE the deliverable (e.g. a literal `watchPatterns` array), pair the code-review AC that states the intended literal with a second, independent test-coverage AC that mechanically re-derives the same value from an unrelated source of truth (here: the Dockerfile's own COPY instructions) and asserts equality — a code-review AC alone only confirms the author's own arithmetic, not that the arithmetic is actually correct against the thing it claims to track."*
  **Triggered by:** AC-FN-001/002 state the intended 15-entry `watchPatterns` sets as literals (necessary — that's what code review checks); AC-TST-007 independently re-derives the same sets from the Dockerfiles and asserts equality. The Phase 3 sub-agent used exactly this second, independent path to confirm AC-FN-001/002 weren't self-referential.

- **Route:** `/project-manager` → `~/.claude/commands/project-manager.md`
  **Draft principle:** *(Reinforces an existing retro rule, not a new one.)* A docs-index one-liner (`docs/README.md`'s "Start Here" list) describing another doc's scope is exactly the kind of "glue" deliverable this repo's retro rules already warn goes stale silently. Caught here only because of an explicit second advisor pass asking "does README restate or contradict the new section?" — not because any AC's own wording prompted the check. Consider adding a standing AC-DOC pattern-catalog entry: "when a deliverable adds a new named section to a doc that `docs/README.md` links with a one-line scope summary, confirm that summary still matches."
