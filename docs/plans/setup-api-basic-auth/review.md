# /review report — setup-api-basic-auth

**Branch:** `feat/setup-api-basic-auth`
**Generated:** 2026-08-15
**Iterations to reach verified:** 2 (Phase 3 sub-agent verification surfaced two real gaps, both fixed and re-verified in QC before this report)

## Verdict

**Clear.** All 12 ACs pass (11 CONFIRMED, 1 CONFIRMED-WITH-FIX now that `review.md` — this file — exists). Two genuine defects found by the Phase 3 sub-agent were fixed during QC: a docs-drift bug (an unauthenticated code sample contradicting the just-updated env-var table) and an inaccurate plan.md claim about `apply-profile.ts`'s HTTP surface. Ready for human review.

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|---|---|---|
| D1 | `packages/openclaw-setup-applier/src/setup-api-client.ts:8-17,36-38,41,53` | ✓ shipped |
| D2 | `packages/openclaw-setup-applier/src/cli.ts:42-56,100-106` | ✓ shipped |
| D3 | `tests/openclaw-setup-applier-setup-api-client.test.ts:100-160` | ✓ shipped |
| D4 | `tests/openclaw-setup-applier-cli.test.ts:47-71` | ✓ shipped |
| D5 | `docs/setup-profile-applier.md:61-74,98-112` | ✓ shipped |
| D6 | `.env.example:3-11` | ✓ shipped |
| D7 | `docs/plans/setup-api-basic-auth/plan.md` | ✓ shipped |
| D8 | `docs/plans/setup-api-basic-auth/ACs.md` | ✓ shipped |
| D9 | `docs/plans/setup-api-basic-auth/review.md` (this file) | ✓ shipped |

### Code changes not tied to any deliverable
None — `git diff main --stat` shows exactly the 8 files the plan named (2 source, 2 test, 2 doc, 2 plan-artifact), no extras.

## ACs ↔ Tests (Gate 3 spot-check, holistic)

| AC | Test file | Asserts invariant? | Notes |
|----|-----------|---------------------|-------|
| AC-FN-001 | `tests/openclaw-setup-applier-setup-api-client.test.ts:100-124` | ✓ | Decodes the `Authorization` header back to `"username:password"` per call, across all four methods — a genuine relation, not a literal pin. |
| AC-FN-002 | same file, `:126-144` | ✓ (after fix) | Originally exercised only 2 of the 4 methods the Pass cell named; extended during QC to call all four, closing the Pass-cell/test gap the Phase 3 agent flagged. |
| AC-FN-003 | `tests/openclaw-setup-applier-cli.test.ts:47-71` | ✓ | Uses an arbitrary env var name distinct from both real call sites (`OPENROUTER_MANAGEMENT_KEY`, `OPENCLAW_INSTANCE_SETUP_PASSWORD`), proving `requireEnv`'s general behavior rather than one hardcoded path. |
| AC-SEC-001 | `tests/openclaw-setup-applier-setup-api-client.test.ts:145-158` | ✓ (structural) | Passes by construction — `SetupApiError`'s constructor only ever takes `(method, path, status)`, so it cannot embed a credential. Still a legitimate regression guard against a future refactor that starts interpolating request details into the error; noted so its strength isn't overstated. |

## Docs drift

**Found and fixed during this pass** (not a pre-existing gap — introduced by this feature's own D5, then caught before merge):

- `docs/setup-profile-applier.md`'s "Apply usage" code sample (~40 lines below the newly-added "Required env vars" table) still built `createSetupApiClient({ baseUrl: ... })` with no `auth` field — directly contradicting the table above it, which now states `OPENCLAW_INSTANCE_SETUP_PASSWORD` is required for the apply path. An operator copy-pasting the old sample would build an unauthenticated client and hit the exact 401 issue #12 exists to fix. Fixed to show the required `auth` field sourced from the new env vars.

**No other drift found.** Checked `README.md`, `docs/architecture.md`, `CHANGELOG.md` (post-merge) for any claim this feature invalidates — `README.md:68`'s `SETUP_PASSWORD` description is about `apps/api`'s own, unrelated gate and remains accurate.

## Plan accuracy (found during Phase 3, corrected during QC)

`plan.md`'s original Current State claimed `apply-profile.ts` "never constructs its own HTTP requests." Not quite true: `waitForHealthy` (`apply-profile.ts:308-321`) makes a direct `fetchImpl` call to `/setup/healthz`, bypassing `setupApiClient` and the new `auth` header entirely. This doesn't change the fix's scope — `/setup/healthz` is unauthenticated by design, corroborated by `verify-proof.ts`'s own check split (`setupHealth` must be strictly `200`; `/setup`/`/openclaw` tolerate `401`) and by `railway.toml`'s `healthcheckPath` requiring an infra healthcheck to work unauthenticated — but the plan's stated reasoning was imprecise. Corrected in `plan.md`'s Current State and Design Decisions sections to state the exception explicitly rather than imply no exception exists.

## Recommendations

1. None blocking. Both findings from Phase 3 verification (docs sample, plan.md premise) were fixed and re-verified in the same pass.
2. Optional, non-blocking, explicitly out of this fix's scope: `requireEnv`'s `=== undefined` check (not a falsy check) means an empty-string `OPENCLAW_INSTANCE_SETUP_PASSWORD` passes the pre-flight gate and only fails on a live 401 round-trip, losing the "fail loud before any network call" property for that one edge case. Confirmed via diff this is pre-existing behavior (the old inline `OPENROUTER_MANAGEMENT_KEY` check had the same `=== undefined` gate), not a regression introduced here — and `apps/api`'s equivalent gate (`apps/api/src/index.ts:167`) already uses a *different*, falsy-based convention, so fixing one wouldn't even make the two consistent. Worth a small follow-up if the team wants both hardened together, not part of this fix.

## Inputs for /retro

- **Route:** `/backend-architect` → `~/.claude/commands/backend-architect.md`
  **Draft principle:** *"When a plan states 'module X never does <side-effect> — every call routes through <injected dependency>' as justification for a change's scope being sufficient, grep the module for the actual side-effect (e.g. every direct `fetch`/`fetchImpl` call site), not just the call sites through the dependency being modified. A module can have a mix of dependency-injected calls (covered by the change) and other direct calls the plan's own scoping language implicitly claims don't exist."*
  **Triggered by:** this plan's original "apply-profile.ts never constructs its own HTTP requests" claim was true for `/setup/api/*` calls (all through `setupApiClient`) but false for `/setup/healthz` (a direct `fetchImpl` call in `waitForHealthy`). The conclusion (D1+D2 sufficient) was still correct — `/setup/healthz` is unauthenticated by design — but the stated reasoning for that conclusion was inaccurate until caught by the Phase 3 sub-agent's independent code read, not by the plan's own authoring-time check.

- **Route:** `/test-engineer` → `~/.claude/commands/test-engineer.md`
  **Draft principle:** *"When an AC's Pass cell enumerates N specific call sites/methods a test must exercise (e.g. 'all four calls'), the authoring-time test should be checked against that literal count before marking the AC ready for verification — not left for the Phase 3 sub-agent to catch a 2-of-4 gap after the fact."*
  **Triggered by:** AC-FN-002's Pass cell said "none of the four calls" but the first-draft test exercised only two (`getStatus`, `run`). The gap didn't invalidate the AC (the implementation shares one `authHeaders` const across all four methods, so two calls did prove the property), but it's exactly the kind of Pass-cell/test mismatch Gate 3 exists to catch, and doing the count-check at authoring time would have caught it a step earlier than Phase 3 verification did.
