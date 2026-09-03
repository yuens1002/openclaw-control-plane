# /review report — openclaw-build-determinism

**Branch:** `fix/openclaw-build-lockfile-determinism`
**Generated:** 2026-09-03
**Iterations to reach verified:** 1 (Phase 3 sub-agent: 9/10 PASS + 1 time-boxed deferral; QC fixed one adversarial-probe finding and closed the deferral with a real unmodified `docker build` once the external policy window cleared)

## Verdict

Clear — no blocking findings; one minor doc omission and one minor plan/code drift, both non-blocking; proceed to human review.

## Deliverables ↔ Code

| Deliverable | Implementation | Docs touched? | Status |
|-------------|----------------|----------------|--------|
| D1 | `scripts/relax-openclaw-extension-versions.mjs` | N | ✓ shipped |
| D2 | `Dockerfile:229-281` (`openclaw-source`/`openclaw-lockfile-refresh`/`openclaw-build` stages) | N | ✓ shipped |
| D3 | `deploy/openclaw-railway/openclaw.pnpm-lock.yaml`, `deploy/openclaw-railway/openclaw.pnpm-lock.meta.json` | N | ✓ shipped |
| D4 | `scripts/generate-openclaw-lockfile.sh`, `package.json` (`generate-openclaw-lockfile` script) | N | ✓ shipped |
| D5 | `tests/openclaw-lockfile-ref-consistency.test.ts` | N | ✓ shipped |
| D6 | `packages/openclaw-railway-installer/src/verify-deploy.ts`, `verify-deploy-cli.ts`, `package.json` (`railway-deploy:verify`), `packages/openclaw-railway-installer/package.json` (export) | N | ✓ shipped |
| D7 | `.github/workflows/railway-deploy-verify.yml` | N | ✓ shipped |
| D8 | `tests/verify-deploy-cli.test.ts` | N | ✓ shipped |

### Code changes not tied to any deliverable

`packages/openclaw-railway-installer/src/index.ts:52` — `terminalFailureStatuses` changed from a module-private `const` to `export const`. This wasn't in the plan's original "Files to Edit" table (which listed only `Dockerfile` and `package.json`), but it's a direct, appropriately-scoped consequence of an `/ocr-review` finding under D6 (reusing this package's existing terminal-status set instead of a second, divergent one) — already documented in ACs.md's AC-FN-5 Pass condition. Minor plan/code drift, not scope creep: one line, purely additive (a visibility change, no behavior change to `index.ts`'s own logic), and its rationale is fully recorded in the ACs doc and the commit that made it.

## ACs ↔ Tests (Gate 3 spot-check)

| AC | Test file | Asserts invariant? | Notes |
|----|-----------|---------------------|-------|
| AC-TST-1 | `tests/openclaw-lockfile-ref-consistency.test.ts` | ✓ | Reads both the Dockerfile's `OPENCLAW_GIT_REF` and the committed meta.json's `openclawGitRef` at run time and asserts they're equal — a genuine cross-file relation, not a literal pin. Confirmed independently by the Phase 3 sub-agent. |
| AC-TST-2 | `tests/verify-deploy-cli.test.ts` | ✓ | `classifyDeploymentStatus`'s failure-case test iterates the real, imported `terminalFailureStatuses` Set itself (not a copied literal list) — structurally can't drift from `index.ts`'s own definition. `selectDeploymentForCommit`'s tests use non-first-index matches. Confirmed independently by the Phase 3 sub-agent's own adversarial direct-call probes (inputs not copied from the test file) — no discrepancies found. |

No brittle-literal traps found in either.

## Docs drift

### Stale claims (contradiction)
None — the Dockerfile restructuring stays inside the level of detail `docs/architecture.md`/`README.md` already describe the wrapper build at (both only say "the wrapper image, built from the root `Dockerfile`," neither enumerates internal build stages), so no existing prose claim became false.

### Missing updates (omission)
- `docs/AGENTIC-WORKFLOW.md:60-69` — the "Verification tools (this repo's mapping)" table enumerates every other Railway-related npm script this repo has (`railway-proof:verify`, `railway-template:check`, `railway-vars:guard` referenced in prose above it) but has no row for the new `railway-deploy:verify` script this PR adds. This table exists specifically to enumerate this category of thing — a reader following this doc to find "what verification commands does this repo have" would miss the new one. **Recommendation: add a row.**

