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
| AC-COV-001 | D5 | `/project-manager` | Plan exists | Code review: `docs/plans/setup-run-payload-contract/plan.md` | Plan names branch, source, live-confirmation evidence, approach/design decisions, deliverables with roles, files to create/edit, gate 1/2 pre-check, commit schedule, dependencies, out of scope | | | PENDING |
| AC-COV-002 | D6 | `/project-manager` | ACs table exists | Code review: `docs/plans/setup-run-payload-contract/ACs.md` | Every AC row has a valid Plan ref (D1-D7) and Role, plus Agent/QC/Reviewer columns | | | PENDING |
| AC-COV-003 | D7 | `/project-manager` | Review scaffold exists | Code review: `docs/plans/setup-run-payload-contract/review.md` | Review doc has sections for verdict, deliverables↔code, ACs↔tests, docs drift, recommendations | | | PENDING |
| AC-COV-004 | D4 | `/backend-architect` | Docs/comments reflect the confirmed contract | Code review: `apply-profile.ts`, `setup-api-client.ts`, `docs/setup-profile-applier.md`, `docs/plans/setup-profile-applier/plan.md` | No file still says the channel payload shape or `authGroup` enum is "not independently confirmed" — `docs/setup-profile-applier.md`'s caveat paragraph and the original plan's Dependencies/Out-of-Scope bullets are marked resolved, pointing at this plan | | | PENDING |

## Functional Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-001 | D1 | `/backend-architect` | Single-channel flat payload | Test run: `tests/openclaw-setup-applier-apply-profile.test.ts` | Given a profile with one `telegram` channel attachment, the `POST /setup/api/run` payload has a top-level `telegramToken` field with the resolved secret value, no `channels` key anywhere in the payload, and no `authGroup` key anywhere in the payload | | | PENDING |
| AC-FN-002 | D1 | `/backend-architect` | Multi-channel single-call payload | Test run: same file, using the new `multi-channel.json` fixture (D2) | Given a profile with `telegram` + `slack` channel attachments, one `POST /setup/api/run` call carries `telegramToken`, `slackBotToken`, and `slackAppToken` simultaneously — not multiple calls, not an array | | | PENDING |
| AC-FN-003 | D1 | `/backend-architect` | Dry-run preview matches the real shape | Test run: same file, `dryRunApplyProfile` path | The dry-run payload preview's channel representation uses the same flat-field mapping as the real apply path (via the shared `buildChannelPayloadFields` helper), not the old `channels: [{channelType, tokens}]` array shape | | | PENDING |
| AC-FN-004 | D1 | `/backend-architect` | Unsupported channel type fails loud | Test run: same file | A channel attachment with `type` outside `{telegram, discord, slack}` throws before `setupApiClient.run` is ever called | | | PENDING |
| AC-FN-005 | D1 | `/backend-architect` | Duplicate channel type fails loud | Test run: same file | Two channel attachments both with `type: "telegram"` throws before `setupApiClient.run` is ever called (the flat payload has only one `telegramToken` slot) | | | PENDING |
| AC-FN-006 | D1 | `/backend-architect` | Malformed Slack attachment fails loud | Test run: same file | A `slack` channel attachment with `requiredSecretNames.length !== 2` throws before `setupApiClient.run` is ever called | | | PENDING |

## Test Coverage Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-TST-001 | D2, D3 | `/test-engineer` | New/extended test file passes | Test run: `npm test -- --run tests/openclaw-setup-applier-apply-profile.test.ts` | File passes, 0 failures, including every new flat-payload, multi-channel, and fail-loud case | | | PENDING |
| AC-TST-002 | — | `/test-engineer` | Full project verification | Test runs: `npm run typecheck`, `npm test`, `npm run build` | All three complete with 0 failures | | | PENDING |

## Regression Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-REG-001 | — | `/test-engineer` | All existing tests pass | Test run: `npm test` | Full suite passes with the new/extended test files included, 0 failures | | | PENDING |
| AC-REG-002 | — | `/devops` | Dependency audit stays clean | Test run: `npm audit --omit=dev` | 0 vulnerabilities; no new dependency added | | | PENDING |
