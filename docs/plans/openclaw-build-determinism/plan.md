# OpenClaw Build Determinism — Plan

Branch: `fix/openclaw-build-lockfile-determinism`
Source: [issue #104](https://github.com/yuens1002/openclaw-control-plane/issues/104)

## Summary

The wrapper image's `openclaw-build` Docker stage runs `pnpm install --no-frozen-lockfile`, re-resolving the entire OpenClaw monorepo's dependency graph against the live npm registry on every build. Any transitive package that trips a registry-side supply-chain policy (today: pnpm's `minimumReleaseAge`, blocking a too-recently-published package) fails the build — which happened on every deploy for 26+ hours across 7 unrelated commits, undetected because CI never checks whether the actual Railway deployment succeeded.

## Current State

`Dockerfile`'s `openclaw-build` stage: clones OpenClaw at a pinned `OPENCLAW_GIT_REF`, `sed`-relaxes every extension's `"openclaw": ">=X"`/`"workspace:X"` constraint to `"*"` across ~162 workspace projects (inline shell loop, no dedicated script), then runs `pnpm install --no-frozen-lockfile` because the relaxation invalidates whatever lockfile ships at that ref. This is the only place in the build with no lockfile-level determinism. Separately, `.github/workflows/ci.yml` runs this repo's own unit tests/typecheck and knows nothing about Railway; the previous `Railway Proof Verify` workflow was deleted (findings-and-decisions.md S-6) for testing nothing useful, leaving no signal at all on real deploy outcomes.

## Approach

1. Extract the inline sed relaxation into a standalone Node script (matching this repo's existing pattern for `scripts/patch-wrapper-restart-gateway.mjs`/`patch-wrapper-scoped-export.mjs` — a real script over a hand-escaped multi-line `sed`, with exactly-one-occurrence guards) so both the real build and the lockfile-regeneration path run identical logic — no risk of the two drifting apart.
2. Generate a resolved `pnpm-lock.yaml` **once**, commit it, and switch the real build to `COPY` it in + `pnpm install --frozen-lockfile`. Regeneration is a deliberate, separate Docker build target invoked only when `OPENCLAW_GIT_REF` bumps — normal builds never touch the live registry for this dependency graph again.
3. A regression test asserts the committed lockfile's recorded ref still matches the Dockerfile's pinned `OPENCLAW_GIT_REF`, so a future ref bump without regenerating the lockfile is caught mechanically instead of silently building against a stale lock.
4. A new script + CI workflow polls Railway for the deployment tied to the just-pushed commit and fails loudly if it isn't `SUCCESS` — closing the detection gap. Follows this repo's existing `verify-proof-cli.ts` conventions (`railway` CLI via `RAILWAY_PROJECT_ID`/`RAILWAY_ENVIRONMENT_ID`/`RAILWAY_SERVICE_ID`, graceful skip-with-message when unconfigured rather than a hard failure).

## Deliverables (with spec-role assignment)

| ID | Deliverable | Kind | Owning role |
|----|-------------|------|-------------|
| D1 | `scripts/relax-openclaw-extension-versions.mjs` — extracts the inline sed loop into a real script with per-file exactly-one-occurrence guards, used by both the real build and D4's regeneration path | build-script | `/devops` |
| D2 | `Dockerfile` — wires D1 in; adds an `openclaw-lockfile-refresh` stage (clone + D1 + `pnpm install --no-frozen-lockfile`, no further build); switches the real `openclaw-build` stage to `COPY` in D3's committed lockfile + `pnpm install --frozen-lockfile` | build-config | `/devops` |
| D3 | `deploy/openclaw-railway/openclaw.pnpm-lock.yaml` + `deploy/openclaw-railway/openclaw.pnpm-lock.meta.json` (records `{openclawGitRef, generatedAt}`) — the committed, resolved lockfile snapshot and its ref-tracking metadata | generated-artifact | `/devops` |
| D4 | `scripts/generate-openclaw-lockfile.sh` + npm script `generate-openclaw-lockfile` — builds D2's `openclaw-lockfile-refresh` target, extracts the resulting lockfile via `docker create`/`docker cp`, writes it plus D3's meta file | script | `/devops` |
| D5 | `tests/openclaw-lockfile-ref-consistency.test.ts` — fails if `Dockerfile`'s `OPENCLAW_GIT_REF` ARG doesn't match D3 meta's `openclawGitRef` | test | `/test-engineer` |
| D6 | `packages/openclaw-railway-installer/src/verify-deploy-cli.ts` + npm script `railway-deploy:verify` — resolves the deployment matching a target commit SHA (default: current HEAD) via `railway deployment list --json`, polls with backoff to a terminal status, exits non-zero unless `SUCCESS`; skips gracefully (exit 0, clear message) when `RAILWAY_PROJECT_ID`/`RAILWAY_ENVIRONMENT_ID`/`RAILWAY_SERVICE_ID` aren't set, matching `verify-proof-cli.ts`'s existing convention | script | `/devops` |
| D7 | `.github/workflows/railway-deploy-verify.yml` — triggers on `push` to `main`, runs D6 with `RAILWAY_TOKEN`/`RAILWAY_PROJECT_ID`/`RAILWAY_ENVIRONMENT_ID`/`RAILWAY_SERVICE_ID` from repo secrets | ci-workflow | `/devops` |
| D8 | `tests/verify-deploy-cli.test.ts` — unit tests for D6's pure logic (select-deployment-by-commit-SHA, terminal-status classification, unconfigured-skip path); the subprocess-calling CLI entrypoint itself stays integration-only, matching this repo's existing convention for `verify-proof-cli.ts` (no dedicated test file) | test | `/test-engineer` |

### Files to Create

| File | Purpose |
|------|---------|
| `scripts/relax-openclaw-extension-versions.mjs` | D1 |
| `deploy/openclaw-railway/openclaw.pnpm-lock.yaml` | D3 |
| `deploy/openclaw-railway/openclaw.pnpm-lock.meta.json` | D3 |
| `scripts/generate-openclaw-lockfile.sh` | D4 |
| `tests/openclaw-lockfile-ref-consistency.test.ts` | D5 |
| `packages/openclaw-railway-installer/src/verify-deploy-cli.ts` | D6 |
| `.github/workflows/railway-deploy-verify.yml` | D7 |
| `tests/verify-deploy-cli.test.ts` | D8 |

### Files to Edit

| File | Change |
|------|--------|
| `Dockerfile` | D2 — replace inline sed loop with D1's script call; add `openclaw-lockfile-refresh` stage; switch real build to committed-lockfile + `--frozen-lockfile` |
| `package.json` | Add `generate-openclaw-lockfile` and `railway-deploy:verify` scripts |

## Sessions

Single session — both deliverable groups are small and independent enough to land together.

| Session | Scope (deliverable IDs) | ACs |
|---------|--------------------------|-----|
| Session 1 | D1–D8 | `ACs.md` |

## Acceptance Criteria

→ See `ACs.md`.

- **Session 1**: `Dockerfile`'s real build path is deterministic (no live-registry re-resolution), a regeneration path exists and is documented, a drift guard test exists, and a Railway deploy-status check exists (skipping gracefully until its secrets are configured) plus its own unit tests.

## Commit Schedule

1. Plan commit: `docs: add plan for openclaw-build-determinism` (after plan approval)
2. ACs commit: `docs: add ACs for openclaw-build-determinism`
3. `build: extract extension-version relaxation into a shared script` (D1)
4. `build: commit a resolved OpenClaw lockfile, switch to frozen-lockfile installs` (D2, D3, D4)
5. `test: guard the committed lockfile against an unregenerated OPENCLAW_GIT_REF bump` (D5)
6. `feat(ci): verify the triggered Railway deployment actually succeeds` (D6, D7, D8)
7. Verification: `chore: update verification status` (after all ACs pass)

## Dependencies

- **D7 needs new repo secrets before it's live**: `gh secret list` currently shows none configured. D6/D7 are designed to skip gracefully (not fail) until `RAILWAY_TOKEN`, `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID` are added as repo secrets — this plan does not provision them (requires the repo owner's own Railway token). Flagged in the PR description as a manual follow-up.
- Requires a local Docker daemon to build/verify D2's `openclaw-lockfile-refresh` stage and to generate D3's initial committed lockfile (same requirement `verify:decision-runtime`-style Docker verification already has elsewhere in this ecosystem).

## Out of Scope

- Rebuilding the deleted `Railway Proof Verify` workflow's old checks (per decision S-6, it tested nothing useful — D7 is a deliberately different, narrower check: did *this* commit's deployment reach `SUCCESS`).
- Bumping `OPENCLAW_GIT_REF`/`OPENCLAW_TEMPLATE_REF` itself.
- Any supply-chain policy other than `minimumReleaseAge` (the committed-lockfile fix is general — it removes live-registry re-resolution entirely, so it structurally covers any such policy, but this plan doesn't audit for others).
- Retrying/backing off *within* a single failed Railway build (D7 only detects and reports after the fact; it does not change Railway's own build/retry behavior).
