# Wrapper Scoped Export and Import Restart Plan

Issue: https://github.com/yuens1002/openclaw-control-plane/issues/73
Branch: `feat/wrapper-scoped-export-and-import-restart`
Source: GitHub issue #73 — "Wrapper: add a scoped state export endpoint and
fix the /setup/import restart race". This is the control-plane stream of a
two-repo initiative; the consumer side (daily encrypted backups pulled by a
private profile repo's GitHub Actions workflow, and an operator restore
through `/setup/import`) lives in that private repo and is referenced here
only as a dependency, never expanded.

## Summary

Two build-time patches to the pinned Railway wrapper
(`vignesh07/clawdbot-railway-template` at `OPENCLAW_TEMPLATE_REF`), applied in
the `template-source` Dockerfile stage with the existing
`scripts/patch-wrapper-*.mjs` exact-block pattern:

1. **`GET /setup/export?scope=state`** — a scoped variant of the wrapper's
   existing `/setup/export` that archives only the instance's state subset
   (config, credentials, devices, cron, identity, memory, exec approvals,
   SQLite stores) with a **consistent** SQLite snapshot, instead of the whole
   `STATE_DIR` + `WORKSPACE_DIR` tree.
2. **`/setup/import` restart race** — the import handler's inline
   `kill("SIGTERM") → sleep(750) → gatewayProc = null` is the same race
   PR #70 fixed in `restartGateway()`; both call sites now share one
   exit-confirmed helper.

## Current State

