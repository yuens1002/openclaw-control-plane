# /review report — wrapper-scoped-export-and-import-restart

**Branch:** `feat/wrapper-scoped-export-and-import-restart`
**Generated:** 2026-08-27
**Iterations to reach verified:** 2 — one `/agentic-orca` run
(`wf_92d228bd-f7d`: 15 PASS / 2 FAIL), then main-thread fixes re-verified by
typecheck, the test file (21/21), the full suite (425 passed / 30
pre-existing Postgres-gated skips), and `docker build --target
template-source` (all patch assertions pass).

## Verdict

**Minor — proceed to human review.** Both verification FAILs were real and
are fixed: (1) `filterStateEntry` applied the basename-exclude patterns only
to files, so a *directory* named like `old.bak-1` under an include root would
have been walked and its contents exported — fixed by applying the patterns to
every path segment for files and directories alike, with a directory decoy
added to the fixture and to the direct-predicate tests; (2) this plan's own
Approach text named a hosted instance (`agency-prod`) in a public repo —
reworded. One AC row's wording was corrected (AC-TST-005 mis-numbered the
surviving `sleep(750)` sites) and one fixture label was renamed to match the
pinned source (`RESET_STOP_BLOCK_UNRELATED`).

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|-------------|----------------|--------|
| D1 | `scripts/wrapper-state-export.mjs` — `STATE_EXPORT_INCLUDE` / `STATE_EXPORT_AGENT_ALLOWED` / `STATE_EXPORT_EXCLUDE_SEGMENTS` / `STATE_EXPORT_EXCLUDE_BASENAME_PATTERNS`, `filterStateEntry`, `snapshotSqlite` (`DatabaseSync` read-only + `VACUUM INTO`), `buildStateExportTree` (byte cap, no symlink following), `resolveStateExportMaxBytes` | ✓ shipped (+ exclude-pattern fix from this review) |
| D2 | `scripts/patch-wrapper-scoped-export.mjs` (two exact-block replacements, per-target occurrence guard + already-applied guard) + Dockerfile `template-source` step (`COPY` module into `src/`, run patch, `grep -qF` ×2, delegate count `-eq 1`, `node --check` ×2) | ✓ shipped |
| D3 | `scripts/patch-wrapper-restart-gateway.mjs` — three replacements (`stopGatewayAndWait()` definition above `restartGateway`, `restartGateway` body, `/setup/import` inline stop block), each count-guarded; Dockerfile assertions updated (`sleep(750)` 4 → 2 measured against the pinned file) | ✓ shipped |
| D4 | `tests/openclaw-railway-wrapper-patches.test.ts` — 21 tests: predicate cases (files, directories, symlink/socket dirents, excluded segments, directory decoys), WAL snapshot `integrity_check`, byte cap, patch apply/refuse/compose on a synthetic fixture with all four `sleep(750)` sites | ✓ shipped (+ directory-decoy cases from this review) |
| D5 | Dockerfile comment blocks (both steps; defect, measured sizes, build-time rationale, #73) + README "Scoped state export" subsection under `## OpenClaw on Railway` | ✓ shipped |
| D6 / D7 / D8 | plan.md / ACs.md / this file | ✓ |
| D9 | `docs/plans/wrapper-scoped-export-and-import-restart/upstream-issues.md` — two drafts, marked NOT FILED, operator files | ✓ (operator action pending) |

### Code changes not tied to any deliverable

None. `git status` lists exactly the plan's Files to Create/Edit (CHANGELOG
and `package.json` change at `/commit`).

## ACs ↔ Tests (Gate 3 spot-check)

| AC | Test | Asserts invariant? | Notes |
|----|------|--------------------|-------|
| AC-TST-001 | "produces exactly the include set…" | ✓ | Set-equality between on-disk tree and returned `files`; every produced path re-accepted by `filterStateEntry`; no excluded segment/basename; decoys (now incl. `credentials/old.bak-1/secret.txt`) and the symlink absent |
| AC-TST-002 | "snapshots the WAL-mode SQLite consistently…" | ✓ | Fixture keeps a writer open with `wal_autocheckpoint=0`; snapshot opened and rows counted; `PRAGMA integrity_check` = `ok`; no `-wal`/`-shm` beside the snapshot. `describe.skipIf(!sqliteAvailable)` ran (confirmed by test name, not summary) |
| AC-TST-003 | "rejects before completion when maxBytes is smaller…" | ✓ | Real `buildStateExportTree` with a tiny cap; error names the cap and env var; target holds no archive artifact |
| AC-TST-004 | apply-once / refuse-twice, both scripts | ✓ | Spawns the real scripts; exit codes + `node --check`; second run exits non-zero with the occurrence message. Verifier also re-measured against the real pinned `src/server.js` |
| AC-TST-005 | site-specific replacement | ✓ | Remainder-diff proves only the two intended sites changed; AC wording corrected (survivors are the 2nd/3rd sites: `gateway.stop`, `POST /setup/api/reset`) |