## Docs hygiene / public-voice audit

None. Grepped the full diff for known private terms (org/repo slugs, individual names) — zero hits. No first-person voice or session-specific narration leaked into any code comment (checked `.ts`/`.mjs`/`.sh`/`Dockerfile` diff lines specifically) — the plan/ACs docs' own references to "the implementer"/"this session" are consistent with this repo's established convention that plans and ACs are point-in-time records, not living docs.

## Recommendations

1. ~~Add a row to `docs/AGENTIC-WORKFLOW.md`'s Verification tools table for `railway-deploy:verify`~~ — applied directly (see Missing updates above); no longer outstanding.

## Inputs for /retro

- **Route:** `/devops` → `.claude/commands/devops.md`
  **Draft principle:** *"When a build stage installs dependencies against a live registry (`--no-frozen-lockfile`, `npm install` without a lockfile, etc.) inside a Dockerfile that also runs on any kind of recurring or automatic trigger (a PaaS autodeploy, a scheduled CI job), check the registry's own supply-chain policies (pnpm's `minimumReleaseAge`, npm's provenance/audit gates) before assuming the only risk is 'a package might be missing' — a policy that REJECTS an in-range, real, correctly-resolving version is a distinct failure mode from a version not existing, and it's time-bound (self-resolving) rather than fixable by retrying immediately. Prefer committing a resolved, frozen lockfile with a deliberate, separately-invoked regeneration path over letting every ordinary build re-resolve live."*
  **Triggered by:** the entire feature — a live-registry `pnpm install --no-frozen-lockfile` in a Dockerfile stage caused a 26+-hour deploy-failure window (issue #104) with no code change involved.

- **Route:** `/devops` → `.claude/commands/devops.md`
  **Draft principle:** *"Before wiring any new push-triggered GitHub Actions workflow into a repo whose deploy target is a PaaS service, check that service's own 'wait for CI' / check-suite-gating configuration first (e.g. Railway's `source.checkSuites`). A new push-triggered check that itself polls for that same deployment to reach a terminal state creates a direct deadlock: the PaaS platform won't advance the deployment past its own CI-wait state until every push-triggered check (including the new one) finishes, and the new check will never see the deployment finish because the platform is waiting on it. This is invisible until the check's own required secrets/config are live — a dry run with unconfigured credentials looks completely fine."*
  **Triggered by:** AC-FN-5/AC-FN-6's original push-triggered design, caught only by an `/ocr-review` pass (independently, by both parallel reviewer dimensions) and confirmed live via `get-service-config` before it could ship — this would have permanently broken every future deploy on this repo's canary the moment its four required secrets were configured (which happened in the same session).

- **Route:** `/devops` → `.claude/commands/devops.md`
  **Draft principle:** *"When adding a second consumer of an existing internal classification set (a status-to-outcome map, a terminal-vs-pending state list, an allow/deny set), search the package for an existing definition before writing a new one, even a small one that looks self-evidently correct. A small, independently-written duplicate is exactly where a real semantic disagreement hides — the second author reasons from the obvious cases and omits the non-obvious ones the first author already had a reason to include."*
  **Triggered by:** `verify-deploy.ts`'s first draft defined its own `TERMINAL_FAILURE_STATUSES` set (4 statuses) instead of finding and reusing `index.ts`'s existing `terminalFailureStatuses` (7 statuses) — the two disagreed specifically on `NEEDS_APPROVAL`, which the existing, already-reasoned-through set correctly treats as terminal (a deployment awaiting manual approval will never resolve to `SUCCESS` on its own) and the new one incorrectly treated as still-pending.

- **Route:** cross-cutting → `templates/plan-template.md` or `docs/AGENTIC-WORKFLOW.md`
  **Draft pattern addition:** *When a plan deliverable's own regeneration/build script (D4-style: "run this once, commit the output") depends on an external, registry-side, time-bound gate (a supply-chain policy, a rate limit, a propagation delay), the plan should name that dependency explicitly in its own "Dependencies" section up front — not just discover it during Implement. This doesn't change the plan's deliverables, just sets the human's expectation that "generate once and commit" may not be instant.*
  **Triggered by:** this plan's D3/D4 hit a ~2.5-hour real-time wait (pnpm's `minimumReleaseAge` window) neither the plan's Dependencies section nor its author anticipated until Implement was already underway.