- The wrapper's `GET /setup/export` (anchor: `app.get("/setup/export",
  requireSetupAuth, …)`) tars `STATE_DIR` and `WORKSPACE_DIR` relative to
  `/data` with `tar.c({ gzip, portable, noMtime })` and **no filter**.
  Measured on a live instance during planning (read-only `du -sh`):
  `STATE_DIR` is 541 MB — `bin/` 415 MB, `agents/main/sessions/` 64 MB,
  `lib/` 32 MB, `agents/main/agent/{plugins,codex-home}` ≈ 22 MB — while the
  state subset is ≈ 7.2 MB (`openclaw.json`, `credentials/`, `devices/`,
  `cron/`, `identity/`, `memory/`, `exec-approvals.json`,
  `state/openclaw.sqlite` ≈ 7 MB, `agents/main/agent/{openclaw-agent.sqlite,
  models.json, auth-profiles*}`).
- `state/openclaw.sqlite` runs in WAL mode with a live `-wal`/`-shm` pair
  (mtimes minutes old under normal operation). A plain file copy is not a
  consistent snapshot. The runtime image (`node:22-bookworm`; Node 22.23 on
  the measured instance) has no `sqlite3` CLI, but `node:sqlite`
  (`DatabaseSync`, unflagged since 22.13) provides `VACUUM INTO`.
- `POST /setup/import` (anchor: `// Import a backup created by
  /setup/export.` then `app.post("/setup/import", requireSetupAuth, …)`)
  extracts under `/data` with a `looksSafeTarPath` filter, never deletes,
  then restarts the gateway — and stops the gateway first with its own
  inline copy of the `kill → sleep(750) → null` sequence that #70 replaced
  in `restartGateway()` with an exit-confirmed wait. The inline copy still
  races.
- `scripts/patch-wrapper-restart-gateway.mjs` already patches
  `restartGateway()` via exact-block `String.prototype.replace` with an
  occurrence-count guard (exits non-zero unless exactly one match), and the
  Dockerfile asserts the result with `grep -qF` + `node --check`
  (`docs/plans/…` precedent: five prior wrapper patches, all build-time).
- The wrapper is ESM (`"type": "module"`, `engines.node >= 22`) and already
  imports `tar@^7` (its `tar.c` accepts `filter`), `express`, `fs`, `os`,
  `path`, `crypto`. The Dockerfile's runtime stage copies
  `/template/src` → `/app/src` and installs the wrapper's `package.json`
  deps with `npm install --omit=dev`; this repo's root `package.json` does
  **not** depend on `express` or `tar`, so a unit test cannot run the real
  handler — hence D1 below is a standalone module the handler imports.
- No `scripts/check-acs-coverage.*` gate script and no
  `.claude/verification-status.json` exist in this repo (same structural
  exception as `decision-runtime-watch-patterns` and its predecessors).
  Gate 1/2 are performed manually below. The consumer repo now has such a
  script; porting it here is out of scope for this issue.
- Branch-collision check before starting: `origin/main` at `a6fbcf7`
  (#72), local `main` synced, working tree clean, no other local feature
  branch touches `Dockerfile` or `scripts/patch-wrapper-*.mjs`.

## Approach

1. **Separate logic from patching (D1 vs D2).** The scoped-export logic is a
   real ESM module, `scripts/wrapper-state-export.mjs`, that exports
   `filterStateEntry(relativePath, dirent)` (include/exclude decision),
   `snapshotSqlite(sourcePath, targetPath)` (`VACUUM INTO` via a dynamic
   `import("node:sqlite")`, failing loudly if unavailable — never a hot
   copy), and `buildStateExportTree({ stateDir, targetRoot, maxBytes })`
   (copies included regular files into `targetRoot/.openclaw/…`, snapshots
   every `*.sqlite`, skips `-wal`/`-shm`/`*.bak*`/symlinks/non-regular
   entries, counts bytes, throws once the cap is exceeded). The Dockerfile
   copies this module to `/template/src/wrapper-state-export.mjs` so it
   rides the existing `COPY --from=template-source /template/src ./src`.
2. **The patch is thin (D2).** `scripts/patch-wrapper-scoped-export.mjs`
   inserts one import line after `import * as tar from "tar";` and, at the
   top of the existing export handler, a delegate: when `req.query.scope ===
   "state"`, build the tree in a temp dir (`fs.mkdtempSync` under
   `os.tmpdir()`), stream `tar.c({ gzip, portable, noMtime, cwd: tmpRoot },
   [".openclaw"])` with the same `content-type`/`content-disposition`
   headers as the existing export, and remove the temp dir in `finally`.
   Any other `scope` value → 400. Auth is inherited (`requireSetupAuth` on
   the same route). Archive paths stay `.openclaw/…`, so the output is a
   valid input for the wrapper's own `/setup/import`.
3. **One exit-confirmed stop helper for both call sites (D3).**
   `scripts/patch-wrapper-restart-gateway.mjs` grows a second exact-block
   replacement: the import handler's inline stop block becomes `await
   stopGatewayAndWait();`, and `restartGateway()`'s already-patched body is
   refactored to call the same helper (defined once, above
   `restartGateway`). Each replacement keeps its own exactly-one-occurrence
   guard so a future template bump that moves either site fails the build
   instead of silently no-op-ing.
4. **Tests run the logic, the build runs the integration (D4).**
   `tests/openclaw-railway-wrapper-patches.test.ts` (vitest) exercises D1
   against a temp `STATE_DIR` fixture containing real files, a real WAL-mode
   SQLite created with `node:sqlite`, decoy `bin/`/`sessions/`/`*.bak`
   entries, and a symlink — asserting the produced tree ⊆ include list,
   ∩ exclude list = ∅, the snapshot passes `PRAGMA integrity_check`, and
   the byte cap throws. It also applies both patch scripts to a synthetic
   anchor fixture and asserts idempotency-refusal (second application exits
   non-zero) and `node --check` on the result. The Dockerfile's
   `grep -qF` / `node --check` assertions and a `docker build --target
   template-source` (AC-REG) cover the real wrapper.
5. **Live verification is the consumer's.** The first real
   `?scope=state` request against a redeployed instance is an Ops AC in the
   consumer repo's plan (its agency-instance redeploy deliverable); here it
   is recorded as DEFERRED-to-consumer, not PASS.

## Deliverables (with spec-role assignment)

| ID | Deliverable | Kind | Owning role | Session |
| --- | --- | --- | --- | --- |
| D1 | `scripts/wrapper-state-export.mjs` — `filterStateEntry`, `snapshotSqlite`, `buildStateExportTree` (include/exclude lists as exported constants; size cap; temp-tree builder) | module | `/devops` | 1 |
| D2 | `scripts/patch-wrapper-scoped-export.mjs` + Dockerfile `template-source` step — import line + `?scope=state` delegate at the top of the export handler; `COPY` of D1 into `/template/src`; `grep -qF` + `node --check` assertions | endpoint (build-time patch) | `/devops` | 1 |
| D3 | `scripts/patch-wrapper-restart-gateway.mjs` (extend) + Dockerfile assertions — shared `stopGatewayAndWait()`; import handler's inline stop replaced; `restartGateway()` refactored to call it; per-site occurrence guards | fix (build-time patch) | `/devops` | 1 |
| D4 | `tests/openclaw-railway-wrapper-patches.test.ts` — D1 invariants on a temp fixture (include ⊆, exclude ∩ = ∅, `integrity_check`, cap), patch-script application + refusal on a synthetic anchor fixture, `node --check` | test | `/test-engineer` | 1 |
| D5 | Dockerfile comment blocks for D2/D3 (rationale, measured sizes, links to #73 and the upstream issues) + `README.md` note under the OpenClaw wrapper/`/setup` section describing `?scope=state` and its archive shape | doc | `/devops` | 1 |
| D6 | `docs/plans/wrapper-scoped-export-and-import-restart/plan.md` — this plan | doc | `/project-manager` | 1 |
| D7 | `docs/plans/wrapper-scoped-export-and-import-restart/ACs.md` | doc | `/project-manager` | 1 |
| D8 | `docs/plans/wrapper-scoped-export-and-import-restart/review.md` — `/review` report | doc | `/project-manager` | 1 |
| D9 | Upstream issue drafts against `vignesh07/clawdbot-railway-template` (scoped export request; import-path race — referencing their #233) written to the plan directory as `upstream-issues.md`; **filed by the operator** after review (third-party public repo — not filed autonomously) | doc | `/project-manager` | 1 |

### Design decisions carried into Implement

- **Include list is explicit and closed** (D1): `openclaw.json`,
  `exec-approvals.json`, `credentials/`, `devices/`, `cron/`, `identity/`,
  `memory/`, `state/`, `agents/*/agent/` (only `*.sqlite`, `models.json`,
  `auth-profiles*` inside it). **Exclude list is also explicit** (D1):
  directory segments `bin`, `lib`, `media`, `completions`, `logs`,
  `backups`, `sessions`, `plugins`, `codex-home`, `workspace`, `nodes`,
  `canvas`, `skill-workshop`, `plugin-skills`, `workspace-attestations`;
  basenames matching `*.bak*`, `*-wal`, `*-shm`, `*.migrated`; any
  symlink, socket, or device. Anything not matched by the include list is
  excluded by default — the exclude list exists so the test can assert the
  *known* bulk is never present, not as the primary gate.
- **`VACUUM INTO`, never a hot copy** (D1): each `*.sqlite` is opened
  read-only with `DatabaseSync` and `VACUUM INTO '<target>'` produces a
  consistent single-file copy; `-wal`/`-shm` siblings are skipped. If
  `node:sqlite` cannot be imported, `buildStateExportTree` throws and the
  handler answers 500 with a one-line reason — a missing snapshot primitive
  must fail the request, not degrade to an inconsistent copy.
- **Query-parameter scoping, same route** (D2): the consumer contract is
  `GET /setup/export?scope=state`. Reusing the route inherits
  `requireSetupAuth` and keeps a single export entry point; an unknown
  `scope` is a 400, and no `scope` preserves today's full export
  byte-for-byte.
- **Hard byte cap, env-tunable** (D1/D2): default 200 MB
  (`OPENCLAW_STATE_EXPORT_MAX_BYTES` overrides), enforced while building the
  temp tree so the cap triggers before any archive bytes stream. The
  measured subset is ≈ 7 MB; the cap is a runaway guard, not a budget.
- **One helper, two call sites** (D3): `stopGatewayAndWait()` captures the
  process reference, sends `SIGTERM`, awaits the real `exit` event with a
  5 s `SIGKILL` escalation, and only then clears `gatewayProc`. Extracting
  it (rather than duplicating the wait into the import handler) is the
  DRY move: both sites encode the same decision and must change together.
- **Patch scripts stay exact-block + count-guarded** (D2/D3): per this
  repo's devops retro rule (multi-line structural patches are scripts, not
  `sed`); each target block must occur exactly once or the script exits
  non-zero and the image build fails.
- **Root OpenClaw `railway.toml` untouched; no new npm dependency** in this
  repo — `node:sqlite` is built in, and the test creates its fixture DB
  with it.

### Files to Create

- `scripts/wrapper-state-export.mjs` (D1)
- `scripts/patch-wrapper-scoped-export.mjs` (D2)
- `tests/openclaw-railway-wrapper-patches.test.ts` (D4)
- `docs/plans/wrapper-scoped-export-and-import-restart/plan.md`, `ACs.md`,
  `review.md`, `upstream-issues.md` (D6–D9)

### Files to Edit

- `Dockerfile` — `template-source` stage: `COPY` D1 into `/template/src`,
  run D2, updated D3 assertions, comment blocks (D2, D3, D5)
- `scripts/patch-wrapper-restart-gateway.mjs` (D3)
- `README.md` — wrapper `/setup` section note (D5)
- `CHANGELOG.md`, `package.json` — version bump at `/commit` (not during
  Implement)

## Sessions

Single session — D1–D9 land together. Two patch scripts, one module, one
test file, docs.

## Acceptance Criteria

See `docs/plans/wrapper-scoped-export-and-import-restart/ACs.md`.

## Gate 1/2 Pre-Check

No gate scripts in this repo (see Current State). Gate 1 (deliverable ↔ AC
coverage) and Gate 2 (anti-drift) performed manually: every deliverable
D1–D9 has at least one AC row whose Plan ref names it, and every Pass
condition states a relation checkable against the produced tree, fixture,
or build output — not a literal that already lives in the files under test.

## Commit Schedule

1. Plan + ACs: `docs: add wrapper scoped-export and import-restart plan`
2. Module + patches + Dockerfile + tests: `feat(wrapper): add scoped state export and share the exit-confirmed gateway stop`
3. Docs: `docs: document /setup/export?scope=state and the import restart fix`
4. Review: `docs: record wrapper scoped-export review`
5. Version bump + CHANGELOG via `/commit`

## Dependencies

- None outside this repo for any in-scope AC. The consumer repo's plan
  depends on **this** branch merging before its live deliverables run
  (redeploy of the agency instance; provisioning of the default instance).

## Out of Scope

- Editing `vignesh07/clawdbot-railway-template` directly — upstream gets
  issues (D9), patches stay build-time here.
- A `client-cli` re-snapshot (`update-source`) subcommand — tracked
  separately by the consumer plan's follow-up issue.
- Any change to `/setup/import`'s extraction semantics (it still never
  deletes existing files) or to the full, unscoped `/setup/export`.
- Backup scheduling, encryption, retention, or restore tooling — consumer
  concerns.
- Porting the consumer repo's `check-acs-coverage` gate script here.
- Deciding whether `agents/*/sessions` belongs in the state scope — tracked
  by the consumer repo; excluded here by default.
