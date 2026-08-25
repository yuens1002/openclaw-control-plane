# Onboarding Regression Pipeline Plan

## Cadence

Full cadence (docs convention only — this repo has not opted into the
hook-enforced `verification-status.json` state machine, so gates below are
run and recorded manually rather than blocked mechanically). Follows
`docs/plans/post-deploy-readiness/` as the structural precedent.

## Goal

Turn the now-automated client-onboarding chain (#16's `provisionClientInstance`
+ the applier's `applyProfile`) into a **reusable, schedulable regression
pipeline** that proves the chain still works over time, without leaving any
standing OpenRouter spend liability between runs. The requirement originated
in a private consumer's live onboarding exercise against a dedicated fixture;
this public plan captures only the reusable pipeline contract.

## Background (confirmed this session, not assumed)

- **`applyProfile` is a one-time bootstrap action, not something a recurring
  job can just re-call.** It returns `"already-configured"` immediately once
  `/setup/api/status` reports configured, and `resolveProviderSecret` only
  mints a key when the secret name is **absent** from Railway variables — it
  never re-mints on a rerun. A recurring regression check therefore needs
  its own explicit mint → verify → delete cycle, independent of `applyProfile`.
- **OpenRouter's Provisioning API** (`openrouter.ai/docs/features/provisioning-api-keys`):
  `POST /api/v1/keys` returns the secret key value alongside a `hash`
  (needed to manage the key afterward); `DELETE /api/v1/keys/{hash}` deletes
  it outright. `openrouter-provisioning.ts`'s current `mintOpenRouterKey`
  only reads `key` from the response and discards everything else — no hash
  is captured today, so nothing minted through it can be deleted later.
  **The exact field path for `hash` on a real response is confirmed by this
  plan's own live bootstrap run** (Phase 2 below), not guessed from docs
  alone — code is written defensively (throws a clear error if the expected
  field is missing) so a live-shape surprise fails loud instead of silently
  losing the hash.
- **No Railway project-delete capability exists anywhere in this toolchain.**
  The fixture Railway project is therefore a standing, reused target — only
  the OpenRouter key has a per-run lifecycle (mint → use → delete).

## Design

New module `packages/openclaw-setup-applier/src/onboarding-cycle.ts`
(pure logic, dependency-injected like every other module in this package)
plus a thin CLI entrypoint `onboarding-cycle-cli.ts` (matching the existing
`cli.ts`/`client-cli.ts` split between logic and process wiring).

1. **`bootstrapOnboardingCycle`**: calls `provisionClientInstance` (reuses
   the existing idempotent-rerun behavior — if the fixture project/service
   already exists and is healthy, it's reused, not recreated), then
   `dryRunApplyProfile`, then `applyProfile` against the provisioned
   service/URL. Returns the provision result plus `applyProfile`'s result,
   including a new `mintedKeyHash?: string` field (see D1) so the caller can
   delete that key once its human-supervised verification step is done.
   Deliberately does **not** delete the key itself — the whole point of
   leaving `bootstrap` distinct from teardown is that the freshly-applied
   instance needs a *live* key for a human to verify against (a Chrome
   dashboard chat proof, in the originating session's plan).
2. **`runRegressionCheck`**: mints a **fresh** OpenRouter key scoped to the
   profile's declared model-provider secret name, writes it to that Railway
   variable, then in a `try`/`finally`: (try) polls `/setup/api/status` for
   `configured: true` and `/setup/healthz` for 200; (finally) **deletes the
   minted key unconditionally**, whether the try block passed, failed, or
   threw. The function's return value reports pass/fail from the try block;
   deletion is never conditional on that outcome. No browser/Chrome
   involvement — this is the subcommand a recurring schedule calls
   unattended.
3. **`deleteOpenRouterKey(hash, managementKey)`** (D1, in
   `openrouter-provisioning.ts`): standalone `DELETE /api/v1/keys/{hash}`
   call, same never-log-the-secret discipline as `mintOpenRouterKey`. Used
   directly by both `runRegressionCheck`'s `finally` block and by the CLI's
   standalone `delete-key` subcommand (for the one-off "delete after today's
   live proof" step the originating session's plan calls for).

## Deliverables

| ID | Deliverable | Kind | Owning role | Notes |
| --- | --- | --- | --- | --- |
| D1 | Plan and ACs docs | docs | project-manager | This document + `ACs.md`. |
| D2 | Key hash capture + delete | script | devops | `mintOpenRouterKey` returns `{key, hash}`; new `deleteOpenRouterKey`. `apply-profile.ts`'s `resolveProviderSecret`/`applyProfile` thread `mintedKeyHash` through `ApplyResult` when a mint occurred. |
| D3 | `onboarding-cycle.ts` — `bootstrapOnboardingCycle` + `runRegressionCheck` | script | devops | Composed logic described above; DI-based, no live calls in its own tests. |
| D4 | `onboarding-cycle-cli.ts` | script | devops | `bootstrap`, `regression-check`, `delete-key` subcommands, matching `cli.ts`'s arg-parsing/env-var conventions (`OPENROUTER_MANAGEMENT_KEY`, `OPENCLAW_INSTANCE_SETUP_PASSWORD`/`_USERNAME`). |
| D5 | Mocked tests | tests | test-engineer | Cover D2 (hash capture, delete call shape), D3's guaranteed-delete-on-failure behavior (a test that makes the status check throw and asserts delete was still called exactly once), and `bootstrapOnboardingCycle`'s step ordering. |
| D6 | Docs update | docs | project-manager | README/deploy docs: document the new CLI, and state plainly that between scheduled runs the fixture's model-provider secret holds a dead/deleted key value until the next run overwrites it — an accepted tradeoff of delete-every-run, not a bug. |

## Commit Schedule

1. `docs: add plan and ACs for onboarding-regression-pipeline`
2. `feat(setup-applier): capture OpenRouter key hash and support deletion`
3. `feat(setup-applier): add onboarding-cycle bootstrap/regression-check pipeline`
4. `feat(setup-applier): add onboarding-cycle CLI`
5. `test(setup-applier): cover key-lifecycle and onboarding-cycle behavior`
6. `docs: document onboarding-cycle CLI and dead-key-between-runs tradeoff`

## Non-Goals

- No Railway project deletion/teardown automation — no such capability
  exists in this toolchain today; out of scope to build here.
- No Chrome/browser verification inside this pipeline — that stays a
  human-supervised step in the originating session, not something
  `regression-check` does unattended.
- No re-enable/disable toggle for OpenRouter keys — superseded by the
  simpler delete-every-run design (confirmed with the user); no standing key
  ever exists between runs to toggle.
- No change to `applyProfile`'s existing idempotency semantics
  (`already-configured` short-circuit, mint-only-if-absent) — this plan adds
  a return field, it doesn't change when minting happens during `apply`.
- No scheduling mechanism built here — wiring an actual recurring trigger
  (cron/`/schedule`) against `regression-check` is the originating session's
  own step, using this CLI as a black box.
