# Canary-Scoped Watch Deploy — Acceptance Criteria

**Branch:** `feat/canary-scoped-watch-deploy`
**Plan:** `docs/plans/canary-scoped-watch-deploy/plan.md`

---

## Context

Gives the canary's OpenClaw wrapper the same git-connected, `watchPatterns`-scoped deploy trigger its attached engine services already have, so build-relevant commits redeploy it automatically while docs/plans/CHANGELOG churn does not. Session 1 is repo-file-only (a reference spec, its drift-guard test, docs). Session 2 is a human-confirmed live Railway reconnect plus an empirical push-test proving the scoped trigger behaves as intended.

**Revised during `/ocr-review`** (see plan.md's "Revised during `/ocr-review`" note): Railway's Config as Code is deprecated and unavailable to a service adopting it for the first time, which the canary would be. `deploy/openclaw-railway/canary.railway.toml` is therefore a committed reference spec only — Railway does not read it. Its values are applied to the live service as native per-service settings (a plain, non-deprecated Railway API surface) in Session 2 instead.

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
| AC-FN-1 | D1 | `/devops` | `deploy/openclaw-railway/canary.railway.toml` | Code review against root `Dockerfile` and root `railway.toml` | `dockerfilePath` points at the root `Dockerfile`; `[deploy]` block matches root `railway.toml`'s healthcheck/restart/volume settings; `watchPatterns` contains exactly the Dockerfile's seven non-`--from=` `COPY`/`ADD` sources plus the Dockerfile itself and `.dockerignore` (9 entries, no more, no fewer — the reference file itself is deliberately excluded, since it has zero effect on the built image and Railway never reads it); `[variables]` is absent; the header comment states plainly that Railway does not read this file and explains why (Config as Code deprecation); no comment names the canary's actual Railway service or project | PASS — `dockerfilePath` resolves to root `Dockerfile`; `[deploy]` byte-identical to root `railway.toml`; watchPatterns verified as exactly 9 entries matching the Dockerfile's COPY lines, including the two added by `#109` after this branch rebased onto current `main` (the file's own path correctly absent); `[variables]` absent; header comment accurately explains the reference-spec framing; other comments generic. | PASS · confirmed, re-verified after the Config-as-Code pivot and after rebasing onto `#109` | |
| AC-FN-2 | D3 | `/project-manager` | `docs/architecture.md` "Deployment Topology" | Code review: read the section | Describes two independently git-connected wrapper deployments — public-proof (Config as Code, deploys every commit) and the canary (reference spec + native per-service settings, `watchPatterns`-scoped) — with no remaining claim that only one Railway service is built from this repo's git history, and no claim that Railway reads the canary's reference file | PASS — section accurately describes both deployment models including the Config-as-Code-vs-native-settings distinction; rest of file grepped for stale single-service or "Railway reads this file" language, none found. | PASS · confirmed, re-verified after the Config-as-Code pivot | |
| AC-FN-3 | D4 | `/project-manager` | `deploy/openclaw-railway/README.md` canary subsection | Code review: read the section against "Agency-Controlled Client Provisioning" | New subsection names the canary as the deliberate, explained exception to that section's "don't point a client service at `main`" reasoning; states plainly that Railway does not read the canary's reference file and explains why; the two sections read as consistent, not contradictory | PASS — "The Canary" section sits immediately before "Agency-Controlled Client Provisioning," explains the Config-as-Code deprecation and native-settings approach, and explicitly frames the exception. | PASS · confirmed, re-verified after the Config-as-Code pivot | |
| AC-FN-4 | D5 | `/project-manager` | `CHANGELOG.md` | Code review | `[Unreleased]` gains an accurate one-line entry for this feature | PASS — entry present, accurate, and reflects the native-settings approach rather than a config-file connection. | PASS · confirmed, re-verified after the Config-as-Code pivot | |

## Test Coverage Acceptance Criteria (Session 1)

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
|----|----------|------|------|-----|------|-------|----|----------|
| AC-TST-1 | D2 | `/test-engineer` | `tests/canary-watch-patterns.test.ts` | Test run: `npm test` | Asserts (a) `watchPatterns` is non-empty, (b) the declared set exactly equals the set mechanically derived from the Dockerfile's `COPY`/`ADD` sources via real filesystem lookup, not a basename heuristic (drift guard, not a hardcoded literal list), (c) each of the seven source files + Dockerfile + `.dockerignore` matches, (d) the reference file itself, root `railway.toml`, docs/README/CHANGELOG, root package manifests, unrelated `scripts/*` files, the pinned-client `.ps1` scripts, `tests/**`, and `.github/**` all do NOT match, (e) a synthetic Dockerfile gaining a new `COPY` source is caught as drift, (f) `--from=` lines and flags like `--chown` are correctly excluded/stripped during derivation, (g) a lowercase `copy` instruction and a backslash-continued line are still recognized, (h) a fully commented-out `watchPatterns` array and a single commented-out entry inside an otherwise-live array are not silently harvested as real | PASS — 11/11 tests pass (`npm test`). Two rounds of fixes applied: (1) an earlier case asserting the committed config never contains the live service/project name was removed — it satisfied its own intent but violated the Public-Repo Rule itself by writing the literal forbidden strings into a committed test file, flagged by the Phase 3 verification sub-agent's explicit Public-Repo Rule check; (2) `/ocr-review`'s Fable-5 consultant pass (dispatched manually since OCR's own harness excludes test files by default) found three genuine medium-severity gaps in the drift guard's own robustness — comment/anchor-blind `parseWatchPatterns`, case/continuation-blind `deriveExpectedPatterns`, and an extension-based file/directory heuristic that would misclassify an extensionless file or dotted directory name — all three fixed (comment-stripping + line-anchoring; case-insensitive `COPY`\|`ADD` + backslash-continuation joining; real `fs.stat` resolution replacing the basename heuristic), plus two low-severity cleanups (derive `dockerfilePath` from the toml instead of hardcoding it; drop a fixture-coupled substring assertion the exact-sync test already subsumed); (3) rebasing onto current `main` after `#109` merged added two more real Dockerfile `COPY` sources the drift guard correctly flagged as missing — added, re-verified. None of the earlier findings were reachable from today's Dockerfile at the time — informational hardening against future drift, not live defects; `#109`'s drift was the live case that hardening exists for. | PASS · confirmed, fix applied for the sub-agent's Public-Repo Rule finding, `/ocr-review`'s three medium-severity findings, and the post-rebase drift | |

## Regression Acceptance Criteria (Session 1)

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
|----|----------|------|------|-----|------|-------|----|----------|
| AC-REG-1 | — | `/test-engineer` | All existing tests pass | Test run: `npm test` | 287+ tests pass, 0 failures | PASS — 322/322 passed after rebasing onto current `main` (298 from this branch's own history + `#109`'s 24 tests merged in). | PASS · confirmed | |
| AC-REG-2 | — | `/devops` | Precheck passes clean | Test run: `npm run precheck` | 0 type errors, build succeeds, precheck stamp written for the branch's actual HEAD commit | PASS — typecheck/build clean; re-run after the Config-as-Code pivot and again after the post-rebase drift fix. | PASS · confirmed, re-run after the pivot and the rebase | |

## Live Deployment Acceptance Criteria (Session 2 — human-confirmed, live infra)

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
|----|----------|------|------|-----|------|-------|----|----------|
| AC-FN-5 | D6 | `/devops` | Canary Railway service reconnect | Read back the service's config after the human-confirmed reconnect | Git source set to this repo's tracked branch; builder is the Dockerfile builder (not the prior CLI-detected builder) with `dockerfilePath` matching D1's reference spec; native `watchPatterns` set to D1's 9 entries; healthcheck/restart settings match D1; no `railwayConfigFile`/config-as-code path is set (Config as Code is not used — see plan.md); "Wait for CI" is enabled, matching the public-proof service. Recorded as a pass/fail statement only — no raw config, service/project identifiers, or variable names in the evidence cell. | | | |
| AC-FN-6 | D7 | `/devops` | Docs-only push, negative control | Merge a docs-only PR to the tracked branch; check deployment status for both the canary and the public-proof service for that commit | Canary receives no new deployment for that commit; public-proof service receives a new deployment that reaches success for the same commit (proves the push was actually seen — a canary-only check can't distinguish "correctly skipped" from "never triggered at all") | | | |
| AC-FN-7 | D7 | `/devops` | Watched-path push, positive case | Merge a PR touching exactly one watched path (e.g. a comment-only change in one of the seven `scripts/*.mjs` sources); check the canary's deployment status for that commit | Canary receives exactly one new deployment for that commit, and it reaches success | | | |

---

## Agent Notes

(Filled during Phase 3 verification.)
