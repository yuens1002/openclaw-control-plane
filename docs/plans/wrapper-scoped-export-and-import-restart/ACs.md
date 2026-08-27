# Wrapper Scoped Export and Import Restart Acceptance Criteria

**Branch:** `feat/wrapper-scoped-export-and-import-restart`
**Plan:** `docs/plans/wrapper-scoped-export-and-import-restart/plan.md`

## Context

Issue #73 adds `GET /setup/export?scope=state` to the pinned Railway wrapper
(state subset only, consistent SQLite snapshot, hard byte cap) and replaces
the `/setup/import` handler's inline `kill → sleep(750)` with the same
exit-confirmed stop helper `restartGateway()` gained in #70. Single session,
D1–D9. No live network access is required for any in-scope AC; the first
real request against a redeployed instance belongs to the consumer repo's
plan and is recorded here as deferred, not passed.

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
| AC-COV-001 | D6 | `/project-manager` | Plan exists | Code review: `docs/plans/wrapper-scoped-export-and-import-restart/plan.md` | Plan names issue, branch, current state (measured sizes, WAL finding, existing handler anchors, no-gate-script exception, branch-collision check), approach, deliverables with roles, design decisions, files to create/edit, gate pre-check, commit schedule, dependencies, out of scope | | | |
| AC-COV-002 | D7 | `/project-manager` | ACs table exists | Code review: this file | Every AC row has a valid Plan ref (D1–D9, or `—` for cross-cutting regression rows) and a Role; every deliverable D1–D9 is referenced by at least one row | | | |
| AC-COV-003 | D8 | `/project-manager` | Review scaffold exists | Code review: `docs/plans/wrapper-scoped-export-and-import-restart/review.md` | Review doc has sections for verdict, deliverables↔code, ACs↔tests, docs drift, recommendations | | | |

