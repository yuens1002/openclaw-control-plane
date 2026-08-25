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
| AC-COV-001 | D6 | `/project-manager` | Plan exists | Code review: `docs/plans/decision-runtime-watch-patterns/plan.md` | Plan names branch, source, current state (incl. the proven-not-assumed COPY-derived build input, the no-live-service finding, the config-as-code deprecation note), approach, deliverables with roles, design decisions, files to create/edit, gate 1/2 pre-check, commit schedule, dependencies, out of scope | | | |
| AC-COV-002 | D7 | `/project-manager` | ACs table exists | Code review: `docs/plans/decision-runtime-watch-patterns/ACs.md` | Every AC row has a valid Plan ref (D1-D8, or `—` for cross-cutting regression rows) and Role; every deliverable D1-D8 is referenced by at least one row | | | |
| AC-COV-003 | D8 | `/project-manager` | Review scaffold exists | Code review: `docs/plans/decision-runtime-watch-patterns/review.md` | Review doc has sections for verdict, deliverables↔code, ACs↔tests, docs drift, recommendations | | | |

## Functional Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-001 | D1 | `/devops` | `deploy/decision-runtime/railway.toml` declares the API service's watch patterns | Code review: `deploy/decision-runtime/railway.toml` | `[build] watchPatterns` is present and its array set-equals `{/apps/api/**, /packages/contracts/**, /packages/runtime-auth/**, /packages/db/**, /package.json, /package-lock.json, /tsconfig.json, /tsconfig.base.json, /apps/api/package.json, /packages/contracts/package.json, /packages/runtime-auth/package.json, /packages/db/package.json, /deploy/decision-runtime/Dockerfile, /deploy/decision-runtime/railway.toml, /.dockerignore}` — no negation patterns | | | |
| AC-FN-002 | D2 | `/devops` | `deploy/decision-runtime/worker.railway.toml` declares the worker service's watch patterns | Code review: `deploy/decision-runtime/worker.railway.toml` | `[build] watchPatterns` is present and its array set-equals the same set as AC-FN-001 with `apps/api`→`apps/worker` and the Dockerfile/`railway.toml` names swapped to their `worker.*` equivalents — no negation patterns | | | |
| AC-FN-003 | D1, D2 | `/devops` | Root OpenClaw deploy config is untouched (isolation) | `git diff origin/main -- railway.toml Dockerfile` | Empty diff — root `railway.toml` and root `Dockerfile` are byte-identical to `origin/main`, gain no `watchPatterns` key | | | |

## Test Coverage Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-TST-001 | D3 | `/test-engineer` | API app change matches only the API service | Test run: `npm test -- --run tests/decision-runtime-watch-patterns.test.ts` | A path under `apps/api/**` (e.g. `apps/api/src/server.ts`) matches the API pattern list and does not match the worker pattern list | | | |
| AC-TST-002 | D3 | `/test-engineer` | Worker app change matches only the worker service | Test run: same file | A path under `apps/worker/**` (e.g. `apps/worker/src/index.ts`) matches the worker pattern list and does not match the API pattern list | | | |
| AC-TST-003 | D3 | `/test-engineer` | Shared package change matches both services | Test run: same file | Paths under `packages/contracts/**`, `packages/runtime-auth/**`, and `packages/db/**` (including a path under `packages/db/migrations/`) each match both the API and worker pattern lists | | | |
| AC-TST-004 | D3 | `/test-engineer` | Dependency/config change matches both services | Test run: same file | `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.base.json`, and `.dockerignore` each match both the API and worker pattern lists | | | |
| AC-TST-005 | D3 | `/test-engineer` | Deployment-target change matches only its own service | Test run: same file | `deploy/decision-runtime/railway.toml` matches the API pattern list and not the worker list; `deploy/decision-runtime/worker.railway.toml` matches the worker pattern list and not the API list | | | |
| AC-TST-006 | D3 | `/test-engineer` | Unrelated change matches neither service | Test run: same file | A docs-only path (`docs/decision-runtime-deployment.md`), an OpenClaw-wrapper-only path (`packages/openclaw-railway-installer/src/cli.ts`), the root OpenClaw config (`railway.toml`, `Dockerfile`), and an unrelated package path (`workers/vending/src/index.ts`) each match neither the API nor the worker pattern list | | | |
| AC-TST-007 | D3 | `/test-engineer` | Config parity — watch patterns match Dockerfile build input exactly | Test run: same file | For each service, the pattern set mechanically derived from that service's real Dockerfile build-stage `COPY` sources (directory copy → `dir/**`, file copy → exact path, `--from=build` lines excluded) plus its three known extras (own Dockerfile, own `railway.toml`, `.dockerignore`) is set-equal to the `watchPatterns` array actually declared in that service's `railway.toml` | | | |
| AC-TST-008 | D3 | `/test-engineer` | Config parity detects drift, not just agreement | Test run: same file | Feeding the same derivation function a synthetic Dockerfile fragment with one extra `COPY <newpath> <newpath>` source that is absent from a given pattern list produces a detected mismatch — proving the parity check would fail on a future Dockerfile addition, not merely that today's real files happen to agree | | | |

## Documentation Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-DOC-001 | D4 | `/devops` | Architecture documentation | Code review: `docs/architecture.md` | New section distinguishes project/service/build/deployment/runtime boundaries across the three independent Railway services (OpenClaw, decision-runtime API, decision-runtime worker); includes a generic topology/trigger description (no hosted identifiers); explicitly states that rebuilding one sibling service does not rebuild another | | | |
| AC-DOC-002 | D5 | `/devops` | Operations documentation | Code review: `docs/decision-runtime-deployment.md` | New section documents the API/worker watch-path trigger matrix, shared-input behavior (a change under `packages/contracts`, `packages/runtime-auth`, or `packages/db` deploys both services), the maintenance rule (update watch patterns whenever a Dockerfile gains another copied path), and a generic hosted-verification procedure (steps, no project/service identifiers) | | | |
| AC-DOC-003 | D4, D5 | `/devops` | Documentation hygiene | Code review: new content in both docs | Neither doc's new content names a particular hosted Railway project, environment, organization, consumer, URL, service ID, or deployment evidence | | | |
| AC-OPS-001 | D5 | `/devops` | Hosted smoke (deferred) | Manual, post-merge; not run in this session | The generic verification procedure required by AC-DOC-002 is documented and ready to run; the live execution against a provisioned decision-runtime service is explicitly marked DEFERRED, not PASS — confirmed with the user that no service is currently provisioned and provisioning one is out of scope for this session (see plan.md Current State) | | | |

## Regression Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-REG-001 | — | `/test-engineer` | All existing tests pass | Test run: `npm test` | Full suite passes with the new test file included, 0 failures | | | |
| AC-REG-002 | — | `/devops` | Typecheck and build stay clean | Test run: `npm run typecheck`, `npm run build` | 0 type errors, build succeeds | | | |
| AC-REG-003 | — | `/devops` | Both Docker images still build | `docker build -f deploy/decision-runtime/Dockerfile .` and `docker build -f deploy/decision-runtime/worker.Dockerfile .` | Both images build successfully; config-only/docs-only changes do not alter build output | | | |
| AC-REG-004 | — | `/project-manager` | Diff scope check | `git diff origin/main --stat` | Changed files are exactly the plan's Files to Create/Edit lists — no extras | | | |

---

## Agent Notes

*Filled by the verification sub-agent.*

## QC Notes

*Filled by the main thread after reading verification evidence.*

## Reviewer Feedback

*Human fills this section during review.*
