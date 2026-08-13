# Open Source Readiness Acceptance Criteria

**Branch:** `feat/open-source-readiness`
**Plan:** `docs/plans/open-source-readiness/plan.md`

## Context

This readiness gate prepares OpenClaw Control Plane for public visibility as a
workflow-neutral Chief of Staff control-plane foundation. It must preserve the
shell install path and keep client-specific workflows, including the
location-spec pipeline, out of the base automation. The existing Railway
OpenClaw template deployment is treated as a proof instance: useful for proving
the shell setup works, but not a place where client workflows are installed by
the base repo.

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
| AC-COV-001 | D1 | `/project-manager` | Readiness plan exists and follows the project plan convention | Code review: `docs/plans/open-source-readiness/plan.md` | Plan names branch, source, deliverables, files to create/edit, sessions, commit schedule, dependencies, and out-of-scope items | PASS - plan names branch/source, D1-D10, files, sessions, commit schedule, dependencies, and out-of-scope items. | PASS - confirmed plan structure after D10 Railway proof-source refinement. | PENDING |
| AC-COV-002 | D2 | `/project-manager` | AC table exists with traceable workflow columns | Code review: `docs/plans/open-source-readiness/ACs.md` | Every non-regression AC row has a valid Plan ref and Role, plus Agent, QC, and Reviewer columns | PASS - AC table has Plan ref, Role, Agent, QC, Reviewer columns and all non-regression refs resolve. | PASS - manual Gate 1 check confirms D1-D10 coverage. | PENDING |
| AC-COV-003 | D9 | `/project-manager` | Final review scaffold exists | Code review: `docs/plans/open-source-readiness/review.md` | Review doc has sections for findings, verification, AC coverage, residual risk, and recommendation | PASS - review scaffold has required sections. | PASS - review updated with final verification and residual risks. | PENDING |