## Functional Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-001 | D1 | `/devops` | `filterStateEntry` — closed include list | Code review: `scripts/wrapper-state-export.mjs` | Exported `STATE_EXPORT_INCLUDE` and `STATE_EXPORT_EXCLUDE_SEGMENTS`/`STATE_EXPORT_EXCLUDE_BASENAME_PATTERNS` constants exist; `filterStateEntry` returns true only for paths under an include root (and, under `agents/*/agent/`, only `*.sqlite`, `models.json`, `auth-profiles*`); any excluded segment or basename pattern returns false regardless of include; non-regular entries (symlink, socket, device) return false | | | |
| AC-FN-002 | D1 | `/devops` | `snapshotSqlite` — consistent snapshot, never a hot copy | Code review: `scripts/wrapper-state-export.mjs` | Opens the source with `DatabaseSync` (`readOnly`), runs `VACUUM INTO` to the target, closes; `-wal`/`-shm` siblings are never copied; if `import("node:sqlite")` rejects, the function throws with a message naming `node:sqlite` — there is no fallback file-copy branch | | | |
| AC-FN-003 | D1 | `/devops` | `buildStateExportTree` — byte cap and temp discipline | Code review: `scripts/wrapper-state-export.mjs` | Accumulates bytes as it copies/snapshots and throws once the total exceeds `maxBytes` (default 200 MB, `OPENCLAW_STATE_EXPORT_MAX_BYTES` override) before returning; writes only under `targetRoot/.openclaw/…` so archive paths are relative to `/data`; never follows symlinks | | | |
| AC-FN-004 | D2 | `/devops` | `?scope=state` delegate on the existing route | Code review: `scripts/patch-wrapper-scoped-export.mjs` (the injected text) | The delegate is inserted at the top of the `app.get("/setup/export", requireSetupAuth, …)` handler body; `scope === "state"` builds the tree in an `fs.mkdtempSync` dir, streams `tar.c({ gzip: true, portable: true, noMtime: true, cwd: tmpRoot }, [".openclaw"])` with the existing `content-type`/`content-disposition` headers, and removes the temp dir in `finally`; any other non-empty `scope` → 400; absent `scope` falls through to the unmodified full-export code path; a build failure (cap, `node:sqlite`) → 500 with a one-line reason and no partial body | | | |
| AC-FN-005 | D2 | `/devops` | Patch script safety + Dockerfile integration | Code review: `scripts/patch-wrapper-scoped-export.mjs`, `Dockerfile` | Both injections (import line after `import * as tar from "tar";`, delegate after the handler's opening line) use exact-block replace with an exactly-one-occurrence guard and exit non-zero otherwise; the Dockerfile `template-source` stage `COPY`s `scripts/wrapper-state-export.mjs` to `src/wrapper-state-export.mjs`, runs the patch, then asserts with `grep -qF` on the delegate marker and the import line and `node --check src/server.js` | | | |
| AC-FN-006 | D3 | `/devops` | Shared exit-confirmed stop | Code review: `scripts/patch-wrapper-restart-gateway.mjs` (injected text) | A single `async function stopGatewayAndWait()` is defined once (above `restartGateway`), captures the process reference before signalling, resolves on the real `exit` event with a bounded `SIGKILL` escalation, and clears `gatewayProc` only after exit; `restartGateway()` calls it; the import handler's inline `kill/sleep(750)/null` block is replaced by `await stopGatewayAndWait();` — no remaining `sleep(750)` inside either site | | | |
| AC-FN-007 | D3 | `/devops` | Per-site occurrence guards | Code review: `scripts/patch-wrapper-restart-gateway.mjs`, `Dockerfile` | Each of the two target blocks (restartGateway body, import-handler stop block) is matched independently and the script exits non-zero if either occurs ≠ 1 times; the Dockerfile asserts `grep -qF 'stopGatewayAndWait'` and that the count of `await sleep(750);` in `src/server.js` dropped by exactly the number of replaced sites relative to the pinned template | | | |
| AC-FN-008 | D2, D3 | `/devops` | Unscoped behaviour preserved | Code review + `docker build --target template-source` | With no `scope` query the export handler's original body is byte-identical to the pinned template's (the delegate is a prefix, not a rewrite); `/setup/import`'s extraction and restart semantics after the stop are unchanged | | | |

## Test Coverage Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-TST-001 | D4 | `/test-engineer` | Include/exclude invariants on a real fixture | Test run: `npm test -- --run tests/openclaw-railway-wrapper-patches.test.ts` | Against a temp `STATE_DIR` containing every include root plus decoys (`bin/big.bin`, `lib/x`, `agents/main/sessions/s.jsonl`, `agents/main/agent/plugins/p.js`, `openclaw.json.bak-1`, `state/openclaw.sqlite-wal`, a symlink), the produced tree's relative paths are all accepted by `filterStateEntry`, none contain an excluded segment/basename, and the symlink is absent | | | |
| AC-TST-002 | D4 | `/test-engineer` | SQLite snapshot is consistent | Test run: same file | A WAL-mode fixture DB created with `node:sqlite` (rows inserted, WAL left un-checkpointed) is snapshotted; opening the snapshot yields the inserted rows and `PRAGMA integrity_check` returns `ok`; no `-wal`/`-shm` file exists next to the snapshot | | | |
| AC-TST-003 | D4 | `/test-engineer` | Byte cap throws before completion | Test run: same file | With `maxBytes` smaller than the fixture total, `buildStateExportTree` rejects with an error naming the cap and the target root contains no partial archive artifact beyond the tree itself | | | |
| AC-TST-004 | D4 | `/test-engineer` | Patch scripts apply once and refuse twice | Test run: same file | On a synthetic `server.js` fixture containing the exact anchor lines, each patch script exits 0 and `node --check` passes on the result; running the same script again on the patched fixture exits non-zero with the occurrence count in its message | | | |
| AC-TST-005 | D4 | `/test-engineer` | Import-handler replacement is site-specific | Test run: same file | After D3's script runs on the fixture, the fixture's third and fourth (unrelated) `await sleep(750);` occurrences remain and only the restartGateway and import-handler sites changed | | | |

## Documentation Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-DOC-001 | D5 | `/devops` | Dockerfile rationale + README note | Code review: `Dockerfile`, `README.md` | Each new/extended patch step has a comment block stating the defect, the measured sizes, why the fix is build-time, and links to #73 and the upstream drafts; README's wrapper `/setup` section documents `?scope=state`, the archive layout (`.openclaw/…` relative to `/data`), the byte cap env var, and that the archive is importable by `/setup/import` | | | |
| AC-DOC-002 | D5 | `/devops` | Documentation hygiene | Code review: diff of docs | No hosted Railway project/service/org identifiers, URLs, or tenant names in any new doc content (measured sizes are fine; instance identity is not) | | | |
| AC-DOC-003 | D9 | `/project-manager` | Upstream issue drafts ready for the operator | Code review: `docs/plans/wrapper-scoped-export-and-import-restart/upstream-issues.md` | Two drafts (scoped export request; import-path race referencing upstream #233) with reproduction facts and the minimal fix shape; file states they are **not yet filed** and names the operator as the filer; after filing, URLs are appended | | | |
| AC-OPS-001 | D2 | `/devops` | Live `?scope=state` request (deferred to consumer) | Manual, post-merge; not run in this session | The consumer repo's plan runs the first real request during its agency-instance redeploy deliverable and records `401` unauthenticated / `200` + `application/gzip` authenticated / `content-length` ≪ cap; this row is DEFERRED-to-consumer, not PASS, until that evidence is linked here | | | |

## Regression Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-REG-001 | — | `/test-engineer` | All existing tests pass | Test run: `npm test` | Full suite passes with the new test file included, 0 failures (pre-existing Postgres-gated skips allowed) | | | |
| AC-REG-002 | — | `/devops` | Typecheck and build stay clean | Test run: `npm run typecheck`, `npm run build` | 0 type errors, build succeeds | | | |
| AC-REG-003 | — | `/devops` | Patched wrapper stage builds | `docker build --target template-source .` | Stage builds successfully; both patch scripts print their success line; all `grep -qF`/`node --check` assertions pass | | | |
| AC-REG-004 | — | `/project-manager` | Diff scope check | `git diff origin/main --stat` | Changed files are exactly the plan's Files to Create/Edit lists (excluding `CHANGELOG.md`/`package.json`, which change at `/commit`) — no extras | | | |

---

## Agent Notes

*Verification sub-agent fills this section.*

## QC Notes

*Main thread fills this section.*

## Reviewer Feedback

*Human fills this section during review.*
