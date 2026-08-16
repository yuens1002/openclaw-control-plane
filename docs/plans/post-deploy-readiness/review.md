# /review report — post-deploy-readiness

**Branch:** `fix/18-post-deploy-readiness`
**Generated:** 2026-08-16
**Iterations to reach verified:** 1 (Phase 3 verification found 2 real gaps — dead `healthCheck` code, untested wiring — both fixed in one QC pass before this report; no re-verification loop was needed beyond that)

## Verdict

**Clear.** All 9 ACs pass with real evidence (not vacuous), both manual gates hold, the full suite (18 files / 104 tests) and typecheck are green, and no deliverable/code orphans or docs drift were found. Ready for human review.

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|-------------|----------------|--------|
| D1 | `docs/plans/post-deploy-readiness/{plan.md,ACs.md}` | ✓ shipped |
| D2 | `packages/openclaw-railway-installer/src/index.ts:83,219-224,365-373`, `src/setup-auth.ts` | ✓ shipped (improved beyond original plan — old `healthCheck` removed as dead code, see Recommendations) |
| D3 | `packages/openclaw-railway-installer/src/patch-allowed-origins.ts` | ✓ shipped |
| D4 | `packages/openclaw-railway-installer/src/approve-own-device.ts` | ✓ shipped |
| D5 | `packages/openclaw-railway-installer/src/index.ts:230-243` (call order + `InstallResult` fields), `package.json` exports, `tsconfig.base.json` paths | ✓ shipped |
| D6 | `tests/openclaw-railway-{installer,installer-readiness,patch-allowed-origins,approve-own-device,setup-auth}.test.ts` | ✓ shipped (plus one test beyond plan scope: `basicAuthHeader` direct coverage, added during QC — justified, see below) |
| D7 | `deploy/openclaw-railway/README.md:15-38` | ✓ shipped |

### Code changes not tied to any deliverable

None. `package.json`/`tsconfig.base.json` changes are glue required for D3/D4 to be importable as their own package subpaths (matching this package's existing per-file export convention) — not independently scoped work, and covered by D5.

## ACs ↔ Tests (Gate 3 spot-check)

Spot-checked all 9 rows (small enough table to do fully, not sample):

| AC | Test file | Asserts invariant? | Notes |
|----|-----------|---------------------|-------|
| AC-READY-001 | `openclaw-railway-installer-readiness.test.ts` | ✓ | Asserts the actual URL (`/setup/api/status`) and auth object equality — not a literal response-code pin. |
| AC-READY-002 | (structural — TS excess-property-checking) | ✓ | Removing `healthCheck?` from the type is itself the proof a caller can no longer wire it; confirmed no residual references anywhere in the tree (`grep healthCheck` clean except the removed lines' git history). |
| AC-CORS-001 | `openclaw-railway-patch-allowed-origins.test.ts` | ✓ | Asserts `postCalls === 0`, not just that `patched === false` — the stronger claim (no network call at all). |
| AC-CORS-002 | same file | ✓ | Asserts `written.agents.defaults.model` (an unrelated sibling field) survives, plus origin array order — genuinely checks preservation, not just "still valid JSON." |
| AC-PAIR-001 | `openclaw-railway-approve-own-device.test.ts` | ✓ | Zero/one cases both assert call counts, not just return values. |
| AC-PAIR-002 | same file | ✓ | Asserts the throw message *and* zero approve calls — catches a "throws but still calls approve" bug the message-only check would miss. |
| AC-WIRE-001 | `openclaw-railway-installer-readiness.test.ts` (second `describe` block) | ✓ | Added during QC after Phase 3 flagged it was previously unverified by any test — now asserts literal call order via a marker array and both `InstallResult` field states (patched+approved vs. neither). |
| AC-TEST-001 | (meta — covers the rows above) | ✓ | No brittle-literal trap found in any named test: assertions check call presence/absence, object equality, and content preservation, never a hardcoded value that also lives in the producer. |
| AC-DOCS-001 | (docs, no test) | n/a | Verified by direct read of `deploy/openclaw-railway/README.md`. |

No `WEAK` or `MISSING` verdicts.

## Docs drift

None found. Checked `README.md`, `deploy/openclaw-railway/README.md`, and `docs/{architecture,openclaw-tools,setup-profile-applier}.md` for any claim this feature could invalidate. The remaining `/setup/healthz` references in both READMEs (`README.md:25,123`; `deploy/openclaw-railway/README.md:65,109,180`) are **not** stale — they describe the wrapper's liveness/proof-check contract (`railway-proof:verify`, `verify-proof.ts`), a separate concern from which endpoint the *installer* uses as its readiness gate. `/setup/healthz` still exists and is still correctly documented there; this feature only stopped using it as the installer's success condition, which is exactly what `deploy/openclaw-railway/README.md:24-26` (D7) now explains.

## Recommendations

1. None blocking. The one design deviation from the original plan (removing `healthCheck` instead of leaving it "untouched" per the original AC-READY-002 wording) was caught by Phase 3, fixed, and the AC's own wording was corrected in the same commit to describe the shipped behavior — already closed, not a follow-up.
2. Non-blocking, for whoever merges #16 (`feat/client-template-pinning`) after this branch: `provision-client.ts` will land with its own separate `/setup/healthz`-based readiness call (per that branch's own plan). Once merged, that call site should switch to the same `checkSetupStatus` pattern this feature establishes, for the same reason (issue #18 item 3) — noted in this feature's plan.md Non-Goals already, restated here so `/retro` can route it if useful.

## Inputs for /retro

- **Route:** `/devops` → `.claude/commands/devops.md`
  **Draft principle:** *"When a code change replaces the only call site of an existing injectable dependency (e.g. swapping `healthCheck` for `checkSetupStatus`), remove the now-orphaned dependency and its injection point in the same change — don't leave it wired into the public interface but silently unused. An unused-but-present optional dependency is a footgun: a caller providing it reasonably expects it still does something, and TypeScript's excess-property-checking will catch every call site that needs updating for free once the field is actually removed, so there's no discovery cost to doing this immediately rather than deferring it."*
  **Triggered by:** AC-READY-002 — Phase 3 found `healthCheck()`/`dependencies.healthCheck?` left as dead code after the readiness call site moved to `checkSetupStatus`.

- **Route:** `/project-manager` → `.claude/commands/project-manager.md`
  **Draft principle:** *"When planning a deliverable that swaps one mechanism for another (a new call site replacing an old one), the AC for 'don't repurpose the old mechanism' should say 'remove it if it becomes unused, don't leave it silently dead' rather than 'leave it untouched' — the latter reads as correct at planning time but produces a worse outcome (an inert, misleading dependency surface) once the swap actually lands."*
  **Triggered by:** AC-READY-002's original wording, authored before the consequence of "additive, not repurposing" was visible in the actual diff.

- **Route:** `/test-engineer` → `.claude/commands/test-engineer.md`
  **Draft principle:** *"When an AC's Pass invariant names a specific output value or call order an integration function produces (not just that a sub-step happened), write a test asserting that literal output/order — reading the call-graph at verification time is not sufficient evidence the wiring is correct if no test actually observes it."*
  **Triggered by:** AC-WIRE-001 — implementation wiring was correct on inspection but had zero test coverage of the actual `InstallResult` field values or step call order until Phase 3 flagged the gap.
