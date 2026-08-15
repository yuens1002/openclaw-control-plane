# Setup Run Payload Contract Acceptance Criteria

**Branch:** `fix/setup-run-payload-contract`
**Plan:** `docs/plans/setup-run-payload-contract/plan.md`

## Context

Live confirmation (see plan.md) found the applier's `/setup/api/run`
payload doesn't match the real contract: it sends an array-shaped
`channels` field and an unused `authGroup` field, where the real endpoint
expects a flat object with fixed `telegramToken`/`discordToken`/
`slackBotToken`/`slackAppToken` fields and no `authGroup` at all. This fix
corrects both the real apply path and the dry-run preview (which
duplicated the same wrong shape independently). Single session, D1-D7.

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
| AC-COV-001 | D5 | `/project-manager` | Plan exists | Code review: `docs/plans/setup-run-payload-contract/plan.md` | Plan names branch, source, live-confirmation evidence, approach/design decisions, deliverables with roles, files to create/edit, gate 1/2 pre-check, commit schedule, dependencies, out of scope | PASS - all sections present, incl. Live Confirmation with raw evidence. | CONFIRMED - independently re-read the raw evidence files (app.js, auth-groups.json, status.json) against the plan's prose during Phase 3; no discrepancy found. | PENDING |
| AC-COV-002 | D6 | `/project-manager` | ACs table exists | Code review: `docs/plans/setup-run-payload-contract/ACs.md` | Every AC row has a valid Plan ref (a D1-D7 ID, or `—` for a whole-suite check per the Column Definitions convention) and Role, plus Agent/QC/Reviewer columns | PASS, WITH A WORDING FIX - Pass cell originally said "Every AC row has a valid Plan ref (D1-D7)" without acknowledging the `—` convention used by AC-TST-002/AC-REG-001/AC-REG-002, which was flagged as doc-drift against the column's own stated rule. | CONFIRMED-WITH-FIX - reworded the Pass cell to state the `—` convention explicitly; no structural gap, wording only. | PENDING |
| AC-COV-003 | D7 | `/project-manager` | Review scaffold exists | Code review: `docs/plans/setup-run-payload-contract/review.md` | Review doc has sections for verdict, deliverables↔code, ACs↔tests, docs drift, recommendations | FAIL - `review.md` did not exist at verification time (expected sequencing, D7 is authored after Phase 3/4). | CONFIRMED-WITH-FIX - `review.md` authored immediately after this QC pass, in the same session; see that file. | PENDING |
| AC-COV-004 | D4 | `/backend-architect` | Docs/comments reflect the confirmed contract | Code review: `apply-profile.ts`, `setup-api-client.ts`, `docs/setup-profile-applier.md`, `docs/plans/setup-profile-applier/plan.md` | No file still says the channel payload shape or `authGroup` enum is "not independently confirmed" — `docs/setup-profile-applier.md`'s caveat paragraph and the original plan's Dependencies/Out-of-Scope bullets are marked resolved, pointing at this plan | PASS, WITH ONE STALE COMMENT FOUND - `setup-api-client.ts`'s header comment was updated correctly, but a second comment on `run()` still listed `authGroup` as part of the payload's "exact field set" — factually wrong now, and a real risk (a future editor could read it and re-add `authGroup` to the payload). The plan's Files-to-Edit note ("header comment only") missed this second comment. | CONFIRMED-WITH-FIX - updated the `run()` comment to state the confirmed field set correctly and explicitly note `authGroup` is deliberately excluded. | PENDING |

