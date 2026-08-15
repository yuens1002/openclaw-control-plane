# Setup Run Payload Contract Plan

Branch: `fix/setup-run-payload-contract`
Source: [GitHub issue #9](https://github.com/yuens1002/openclaw-control-plane/issues/9)
"Verify /setup API contract (auth-groups enum, multi-channel run payload)
against a live instance," filed 2026-08-15.

## Summary

Issue #9 asked to *confirm* two unverified assumptions from issue #7 against
a live instance. Confirmation happened this session (details below) and
found the applier's current `POST /setup/api/run` payload shape does not
match the real contract — this plan upgrades #9 from a verification task to
a **defect fix**: as shipped, `applyProfile()` against any channel-bearing
profile builds a payload the real endpoint doesn't accept.

## Live Confirmation (this session, 2026-08-15)

Fetched from the live proof instance (`https://openclaw-control-plane-production-db5d.up.railway.app`,
authenticated with credentials from this machine's own `.env.local`, per
issue #9's preferred no-mutation method — no `POST` was made):

- `GET /setup/api/auth-groups`
- `/setup/app.js` (the wizard's own client source — issue #7's original
  discovery method)
- `GET /setup/api/status` (cross-check; also returns the same `authGroups`
  plus the underlying CLI's `channels add --help` text)

**`authGroup` enum — confirmed.** Every slug issue #7 guessed is correct
**except `z.ai`, which is actually `zai`** (no dot). Full confirmed set:
`openai`, `anthropic`, `google`, `openrouter`, `ai-gateway`, `moonshot`,
`zai`, `minimax`, `qwen`, `copilot`, `synthetic`, `opencode-zen` — each with
its own `options[]` (e.g. `anthropic` → `claude-cli`/`token`/`apiKey`).
Also confirmed: **`authGroup` itself is never sent to `/setup/api/run`** —
only `authChoice` (one of the nested `options[].value`s). `authGroup` is
UI-grouping-only in the real wizard.

**Multi-channel payload shape — confirmed, and it doesn't match this
applier's current code.** `app.js:153-166` builds a **flat** object:

```js
{
  flow, authChoice, authSecret,
  telegramToken, discordToken, slackBotToken, slackAppToken,
  customProviderId, customProviderBaseUrl, customProviderApi,
  customProviderApiKeyEnv, customProviderModelId
}
```

No `channels` array exists. Multiple channels are set by filling multiple
of the four fixed slots (`telegramToken`/`discordToken`/`slackBotToken`/
`slackAppToken`) in **one** call — not an array of `{channelType, secrets}`
attachments, which is what `apply-profile.ts` currently builds
(`apply-profile.ts:101,190-191,224`, both the real apply path and the
dry-run preview). Slack genuinely needs two separate top-level fields,
confirming issue #7's "Slack needs two tokens" note.

`GET /setup/api/status`'s `channelsAddHelp` text independently confirms the
underlying CLI supports many more channel types (`telegram|whatsapp|
discord|irc|googlechat|slack|signal|imessage|...`) than the wizard's
`/setup/api/run` endpoint exposes — only telegram/discord/slack are
settable through this endpoint; anything else is out of this applier's
reach regardless (not a gap this plan needs to close).

## Approach

`apply-profile.ts` gets one new function, `mapChannelsToPayloadFields`, used
by **both** the real apply path and the dry-run preview (single source of
truth — the dry-run preview currently duplicates the array-shape logic
independently, which is exactly how the bug this plan fixes went
unnoticed in the preview too). It maps each channel attachment's `type` to
the real flat field(s):

- `"telegram"` → `telegramToken`
- `"discord"` → `discordToken`
- `"slack"` → `slackBotToken` (from `requiredSecretNames[0]`) +
  `slackAppToken` (from `requiredSecretNames[1]`) — positional order
  matching issue #7's own example ordering (`ACME_SLACK_BOT_TOKEN`,
  `ACME_SLACK_APP_TOKEN`), the only textual evidence this repo has for
  which secret is which; no live profile with a real slack attachment was
  available to confirm further.

Fails loudly (matching the existing `modelProviders.length > 1` pattern) on
any shape the flat payload structurally cannot represent:

- An unsupported channel `type` (anything other than telegram/discord/slack).
- A duplicate channel `type` (two `telegram` attachments can't both fit one
  `telegramToken` slot).
- A `"slack"` attachment without exactly 2 `requiredSecretNames`.

`authGroup` is dropped from the outgoing payload entirely (both apply and
dry-run preview) — only `authChoice` is sent, matching the confirmed
contract. It stays in the profile schema and is still read from the
profile; it's just never included in the HTTP body anymore.

## Deliverables (with spec-role assignment)

| ID | Deliverable | Kind | Owning role | Session |
| --- | --- | --- | --- | --- |
| D1 | `packages/openclaw-setup-applier/src/apply-profile.ts` — `mapChannelsToPayloadFields` helper; real apply path and dry-run preview both use it; `authGroup` dropped from outgoing payload; fail-loud on unsupported type, duplicate type, wrong slack secret count | client | `/backend-architect` | 1 |
| D2 | `fixtures/setup-profile/` — new `slack-channel.json` (2 secrets) and `multi-channel.json` (telegram + slack together), per issue #9's "profile with 2+ channel attachments" scope | fixture | `/test-engineer` | 1 |
| D3 | `tests/openclaw-setup-applier-apply-profile.test.ts` — flat payload shape (apply path), flat preview shape (dry-run), multi-channel single-call, `authGroup` absent from outgoing payload (regression), unsupported/duplicate/wrong-count failures | test | `/test-engineer` | 1 |
| D4 | Doc/comment updates reflecting the now-confirmed contract: `apply-profile.ts`'s own "not independently confirmed" comments, `docs/setup-profile-applier.md`'s "Open, non-blocking caveat" paragraph, `docs/plans/setup-profile-applier/plan.md`'s Dependencies/Out-of-Scope bullets (marked resolved, pointing here) | doc | `/backend-architect` | 1 |
| D5 | `docs/plans/setup-run-payload-contract/plan.md` — this plan | doc | `/project-manager` | 1 |
| D6 | `docs/plans/setup-run-payload-contract/ACs.md` — structured AC table with Plan-ref and Role columns | doc | `/project-manager` | 1 |
| D7 | `docs/plans/setup-run-payload-contract/review.md` — `/review` report | doc | `/project-manager` | 1 |

### Design decisions carried into Implement

- **Single mapping function, two callers** (D1): the bug this plan fixes
  existed in *two* places (real payload + dry-run preview) because they
  duplicated the same array-shape logic independently. `mapChannelsToPayloadFields`
  is called from both, so there's exactly one place left to get wrong.
- **Positional Slack ordering** (D1): `requiredSecretNames[0]` = bot token,
  `[1]` = app token. This is an assumption, not a live-confirmed fact (no
  real slack-bearing profile was available to check) — documented explicitly
  in code and in this plan rather than silently guessed.
- **Fail loud, don't silently drop** (D1): an unsupported/duplicate channel
  type or a malformed slack attachment throws before any network call,
  matching the existing `modelProviders.length > 1` precedent — a profile
  the flat payload can't represent should never reach `/setup/api/run` and
  fail there with a confusing 400/500.
- **This applies to dry-run too, deliberately** (D1, AC-FN-007): because
  `mapChannelsToPayloadFields` is shared, `dryRunApplyProfile` now throws
  on the same structurally-invalid profiles instead of silently previewing
  one that would fail live — a real behavior change from pre-fix, called
  out explicitly (not shipped as an unstated side effect) because it's the
  correct behavior for what dry-run exists to do: catch exactly this kind
  of problem before a live call, not after.
- **`setup-api-client.ts` needs no change**: `run(payload: unknown)` stays
  an unopinionated transport; the shape is entirely `apply-profile.ts`'s
  responsibility. Confirmed by re-reading `setup-api-client.ts` — no
  channel- or provider-specific logic lives there.
- **`profile-schema.ts` needs no structural change**: the channel schema
  (`{ type: string, requiredSecretNames: string[] }`) already captures
  what's needed generically; type-support validation belongs in
  `apply-profile.ts` (where it's actually consumed), not the schema, per
  this file's existing "tolerant parse, fail loud only where consumed"
  philosophy.

### Files to Create

- `fixtures/setup-profile/slack-channel.json`, `multi-channel.json`.
- `docs/plans/setup-run-payload-contract/plan.md`, `ACs.md`, `review.md`.

### Files to Edit

- `packages/openclaw-setup-applier/src/apply-profile.ts`
- `packages/openclaw-setup-applier/src/setup-api-client.ts` (header comment
  only — no behavior change; the "not independently confirmed" claim is
  now stale)
- `tests/openclaw-setup-applier-apply-profile.test.ts`
- `docs/setup-profile-applier.md`
- `docs/plans/setup-profile-applier/plan.md`

## Sessions

Single session — D1-D7 all land together.

## Acceptance Criteria

See `docs/plans/setup-run-payload-contract/ACs.md`.

## Gate 1/2 Pre-Check

No project-specific validator scripts exist in this repo (same structural
adaptation as the #8 and #12 fixes). Gate 1 (deliverable ↔ AC coverage) and
Gate 2 (anti-drift literal-pin check) are performed manually in the ACs doc.

## Commit Schedule

1. Plan + ACs commit: `docs: add setup run payload contract plan`
2. Implementation + tests: `fix(setup-applier): send the real flat /setup/api/run payload shape`
3. Verification: confirmed inline (typecheck/test/build), no separate commit
4. Review: `docs: record setup run payload contract review`

## Dependencies

None outstanding. The live confirmation this plan depends on already
happened (see Live Confirmation above) — no further live/mutating call is
needed to implement or verify this fix; every AC is testable with a
stubbed `setupApiClient`/`RailwayRunner`, matching this package's existing
test convention.

## Out of Scope

- Any live `POST /setup/api/run` call, against the proof instance or
  otherwise — the confirmed contract came entirely from `app.js`'s own
  source and `GET` endpoints, so no mutating call is needed and none will
  be made.
- Re-litigating the applier's overall design (idempotency, secret-safety,
  minting) — stable and already verified in the original plan.
- Confirming the Slack bot/app token ordering live — flagged as an
  assumption (see Design Decisions), not resolved here.