## Functional Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-001 | D3 | `/project-manager` | Public positioning | Code review: `README.md` and top-level docs | Docs describe the repo as a reusable OpenClaw Chief of Staff control-plane foundation, not a vending/location pipeline product | PASS - README/docs position the repo as workflow-neutral baseline. | PASS - README/CONTRIBUTING use public-safe reusable-core language. | PENDING |
| AC-FN-002 | D4 | `/backend-architect` | Workflow-neutral repo boundary | Code review plus search for `vending`, `location`, `connector`, and `pipeline` | No production workflow, connector, or service is enabled by default for any specific client or vertical | PASS - API returns empty registry/pipeline list; worker logs no workflows; core contracts and DB no longer include vending defaults. | PASS - fixed initial verifier failure by removing vending seeds/tables and default app wiring. | PENDING |
| AC-FN-003 | D4 | `/backend-architect` | Domain-specific material framing | Code review: domain-specific docs/code found by search | Any remaining domain-specific material is explicitly framed as fake/manual example, skeleton, or extension point | PASS - vending schemas now live under `workers/vending`; docs frame it as an example not installed by baseline. | PASS - fixed initial verifier failure by moving vending schemas out of core contracts and updating stale docs. | PENDING |
| AC-FN-004 | D5 | `/devops` | Shell-only Railway install path | Code review: `deploy/openclaw-railway/README.md`, `packages/openclaw-railway-installer/src/index.ts`, and installer tests | Railway/OpenClaw install path does not install, enable, or assume any client workflow, connector, or pipeline | PASS - Railway docs and generated handoff keep workflow attachment after shell health. | PASS - installer test asserts handoff boundary and docs describe shell-only install. | PENDING |
| AC-FN-005 | D7 | `/project-manager` | Public metadata readiness | Code review: `package.json`, workspace package manifests, `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, and repository metadata fields | Public project files and package metadata are intentional for a public repo; any private flags or missing repository URLs are explicitly accepted or fixed | PASS - license/repo metadata present; package privacy intentionally documented. | PASS - README explains public GitHub repo with npm publishing out of scope. | PENDING |
| AC-FN-006 | D10 | `/devops` | Railway proof-instance source stance | Code review: public docs and installer docs | Docs distinguish reusable shell-template source updates from client workflow repo connections, and do not encode private Railway dashboard IDs | PASS - README/deploy docs distinguish upstream template dependency from client workflow repos; no private Railway IDs found. | PASS - plan/docs record proof-instance stance without dashboard URLs or IDs. | PENDING |
| AC-FN-007 | D11 | `/devops` | Railway template pin | Code review: `deploy/openclaw-railway/template-lock.json` | Lock records upstream repo, monitored branch/ref, pinned commit SHA, and mirror policy metadata without private Railway IDs | PASS - lock pins `vignesh07/clawdbot-railway-template@main` to `b9e2467189d02dfe51a80173c40bad650a58eaf2`. | PASS - live checker reports latest equals pinned and no private Railway IDs are encoded. | PENDING |
| AC-FN-008 | D12 | `/devops` | Weekly update detection | Code review: `.github/workflows/railway-template-update.yml` and checker script | Weekly/manual workflow runs the checker and reports when upstream differs from the pinned commit without auto-updating the lock | PASS - weekly/manual workflow runs `npm run railway-template:check`; checker exits nonzero on `update_available`. | PASS - tests cover update available without mutating lock; live check reports current. | PENDING |
| AC-FN-009 | D13 | `/devops` | Mirror/eject policy | Code review: `deploy/openclaw-railway/README.md` | Docs explain that an ejected/mirrored approved branch is the immutable Railway source-control layer, and upstream updates require smoke testing before the mirror advances | PASS - deploy README documents approved mirror branch and smoke-before-bump policy. | PASS - lock mirrors policy metadata with `autoApply: false` and `requiresSmokeBeforeBump: true`. | PENDING |

## Security Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-SEC-001 | D6 | `/security` | Tracked-file secret and client-data scan | Search tracked files for `.env`, `.env.local`, handoff passwords, Railway tokens, provider keys, private operational URLs, and client data | No tracked file exposes private credentials, local handoff artifacts, private URLs, or client-specific data | PASS - tracked scan found no private Railway IDs/URLs, tokens, private keys, provider keys, or tracked handoff artifacts. | PASS - `.env.local` and `*.local.md` are ignored; fake test domains use reserved example hostnames. | PENDING |
| AC-SEC-002 | D6 | `/security` | Git-history secret scan | Run a history scan for obvious secrets and private handoff artifacts | No obvious credentials or private handoff artifacts are found in git history, or findings are documented with mitigation before visibility changes | PASS - history scan found no obvious live token/private-key/dashboard-ID patterns or committed `.env.local`/handoff files. | PASS - residual product-boundary history risk noted in review; no credential leak found. | PENDING |

## Test Coverage Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-TST-001 | D5 | `/test-engineer` | Installer handoff boundary test | Test run: `npm.cmd run test -- --run tests/openclaw-railway-installer.test.ts tests/openclaw-railway-cli.test.ts` | Focused installer tests pass and assert that generated handoff keeps client workflows attached only after shell health | PASS - focused installer/CLI tests passed: 2 files, 7 tests. | PASS - reran focused installer plus shell tests after fixture-domain cleanup. | PENDING |
| AC-TST-002 | D8 | `/test-engineer` | Full project verification | Test runs: `npm.cmd run typecheck`, `npm.cmd run test`, and `npm.cmd run build` | Typecheck, all tests, and build complete with 0 failures | PASS - typecheck, full tests, and build passed; full suite 6 files, 16 tests. | PASS - reran full suite after template-lock checker and workflow additions. | PENDING |
| AC-TST-003 | D12 | `/test-engineer` | Template update checker behavior | Test run: `npm.cmd run test -- --run tests/openclaw-railway-template-lock.test.ts` | Tests cover up-to-date, update-available, malformed lock, and upstream fetch failure states | PASS - template lock tests passed: 1 file, 4 tests. | PASS - tests cover current, update-available, malformed lock, and fetch failure. | PENDING |

## Regression Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-REG-001 | - | `/test-engineer` | Static whitespace check | Test run: `git diff --check` | Diff contains no trailing whitespace or whitespace-error markers | PASS - `git diff --check` passed. | PASS - reran after final docs and AC updates. | PENDING |
| AC-REG-002 | - | `/project-manager` | Human release gate | Code review: `docs/plans/open-source-readiness/review.md` | Review records that repository visibility must not change until explicit human approval is given | PASS - review records explicit human approval is required before visibility change. | PASS - final recommendation keeps repository visibility switch blocked on human approval. | PENDING |

## Agent Notes

Verifier pass 1 found AC-FN-002 and AC-FN-003 failures because core DB/contracts
still embedded vending. After fixes, verifier pass 2 returned PASS for all ACs.

## QC Notes

Main-thread QC confirmed the fixes by removing vending from core contracts and
DB, keeping the API/worker shell empty, rerunning typecheck/tests/build, and
rerunning public-release scans. Reviewer column remains pending human approval.

## Reviewer Feedback

Human fills this section during review.