## Functional Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-001 | D1 | `/backend-architect` | Single-channel flat payload | Test run: `tests/openclaw-setup-applier-apply-profile.test.ts` | Given a profile with one `telegram` channel attachment, the `POST /setup/api/run` payload has a top-level `telegramToken` field with the resolved secret value, no `channels` key anywhere in the payload, and no `authGroup` key anywhere in the payload | PASS - test asserts the exact parsed body object and explicitly asserts `.not.toHaveProperty("authGroup"/"channels")`. | CONFIRMED - code review matches (`apply-profile.ts` payload spread is genuinely flat, no nesting). | PENDING |
| AC-FN-002 | D1 | `/backend-architect` | Multi-channel single-call payload | Test run: same file, using the new `multi-channel.json` fixture (D2) | Given a profile with `telegram` + `slack` channel attachments, one `POST /setup/api/run` call carries `telegramToken`, `slackBotToken`, and `slackAppToken` simultaneously — not multiple calls, not an array | PASS - test asserts exactly 1 `run` request and all three fields present together. | CONFIRMED - matches. | PENDING |
| AC-FN-003 | D1 | `/backend-architect` | Dry-run preview matches the real shape | Test run: same file, `dryRunApplyProfile` path | The dry-run payload preview's channel representation uses the same flat-field mapping as the real apply path (via the shared `mapChannelsToPayloadFields` helper), not the old `channels: [{channelType, tokens}]` array shape | PASS on substance, but the plan/ACs text named the helper `buildChannelPayloadFields` while the actual implemented function is `mapChannelsToPayloadFields` — a real name mismatch, not just this AC's wording. | CONFIRMED-WITH-FIX - renamed every plan.md/ACs.md reference to the actual implemented name (`mapChannelsToPayloadFields`) rather than renaming working, tested code to match stale prose. | PENDING |
| AC-FN-004 | D1 | `/backend-architect` | Unsupported channel type fails loud | Test run: same file | A channel attachment with `type` outside `{telegram, discord, slack}` throws before `setupApiClient.run` is ever called | PASS - test asserts throw with the exact message and `callOrder` never contains `"run"`. | CONFIRMED - matches. | PENDING |
| AC-FN-005 | D1 | `/backend-architect` | Duplicate channel type fails loud | Test run: same file | Two channel attachments both with `type: "telegram"` throws before `setupApiClient.run` is ever called (the flat payload has only one `telegramToken` slot) | PASS - matches. | CONFIRMED - matches. | PENDING |
| AC-FN-006 | D1 | `/backend-architect` | Malformed Slack attachment fails loud | Test run: same file | A `slack` channel attachment with `requiredSecretNames.length !== 2` throws before `setupApiClient.run` is ever called | PASS - matches. | CONFIRMED - matches. | PENDING |
| AC-FN-007 | D1 | `/backend-architect` | Dry-run also fails loud on structurally invalid channels | Test run: same file, `dryRunApplyProfile` path | Given a profile with an unsupported channel type, `dryRunApplyProfile` throws the same error `applyProfile` would — deliberate: dry-run exists to sanity-check a profile *before* a live apply, so silently previewing a profile that would fail live defeats that purpose. This is a behavior change from pre-fix (dry-run previously never validated channel shape) and is called out explicitly here rather than shipped as an unstated side effect of sharing `mapChannelsToPayloadFields` with the apply path | N/A at first pass - Phase 3 verification correctly flagged this behavior change as real but *uncovered by any AC* at that time; this row + its test were added during QC in direct response. | CONFIRMED - new test added (`"also fails loud on a structurally invalid channel..."`), asserts `dryRunApplyProfile` throws the same message; `docs/setup-profile-applier.md` and `plan.md` both updated to state this is intended, not incidental. | PENDING |

## Test Coverage Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-TST-001 | D2, D3 | `/test-engineer` | New/extended test file passes | Test run: `npm test -- --run tests/openclaw-setup-applier-apply-profile.test.ts` | File passes, 0 failures, including every new flat-payload, multi-channel, and fail-loud case | PASS - 1 file, 20 tests, 0 failures. | CONFIRMED - re-ran after QC fixes (added AC-FN-007's test): 21 tests, 0 failures. | PENDING |
| AC-TST-002 | — | `/test-engineer` | Full project verification | Test runs: `npm run typecheck`, `npm test`, `npm run build` | All three complete with 0 failures | PASS - typecheck 0 errors, 91/91 tests, build clean. | CONFIRMED - re-ran after all QC fixes: typecheck clean, 14 files/92 tests/0 failures, build clean. | PENDING |

## Regression Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-REG-001 | — | `/test-engineer` | All existing tests pass | Test run: `npm test` | Full suite passes with the new/extended test files included, 0 failures | PASS - 91/91. | CONFIRMED - re-ran post-fix, 92/92 (new AC-FN-007 test included). | PENDING |
| AC-REG-002 | — | `/devops` | Dependency audit stays clean | Test run: `npm audit --omit=dev` | 0 vulnerabilities; no new dependency added | PASS - 0 vulnerabilities; `git diff main --stat` confirms no package.json/lockfile change. | CONFIRMED - unchanged. | PENDING |
