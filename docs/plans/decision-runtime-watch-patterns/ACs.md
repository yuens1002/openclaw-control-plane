# Decision Runtime Watch Patterns Acceptance Criteria

**Branch:** `feat/decision-runtime-watch-patterns`
**Plan:** `docs/plans/decision-runtime-watch-patterns/plan.md`

## Context

Issue #62 adds `build.watchPatterns` to `deploy/decision-runtime/railway.toml`
and `worker.railway.toml` so each decision-runtime service deploys only when
its own Docker build input changes. Single session, D1-D8. No live
Railway/network access — the hosted-smoke check is documented but deferred to
a confirmed manual post-merge follow-up (see plan.md's Current State).

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
| AC-COV-001 | D6 | `/project-manager` | Plan exists | Code review: `docs/plans/decision-runtime-watch-patterns/plan.md` | Plan names branch, source, current state (incl. the proven-not-assumed COPY-derived build input, the no-live-service finding, the config-as-code deprecation note, the branch-collision check), approach, deliverables with roles, design decisions, files to create/edit, gate 1/2 pre-check, commit schedule, dependencies, out of scope | PASS - all sections present. | CONFIRMED - re-read after adding the branch-collision paragraph and the `docs/README.md` Files-to-Edit row (both discovered mid-Implement); still complete. | |
| AC-COV-002 | D7 | `/project-manager` | ACs table exists | Code review: `docs/plans/decision-runtime-watch-patterns/ACs.md` | Every AC row has a valid Plan ref (D1-D8, or `—` for cross-cutting regression rows) and Role; every deliverable D1-D8 is referenced by at least one row | PASS - every deliverable D1-D8 referenced by at least one row (checked FN-001/002=D1/D2, FN-003=D1,D2, TST-001..008=D3, DOC-001=D4, DOC-002=D5, DOC-003=D4,D5, OPS-001=D5, COV-001/2/3=D6/D7/D8). | CONFIRMED - matches. | |
| AC-COV-003 | D8 | `/project-manager` | Review scaffold exists | Code review: `docs/plans/decision-runtime-watch-patterns/review.md` | Review doc has sections for verdict, deliverables↔code, ACs↔tests, docs drift, recommendations | FAIL - `review.md` did not exist yet at verification time (expected per Commit Schedule item 5, not a code defect). | CONFIRMED-WITH-FIX - `review.md` authored immediately after this QC pass, in the same session; see that file. | |

## Functional Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-001 | D1 | `/devops` | `deploy/decision-runtime/railway.toml` declares the API service's watch patterns | Code review: `deploy/decision-runtime/railway.toml` | `[build] watchPatterns` is present and its array set-equals `{/apps/api/**, /packages/contracts/**, /packages/runtime-auth/**, /packages/db/**, /package.json, /package-lock.json, /tsconfig.json, /tsconfig.base.json, /apps/api/package.json, /packages/contracts/package.json, /packages/runtime-auth/package.json, /packages/db/package.json, /deploy/decision-runtime/Dockerfile, /deploy/decision-runtime/railway.toml, /.dockerignore}` — no negation patterns | PASS - independently re-derived from `deploy/decision-runtime/Dockerfile`'s build-stage COPY lines (12 entries) + 3 known extras = 15; set-equals the 15 entries actually in `railway.toml`. | CONFIRMED - matches. | |
| AC-FN-002 | D2 | `/devops` | `deploy/decision-runtime/worker.railway.toml` declares the worker service's watch patterns | Code review: `deploy/decision-runtime/worker.railway.toml` | `[build] watchPatterns` is present and its array set-equals the same set as AC-FN-001 with `apps/api`→`apps/worker` and the Dockerfile/`railway.toml` names swapped to their `worker.*` equivalents — no negation patterns | PASS - same independent re-derivation against `worker.Dockerfile`, apps/worker in place of apps/api, extras correctly swapped to `worker.*` names. | CONFIRMED - matches. | |
| AC-FN-003 | D1, D2 | `/devops` | Root OpenClaw deploy config is untouched (isolation) | `git diff origin/main -- railway.toml Dockerfile` | Empty diff — root `railway.toml` and root `Dockerfile` are byte-identical to `origin/main`, gain no `watchPatterns` key | PASS - empty diff. | CONFIRMED - matches. | |

## Test Coverage Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-TST-001 | D3 | `/test-engineer` | API app change matches only the API service | Test run: `npm test -- --run tests/decision-runtime-watch-patterns.test.ts` | A path under `apps/api/**` (e.g. `apps/api/src/server.ts`) matches the API pattern list and does not match the worker pattern list | PASS - `:81-85`, 11/11 tests pass; `matchesAnyPattern` traced by hand, dir-prefix match retains trailing `/` boundary (no `/apps/api2` false-positive). | CONFIRMED - matches. | |
| AC-TST-002 | D3 | `/test-engineer` | Worker app change matches only the worker service | Test run: same file | A path under `apps/worker/**` (e.g. `apps/worker/src/index.ts`) matches the worker pattern list and does not match the API pattern list | PASS - `:87-91`. | CONFIRMED - matches. | |
| AC-TST-003 | D3 | `/test-engineer` | Shared package change matches both services | Test run: same file | Paths under `packages/contracts/**`, `packages/runtime-auth/**`, and `packages/db/**` (including a path under `packages/db/migrations/`) each match both the API and worker pattern lists | PASS - `:93-102`, includes `packages/db/migrations/0001_init.sql`. | CONFIRMED - matches. | |
| AC-TST-004 | D3 | `/test-engineer` | Dependency/config change matches both services | Test run: same file | `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.base.json`, and `.dockerignore` each match both the API and worker pattern lists | PASS - `:104-110`. | CONFIRMED - matches. | |
| AC-TST-005 | D3 | `/test-engineer` | Deployment-target change matches only its own service | Test run: same file | `deploy/decision-runtime/railway.toml` matches the API pattern list and not the worker list; `deploy/decision-runtime/worker.railway.toml` matches the worker pattern list and not the API list | PASS - `:112-117`. | CONFIRMED - matches. | |
| AC-TST-006 | D3 | `/test-engineer` | Unrelated change matches neither service | Test run: same file | A docs-only path (`docs/decision-runtime-deployment.md`), an OpenClaw-wrapper-only path (`packages/openclaw-railway-installer/src/cli.ts`), the root OpenClaw config (`railway.toml`, `Dockerfile`), and an unrelated package path (`workers/vending/src/index.ts`) each match neither the API nor the worker pattern list | PASS - `:119-133`, also covers `packages/openclaw-setup-applier`. | CONFIRMED - matches. | |
| AC-TST-007 | D3 | `/test-engineer` | Config parity — watch patterns match Dockerfile build input exactly | Test run: same file | For each service, the pattern set mechanically derived from that service's real Dockerfile build-stage `COPY` sources (directory copy → `dir/**`, file copy → exact path, `--from=build` lines excluded) plus its three known extras (own Dockerfile, own `railway.toml`, `.dockerignore`) is set-equal to the `watchPatterns` array actually declared in that service's `railway.toml` | PASS, verified non-trivially - `:135-149`; `deriveExpectedPatterns` hand-traced against both real Dockerfiles independently reconstructs the same 15-entry sets `parseWatchPatterns` extracts from the real TOML text — two independent extraction paths from two independent real files, not a hardcoded duplicate literal. | CONFIRMED - genuine parity check, not a Gate-3 brittle-literal trap. | |
| AC-TST-008 | D3 | `/test-engineer` | Config parity detects drift, not just agreement | Test run: same file | Feeding the same derivation function a synthetic Dockerfile fragment with one extra `COPY <newpath> <newpath>` source that is absent from a given pattern list produces a detected mismatch — proving the parity check would fail on a future Dockerfile addition, not merely that today's real files happen to agree | PASS, verified non-trivially - `:160-177` hand-traced: derivation on the fragment yields `{/package.json, /apps/api/**, /apps/api/extra-config.json}`; diffing against the deliberately stale 2-entry set correctly isolates `["/apps/api/extra-config.json"]` as missing. | CONFIRMED - exercises the real derivation function under a genuine mismatch. | |

## Documentation Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-DOC-001 | D4 | `/devops` | Architecture documentation | Code review: `docs/architecture.md`, `docs/README.md` | New section distinguishes project/service/build/deployment/runtime boundaries across the three independent Railway services (OpenClaw, decision-runtime API, decision-runtime worker); includes a generic topology/trigger description (no hosted identifiers); explicitly states that rebuilding one sibling service does not rebuild another; `docs/README.md`'s Architecture one-liner reflects the added scope | PASS - "Deployment Topology" section explicitly labels Project/Service/Build/Deployment/Runtime boundaries, includes a generic ASCII topology diagram, states verbatim "rebuilding one sibling service does not rebuild another." | CONFIRMED - also re-checked `docs/README.md`'s Architecture one-liner after the mid-Implement addition; now reads "current package, ownership, and deployment-topology boundaries." | |
| AC-DOC-002 | D5 | `/devops` | Operations documentation | Code review: `docs/decision-runtime-deployment.md` | New section documents the API/worker watch-path trigger matrix, shared-input behavior (a change under `packages/contracts`, `packages/runtime-auth`, or `packages/db` deploys both services), the maintenance rule (update watch patterns whenever a Dockerfile gains another copied path), and a generic hosted-verification procedure (steps, no project/service identifiers) | PASS - "Build triggers" section has the full API/worker trigger matrix, shared-input behavior row, a maintenance rule, and a 5-step generic verification procedure with no identifiers. | CONFIRMED - matches. | |
| AC-DOC-003 | D4, D5 | `/devops` | Documentation hygiene | Code review: new content in both docs | Neither doc's new content names a particular hosted Railway project, environment, organization, consumer, URL, service ID, or deployment evidence | PASS - `git diff origin/main -- docs/architecture.md docs/decision-runtime-deployment.md` grepped for hosted-identifier patterns (railway.app URLs, project/service/org IDs, prod-/staging- prefixes): zero matches. | CONFIRMED - matches; also spot-checked `docs/README.md`'s one-line edit, no identifiers. | |
| AC-OPS-001 | D5 | `/devops` | Hosted smoke (deferred) | Manual, post-merge; not run in this session | The generic verification procedure required by AC-DOC-002 is documented and ready to run; the live execution against a provisioned decision-runtime service is explicitly marked DEFERRED, not PASS — confirmed with the user that no service is currently provisioned and provisioning one is out of scope for this session (see plan.md Current State); tracked by issue [#65](https://github.com/yuens1002/openclaw-control-plane/issues/65) so the deferral survives this PR closing #62 | DEFERRED - plan.md Current State documents the finding (`mcp__railway__list-services` shows no provisioned decision-runtime service) and the confirmed-with-user deferral; no file marks this row PASS. | CONFIRMED-DEFERRED - tracking issue #65 filed so the deferral has an open tracker independent of #62's closure. | |

## Regression Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-REG-001 | — | `/test-engineer` | All existing tests pass | Test run: `npm test` | Full suite passes with the new test file included, 0 failures | PASS - 38 files, 348 tests, 28 pre-existing Postgres-gated skips, 0 failures. | CONFIRMED - matches. | |
| AC-REG-002 | — | `/devops` | Typecheck and build stay clean | Test run: `npm run typecheck`, `npm run build` | 0 type errors, build succeeds | PASS - both clean exit, no output. | CONFIRMED - matches. | |
| AC-REG-003 | — | `/devops` | Both Docker images still build | `docker build -f deploy/decision-runtime/Dockerfile .` and `docker build -f deploy/decision-runtime/worker.Dockerfile .` | Both images build successfully; config-only/docs-only changes do not alter build output | PASS - both re-built successfully (cached layers, confirming config/docs-only changes didn't invalidate the build); verify images removed after. | CONFIRMED - matches. | |
| AC-REG-004 | — | `/project-manager` | Diff scope check | `git diff origin/main --stat` | Changed files are exactly the plan's Files to Create/Edit lists — no extras | PASS, WITH A NOTE - diff is a strict subset of Files to Create/Edit (no extras); `review.md` (D8) not yet present, same expected-sequencing gap as AC-COV-003. | CONFIRMED-WITH-FIX - re-ran after adding `review.md` and the `docs/README.md` edit; diff now covers the full planned file list with no extras. | |

---

## Agent Notes

Verification sub-agent independently re-derived AC-FN-001/002's expected
watch-pattern sets from the real Dockerfiles (not trusted from the plan) and
hand-traced `matchesAnyPattern`, `deriveExpectedPatterns`, and the
drift-detection test against the real files/synthetic fragment rather than
just observing the test suite go green — no test found passing for the wrong
reason. 21/23 ACs PASS; AC-COV-003 and AC-REG-004 flagged the same
`review.md`-not-yet-written gap (expected sequencing per Commit Schedule
item 5, not a code defect); AC-OPS-001 correctly recorded as DEFERRED, not
PASS. No hosted Railway identifiers found in any new doc content. One
non-blocking fragility note: `deriveExpectedPatterns`'s file-vs-directory
heuristic (dot-in-basename) is correct for every path in both current
Dockerfiles but is a basename guess, not a filesystem stat — acceptable
given the derivation fails loudly (breaks set-equality) rather than
silently if it ever misclassifies a future path.

## QC Notes

Fix count: 1 new file (`review.md`, this session, immediately after this QC
pass — see AC-COV-003/AC-REG-004). Two additional fixes made after the
sub-agent's pass, based on a second advisor review of the plan itself (not
sub-agent findings): (1) `docs/README.md`'s Architecture one-liner was stale
against the new Deployment Topology section — updated, and the plan's
Files-to-Edit table and D4 description amended in the same edit per this
project's own retro rule on mid-plan design-decision updates; (2) a real,
if currently non-overlapping, collision risk with the in-flight local
`feat/decision-runtime-mcp` branch (touches `docs/architecture.md` and
`docs/README.md`) was diffed, confirmed non-overlapping at today's line
ranges, and documented in plan.md's Current State with an explicit re-check
instruction before Phase 5 handoff. No test or config-file changes needed —
the sub-agent found zero implementation defects in D1-D3. One iteration; no
re-verification loop was required since all findings were docs-only
(README sync, review.md authoring) or process (collision-risk
documentation), not code drift.

## Reviewer Feedback

*Human fills this section during review.*
