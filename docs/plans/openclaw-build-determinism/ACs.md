# OpenClaw Build Determinism — Acceptance Criteria

**Branch:** `fix/openclaw-build-lockfile-determinism`
**Plan:** `docs/plans/openclaw-build-determinism/plan.md`

---

## Context

Fixes issue #104: the wrapper image's `openclaw-build` Docker stage runs `pnpm install --no-frozen-lockfile`, re-resolving the OpenClaw monorepo's full dependency graph against the live npm registry on every build — the root cause of a 26+-hour deploy-failure window (a registry-side `minimumReleaseAge` policy blocked one transitive package). This session commits a resolved lockfile and switches to `--frozen-lockfile` for real builds, adds a deliberate regeneration path plus a drift-guard test, and adds a Railway deploy-status check to close the detection gap that let the failure run unnoticed.

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

## Functional Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
|----|----------|------|------|-----|------|-------|----|----------|
| AC-FN-1 | D1 | `/devops` | `scripts/relax-openclaw-extension-versions.mjs` | Code review + direct run against the real cloned OpenClaw source | For every extension `package.json` with `"openclaw": ">=X"` or `"openclaw": "workspace:X"`, the script rewrites it to `"openclaw": "*"` AND exits non-zero if it relaxes ZERO files in aggregate across the whole extension set (an aggregate guard, not per-file exactly-one — legitimately zero or more than one constraint can exist in a single extension's own `package.json`) — same fail-loudly spirit as `scripts/patch-wrapper-restart-gateway.mjs`'s guards, adapted since this script targets many files, not one. Verified live: relaxed 32/138 extension files against the real pinned `OPENCLAW_GIT_REF` source. | | | |
| AC-FN-2 | D2 | `/devops` | `Dockerfile`'s `openclaw-build` stage | Code review: diff against current `Dockerfile` | The inline sed loop for extension-version relaxation is gone, replaced by a call to AC-FN-1's script; the real build's `pnpm install` step uses `--frozen-lockfile` (not `--no-frozen-lockfile`); a new `openclaw-lockfile-refresh` stage exists whose only material difference from the real build stage is retaining `--no-frozen-lockfile` | | | |
| AC-FN-3 | D2, D3, D4 | `/devops` | Real (non-refresh) Docker build | `docker build` (default/final target) run locally against the current branch | Build succeeds AND the `openclaw-build` stage's `pnpm install` log shows a frozen-lockfile confirmation (no live "Progress: resolved N..." registry re-resolution lines for the OpenClaw monorepo's dependency graph) | | | |
| AC-FN-4 | D4 | `/devops` | `scripts/generate-openclaw-lockfile.sh` | Run the script once against the current `OPENCLAW_GIT_REF` | Produces a valid-YAML `deploy/openclaw-railway/openclaw.pnpm-lock.yaml` AND a `deploy/openclaw-railway/openclaw.pnpm-lock.meta.json` whose `openclawGitRef` field exactly equals the Dockerfile's `OPENCLAW_GIT_REF` ARG value at run time | | | |
| AC-FN-5 | D6 | `/devops` | `verify-deploy-cli.ts`'s pure selection/classification logic | Code review + AC-TST-2's unit tests + live run against the real service | Default mode selects the most recent deployment (`selectLatestDeployment`, i.e. `deployments[0]`) rather than matching a specific commit; `RAILWAY_DEPLOY_TARGET_SHA` opts into commit-matching instead (for manual `workflow_dispatch` checks); classifies status via the package's shared `terminalFailureStatuses` set into success/failure/pending; exits 0 with an explicit "not configured, skipping" message (not a thrown error) when `RAILWAY_PROJECT_ID`/`RAILWAY_ENVIRONMENT_ID`/`RAILWAY_SERVICE_ID` are unset; a transient query failure (Railway API error) is reported distinctly from a deployment-status failure. **Design correction from the original plan** (found via `/ocr-review`, both dimension reviewers independently): this repo's Railway service has `source.checkSuites: true` ("Wait for CI") — a push-triggered version of this check would itself be a check suite Railway waits on before letting the deployment leave `WAITING`, deadlocking every future deploy. Confirmed live via `get-service-config`. Redesigned as a periodic snapshot check instead of a per-push poll-to-completion loop; see D6's file header for the full reasoning. |  |  | |
| AC-FN-6 | D7 | `/devops` | `.github/workflows/railway-deploy-verify.yml` | Code review: workflow YAML | Triggers on `schedule` (every 15 min) + `workflow_dispatch` (with an optional `target_sha` input) — deliberately NOT `push`, for the reason in AC-FN-5. Passes `RAILWAY_TOKEN`/`RAILWAY_PROJECT_ID`/`RAILWAY_ENVIRONMENT_ID`/`RAILWAY_SERVICE_ID` from `secrets.*`, scoped to only the verify step (not job-level); `@railway/cli` pinned to the version verified at wiring time; `timeout-minutes` set; the job's exit status reflects the script's (fails when the script reports a genuine deployment failure) | | | |

## Test Coverage Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
|----|----------|------|------|-----|------|-------|----|----------|
| AC-TST-1 | D5 | `/test-engineer` | `tests/openclaw-lockfile-ref-consistency.test.ts` | Test run: `npm test` | Fails when the Dockerfile's `OPENCLAW_GIT_REF` and the committed meta.json's `openclawGitRef` are set to different values (asserted via the actual cross-file relation, not a hardcoded literal ref string); passes when they match | | | |
| AC-TST-2 | D8 | `/test-engineer` | `tests/verify-deploy-cli.test.ts` | Test run: `npm test` | Asserts, against constructed fixtures (no live Railway calls): (1) deployment selection picks the commit-SHA match even when it isn't first in the array, (2) status classification correctly separates terminal-success/terminal-failure/still-building, (3) the unconfigured-env-vars path exits 0 with a skip message | | | |

## Regression Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
|----|----------|------|------|-----|------|-------|----|----------|
| AC-REG-1 | — | `/test-engineer` | All existing tests pass | Test run: `npm test` | 268+ tests pass, 0 failures | | | |
| AC-REG-2 | — | `/devops` | Precheck passes clean | Test run: `npm run precheck` | 0 errors, 0 type errors | | | |

---

## Agent Notes

{Sub-agent writes here during verification.}

## QC Notes

{Main thread writes here during QC.}

## Reviewer Feedback

*Human fills this section during review.*
