# /review report — setup-run-payload-contract

**Branch:** `fix/setup-run-payload-contract`
**Generated:** 2026-08-15
**Iterations to reach verified:** 2 (Phase 3 sub-agent independently re-read the raw live evidence and found two real doc/comment gaps plus one uncovered behavior change, all fixed and re-verified before this report)

## Verdict

**Clear.** All 13 ACs pass (12 CONFIRMED, 1 CONFIRMED-WITH-FIX now that `review.md` — this file — exists). This upgrades issue #9 from "verify an assumption" to "fix a confirmed defect": the applier's `/setup/api/run` payload did not match the real live contract before this fix. Live confirmation came entirely from read-only `GET`s and the wizard's own client source (`app.js`) — no mutating call was ever made, and the Phase 3 sub-agent independently re-read the raw evidence files (not just this plan's summary of them) and found no discrepancy.

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|---|---|---|
| D1 | `packages/openclaw-setup-applier/src/apply-profile.ts` — `mapChannelsToPayloadFields`, real apply path, dry-run preview, `authGroup` dropped | ✓ shipped |
| D2 | `fixtures/setup-profile/slack-channel.json`, `multi-channel.json` | ✓ shipped |
| D3 | `tests/openclaw-setup-applier-apply-profile.test.ts` | ✓ shipped |
| D4 | `apply-profile.ts` + `setup-api-client.ts` comments, `docs/setup-profile-applier.md`, `docs/plans/setup-profile-applier/plan.md` | ✓ shipped |
| D5 | `docs/plans/setup-run-payload-contract/plan.md` | ✓ shipped |
| D6 | `docs/plans/setup-run-payload-contract/ACs.md` | ✓ shipped |
| D7 | `docs/plans/setup-run-payload-contract/review.md` (this file) | ✓ shipped |

### Code changes not tied to any deliverable
None — `git diff main --stat` shows exactly 7 modified files + 2 new fixtures, matching the plan's Files-to-Create/Edit list precisely (confirmed independently by the Phase 3 sub-agent's own `git diff` check).

## ACs ↔ Tests (Gate 3 spot-check, holistic)

| AC | Test file | Asserts invariant? | Notes |
|----|-----------|---------------------|-------|
| AC-FN-001 | `apply-profile.test.ts` "sends a flat payload for a single channel..." | ✓ | Asserts the exact parsed body object *and* explicit `.not.toHaveProperty` for both removed fields — catches both "wrong shape" and "extra field survived" failure modes in one test. |
| AC-FN-002 | same file, "sets multiple channels' fields in a single..." | ✓ | Asserts request count (1, not N) as well as field presence — a weaker test could pass with N separate calls each carrying one field. |
| AC-FN-007 | same file, "also fails loud on a structurally invalid channel..." | ✓ (added during QC) | This AC and its test didn't exist until Phase 3 flagged the dry-run-now-throws behavior as real-but-uncovered. Added specifically to close that gap rather than leave it as an unstated side effect of sharing `mapChannelsToPayloadFields`. |

## Docs drift

**Found and fixed during this pass:**

- `setup-api-client.ts`'s comment on `run()` still listed `authGroup` as part of the payload's field set — stale and actively wrong post-fix, a real risk (a future editor could read it and reintroduce the bug this plan fixes). The plan's Files-to-Edit note said "header comment only" for this file, which is why the second comment was missed on first pass; fixed during QC after Phase 3 flagged it.
- `plan.md`/`ACs.md` named the new helper `buildChannelPayloadFields`; the actually-implemented function is `mapChannelsToPayloadFields`. Fixed by updating the docs to match the shipped code, not the reverse (renaming tested, working code to match stale prose would have been the wrong direction of fix).

**No other drift found.** `docs/plans/setup-profile-applier/plan.md`'s Dependencies/Out-of-Scope bullets are correctly struck through and marked Resolved, pointing here. `docs/setup-profile-applier.md`'s channel-type list, payload-shape description, and dry-run behavior note are all now accurate and consistent with the shipped code.

## Behavior change surfaced and closed (not docs drift — a real design decision)

Because `mapChannelsToPayloadFields` is shared between the real apply path and the dry-run preview, `dryRunApplyProfile` now throws on the same structurally-invalid profiles (unsupported channel type, duplicate type, malformed Slack attachment) that `applyProfile` rejects — pre-fix, dry-run never validated channel shape at all. Phase 3 verification correctly identified this as a real, uncovered behavior change rather than an AC failure. Decision: **this is correct, not a regression** — dry-run's own stated purpose is to sanity-check a profile before a live apply, and silently previewing a profile that would fail live defeats that purpose. Made explicit via a new AC (AC-FN-007), a new test, and doc notes in both `plan.md` and `docs/setup-profile-applier.md`, rather than shipped as an unstated side effect.

## Recommendations

1. None blocking — all three Phase 3 findings (stale `authGroup` comment, helper name mismatch, uncovered dry-run behavior change) were fixed and re-verified in this same pass.
2. Optional, non-blocking, explicitly out of scope: the Slack bot/app-token positional ordering (`requiredSecretNames[0]` = bot, `[1]` = app) is an assumption from issue #7's example text, not independently live-confirmed (no real Slack-bearing profile was available to check). Worth confirming if a real client profile with a Slack attachment ever becomes available to inspect.

## Inputs for /retro

- **Route:** `/backend-architect` → `~/.claude/commands/backend-architect.md`
  **Draft principle:** *"When a plan's Files-to-Edit table scopes a file to a specific reason ('header comment only', 'config only'), grep that file for every occurrence of the concept being corrected before finalizing the deliverable — not just the one location the scoping note names. A file can have the same stale claim in more than one comment, and a Files-to-Edit note that names a reason narrows attention to exactly the spot most likely to miss a sibling."*
  **Triggered by:** `setup-api-client.ts`'s `run()` comment independently repeated the stale `authGroup`-is-part-of-the-payload claim that the file's header comment (correctly updated) also used to make. The plan's own Files-to-Edit note — "header comment only" — was itself the reason the second comment wasn't checked; the scoping note that should have prevented missed work instead narrowed the search to exactly the wrong single spot.

- **Route:** `/project-manager` → `~/.claude/commands/project-manager.md`
  **Draft principle:** *"When a plan names a new function by a specific identifier ('gets one new function, `X`'), grep the actual implementation for that exact name before Phase 3 verification, not just at authoring time — a name chosen during planning can legitimately change during implementation (a better name occurs to the implementer, or the first name doesn't fit once the code exists), and nothing currently re-checks the plan's prose against the shipped symbol name once implementation is done."*
  **Triggered by:** this plan's Approach section named the new helper `buildChannelPayloadFields`; the actually-implemented function is `mapChannelsToPayloadFields` — a better name in retrospect (it maps channels to fields; it doesn't build a payload), chosen during implementation without the plan being updated to match. Caught only because the Phase 3 sub-agent was instructed to independently verify against the real code rather than trust the plan's prose.