## Docs drift

None. README gained the scoped-export subsection (archive layout, cap env
var, unknown `scope` → 400, importable by `/setup/import`); the Dockerfile
comment blocks describe each step. No existing doc claimed the export was
unscoped-only.

## Docs hygiene / public-voice audit

| Finding | Kind | Location | Introduced or pre-existing | Status |
|---------|------|----------|----------------------------|--------|
| Hosted instance name `agency-prod` in Approach item 5 | A | `docs/plans/wrapper-scoped-export-and-import-restart/plan.md` | introduced | **fixed** — "its agency-instance redeploy deliverable" |
| Full-branch sweep for private repo/org/tenant slugs, Railway project/service ids, `*.railway.app` | A | Dockerfile, README, scripts, tests, plan/ACs/upstream drafts | — | clean (grep + the verifier's full read of every new doc) |
| Kind B / Kind C | — | — | — | none: measured sizes are stated as measurements, not as a tenant's current configuration; no first-person workflow text |

Transitive: the two upstream drafts cite only this repo's public scripts and
#73. Control-plane #73/#74 (referenced by the consumer plan) were redacted in
the consumer repo's review the same day.

## Recommendations

1. **Operator:** file the two upstream drafts from `upstream-issues.md` and append the URLs there (AC-DOC-003).
2. **Session 2 (consumer plan) confirms live** what this stream can only assume: the runtime image's Node exposes `DatabaseSync({ readOnly: true })` (assumed per "unflagged since 22.13"; the measured instance runs 22.23) and the real export's byte size (~7 MB) — record both against AC-OPS-001 when the consumer's redeploy AC runs.
3. **Environment note, not a code finding:** the first `npm test` on this machine failed on a missing `@modelcontextprotocol/sdk` (pinned in the lockfile, absent from `node_modules`); `npm install --no-save` fixed it without touching the lockfile. CI installs from the lockfile so this does not affect the release gate.
4. The synthetic fixture's 3rd stop block carries the wrapper's own "onboard" comment while living in `POST /setup/api/reset`; the constant now says so. Cosmetic.

## Inputs for /retro

- **Route:** `/devops` → `~/.claude/commands/devops.md`
  **Draft principle:** *"An include/exclude predicate for a filesystem walk must apply exclude patterns to every path segment and to directories as well as files — never gate a basename pattern on `isFile`. A directory that matches an excluded name is a container for exactly the content the pattern exists to keep out, and a walk that only rejects matching files will happily descend into it."*
  **Triggered by:** AC-FN-001 — `filterStateEntry` skipped the basename check for directories; the walk would have exported `credentials/old.bak-1/secret.txt`.

- **Route:** `/test-engineer` → `~/.claude/commands/test-engineer.md`
  **Draft principle:** *"When a filter's exclude list is expressed as name patterns, the fixture must contain the directory form of every pattern (a directory whose own name matches, with a file inside), not only matching files — a file-only decoy set cannot distinguish 'the pattern is applied' from 'the pattern is applied to files'."*
  **Triggered by:** AC-TST-001's decoys were all files, so D4 could not catch AC-FN-001's gap; the verifier found it by calling the predicate directly.

- **Route:** `/project-manager` → `~/.claude/commands/project-manager.md`
  **Draft principle:** *"In a public repo's plan, refer to the consumer's instances by role ('the agency instance', 'a tenant'), never by name — the plan author is the person most likely to leak the name, because they are the one holding the private context while writing."* (Same lesson as the consumer repo's review the same day, where two public issues leaked the private repo name; consolidate into one rule.)
  **Triggered by:** AC-DOC-002 — `agency-prod` in this plan's Approach.

- **Route:** cross-cutting → `~/.claude/commands/agentic-orca.md`
  **Draft addition:** *"When one implement agent writes a module and a later agent writes its tests, instruct the verifier for the module to exercise the predicate/API directly with adversarial inputs the test author did not construct — the two agents share the implementer's mental model, and a fixture built from the implementer's report inherits its blind spots."*
  **Triggered by:** the D4 tests (21/21 green) and the D1 verifier disagreed; only the direct-call verification exposed the directory case.
