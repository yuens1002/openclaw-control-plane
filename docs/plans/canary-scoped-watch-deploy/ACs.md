# Canary-Scoped Watch Deploy — Acceptance Criteria

**Branch:** `feat/canary-scoped-watch-deploy`
**Plan:** `docs/plans/canary-scoped-watch-deploy/plan.md`

---

## Context

Gives the canary's OpenClaw wrapper the same git-connected, `watchPatterns`-scoped deploy trigger its attached engine services already have, so build-relevant commits redeploy it automatically while docs/plans/CHANGELOG churn does not. Session 1 is repo-file-only (config, drift-guard test, docs). Session 2 is a human-confirmed live Railway reconnect plus an empirical push-test proving the scoped trigger behaves as intended.

Per this repo's Public-Repo Rule (`docs/README.md`), all evidence below records pass/fail outcomes only — no deployment IDs, service names, domains, or raw config dumps.

---

## Column Definitions

| Column | Filled by | When |
|--------|-----------|------|
| **Plan ref** | Author (PM) | At AC authoring — links each row to a Plan deliverable ID |
| **Role** | Author (PM) | At AC authoring — names the owning role |
| **Agent** | Verification sub-agent | During verification — PASS/FAIL with evidence |
| **QC** | Main thread agent | After sub-agent report — confirms or overrides |
| **Reviewer** | Human | During manual review — final approval per AC |

---

## Pass-condition rule

Pass = invariant, not config-literal. See `templates/acs-template.md`. This repo has no browser UI (see `docs/AGENTIC-WORKFLOW.md`) — no UI ACs table.

---

## Functional Acceptance Criteria (Session 1 — repo files)

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
|----|----------|------|------|-----|------|-------|----|----------|
| AC-FN-1 | D1 | `/devops` | `deploy/openclaw-railway/canary.railway.toml` | Code review against root `Dockerfile` and root `railway.toml` | `dockerfilePath` points at the root `Dockerfile`; `[deploy]` block matches root `railway.toml`'s healthcheck/restart/volume settings; `watchPatterns` contains exactly the Dockerfile's five non-`--from=` `COPY` sources plus the Dockerfile itself, this config file itself, and `.dockerignore` (8 entries, no more, no fewer); `[variables]` is absent; no comment in the file names the canary's actual Railway service or project | PASS — `dockerfilePath` resolves to root `Dockerfile`; `[deploy]` byte-identical to root `railway.toml`; watchPatterns verified as exactly 8 entries matching the Dockerfile's COPY lines; `[variables]` absent; comments generic. | PASS · confirmed | |
| AC-FN-2 | D3 | `/project-manager` | `docs/architecture.md` "Deployment Topology" | Code review: read the section | Describes two independently git-connected wrapper deployments — one unscoped (deploys every commit), one scoped (`watchPatterns`) — with no remaining claim that only one Railway service is built from this repo's git history | PASS — section describes both deployment models; rest of file grepped for stale single-service language, none found. | PASS · confirmed | |
| AC-FN-3 | D4 | `/project-manager` | `deploy/openclaw-railway/README.md` canary subsection | Code review: read the section against "Agency-Controlled Client Provisioning" | New subsection names the canary as the deliberate, explained exception to that section's "don't point a client service at `main`" reasoning; the two sections read as consistent, not contradictory | PASS — "The Canary" section sits immediately before "Agency-Controlled Client Provisioning" and explicitly frames the exception. | PASS · confirmed | |
| AC-FN-4 | D5 | `/project-manager` | `CHANGELOG.md` | Code review | `[Unreleased]` gains an accurate one-line entry for this feature | PASS — entry present and accurate. | PASS · confirmed | |

## Test Coverage Acceptance Criteria (Session 1)

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
|----|----------|------|------|-----|------|-------|----|----------|
| AC-TST-1 | D2 | `/test-engineer` | `tests/canary-watch-patterns.test.ts` | Test run: `npm test` | Asserts (a) `watchPatterns` is non-empty, (b) the declared set exactly equals the set mechanically derived from the Dockerfile's `COPY` sources (drift guard, not a hardcoded literal list), (c) each of the five source files + Dockerfile + config file matches, (d) root `railway.toml`, docs/README/CHANGELOG, root package manifests, unrelated `scripts/*` files, the pinned-client `.ps1` scripts, `tests/**`, and `.github/**` all do NOT match, (e) a synthetic Dockerfile gaining a new `COPY` source is caught as drift, (f) `--from=` lines and flags like `--chown` are correctly excluded/stripped during derivation | PASS — 9/9 tests pass (`npm test`). An earlier 10th case asserting the committed config never contains the live service/project name was removed: it satisfied its own intent (the `.toml` doesn't contain those strings) but violated the Public-Repo Rule itself by writing the literal forbidden strings into a committed test file — flagged by the Phase 3 verification sub-agent's explicit Public-Repo Rule check, not by any AC. AC-FN-1's code review already covers "no comment names the service" without that risk. | PASS · confirmed, fix applied for the sub-agent's Public-Repo Rule finding | |

## Regression Acceptance Criteria (Session 1)

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
|----|----------|------|------|-----|------|-------|----|----------|
| AC-REG-1 | — | `/test-engineer` | All existing tests pass | Test run: `npm test` | 287+ tests pass, 0 failures | PASS — 297/297 passed (287 baseline + AC-TST-1's 9, after the fixup below removed one over-broad case). | PASS · confirmed | |
| AC-REG-2 | — | `/devops` | Precheck passes clean | Test run: `npm run precheck` | 0 type errors, build succeeds, precheck stamp written for the branch's actual HEAD commit | PASS — typecheck/build clean, stamp matched HEAD at verification time. | PASS · confirmed, re-run after the AC-TST-1 fixup | |

## Live Deployment Acceptance Criteria (Session 2 — human-confirmed, live infra)

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
|----|----------|------|------|-----|------|-------|----|----------|
| AC-FN-5 | D6 | `/devops` | Canary Railway service reconnect | Read back the service's config after the human-confirmed reconnect | Git source set to this repo's tracked branch; config-as-code path resolves to `deploy/openclaw-railway/canary.railway.toml`; builder is the Dockerfile builder (not the prior CLI-detected builder); "Wait for CI" is enabled, matching the public-proof service. Recorded as a pass/fail statement only — no raw config, service/project identifiers, or variable names in the evidence cell. | | | |
| AC-FN-6 | D7 | `/devops` | Docs-only push, negative control | Merge a docs-only PR to the tracked branch; check deployment status for both the canary and the public-proof service for that commit | Canary receives no new deployment for that commit; public-proof service receives a new deployment that reaches success for the same commit (proves the push was actually seen — a canary-only check can't distinguish "correctly skipped" from "never triggered at all") | | | |
| AC-FN-7 | D7 | `/devops` | Watched-path push, positive case | Merge a PR touching exactly one watched path (e.g. a comment-only change in one of the five `scripts/*.mjs` sources); check the canary's deployment status for that commit | Canary receives exactly one new deployment for that commit, and it reaches success | | | |

---

## Agent Notes

(Filled during Phase 3 verification.)
