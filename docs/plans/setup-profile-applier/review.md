# Setup Profile Applier Review

## Summary

This review tracks the machine gate for the setup-profile-applier feature
(issue #7): automating `/setup` API configuration on a live OpenClaw
instance from a generated client profile. Session 1 (D1–D10, non-mutating)
and Session 2 (D11–D21, mutating) are both complete on
`feat/setup-profile-applier`.

## Workflow Notes

- Branch created for this workflow: `feat/setup-profile-applier`.
- Project-specific agentic-workflow hooks and
  `.claude/verification-status.json` are not present in this repo. The plan
  records manual Gate 1/2 checks, same as `docs/plans/open-source-readiness/`.
- Split into two sessions along a risk seam (non-mutating vs. mutating), not
  a module seam, per the plan's Approach section.

## Findings

No blocking findings remain. Every item below was found during QC and fixed
before commit — none shipped as a defect.

- **Schema-validation hard blocker, resolved.** D1's profile schema was
  reconstructed from issue #7's prose and validated against two real
  generated profiles (managed and BYOK tier) supplied by the human running
  this plan. The model-provider shape matched exactly. The channel shape did
  not: the schema required `nonSecretConfig.channelType`, but real profiles
  carry a top-level `type` field on channel attachments with no
  `nonSecretConfig` at all. Confirmed empirically (the built schema failed
  to parse both real profiles before the fix, parsed both cleanly after) and
  fixed across `profile-schema.ts`, `apply-profile.ts`,
  `fixtures/setup-profile/channel.json`, the profile-schema test, and
  `docs/setup-profile-applier.md`.
- **CLI-level secret leak in `packages/openclaw-setup-applier/src/cli.ts`,
  found and fixed in QC, never shipped.** `runCommand`'s stdout handler
  streamed every Railway command's raw stdout to `process.stdout` alongside
  capturing it for parsing. Railway's own `--help` text documents that
  `--json`/`--kv` output includes raw variable values (this is exactly what
  caused the Session 1 exposure incident below) — so the very first real run
  of this CLI, `--dry-run` included, would have reprinted every secret on
  the target service to the terminal. No test caught it because every test
  injects `FakeRailwayRunner`; the echo only existed in the real spawn-based
  runner, which no test exercises (deliberately, per the no-live-calls
  constraint — see AC-SEC-001's QC note in ACs.md). Fixed by dropping the
  `process.stdout.write(chunk)` call for stdout only; stderr is still echoed
  for interactive failure diagnosis, since Railway's raw-value warning is
  documented for `--json`/`--kv` output specifically, not error text.
- **`OpenRouterProvisioning`'s assumed `data.key` response field, confirmed
  against OpenRouter's public API docs.** `mintOpenRouterKey` read the
  minted key from a top-level `key` field without independent confirmation.
  Fetched OpenRouter's own public API reference
  (openrouter.ai/docs/api-reference/api-keys/create-api-key — a public doc,
  not a live call against any credentialed endpoint) and confirmed the
  documented example response has `key` as a top-level field, exactly
  matching the implementation. Also confirms the request field names
  (`name`, `limit`, `limit_reset`) match the docs exactly.
- **Implicit truncation on multiple model-provider attachments, made
  explicit.** `applyProfile` only ever resolved `modelProviders[0]` — correct
  per issue #7's singular `authGroup`/`authChoice`/`authSecret` payload
  fields (one provider per `/setup/api/run` call is the real contract), but
  a profile with more than one attachment would have silently applied only
  the first and dropped the rest with no signal. Changed to throw explicitly
  when `modelProviders.length > 1`, with a test.
- **Live-secret-exposure incident during Session 1, not a defect in shipped
  code.** While confirming the Railway CLI's `variable list --json` output
  shape, an unscoped run against this repo's own linked live Railway project
  printed real production secret values to a terminal. No real value was
  found in the working tree (confirmed by a broad grep across every new/
  changed file before committing) or in any test fixture. The user has
  since rotated the exposed values. Session 2 was run under an explicit
  hard constraint — zero live network or Railway CLI calls — to prevent a
  repeat, and the QC pass above found and fixed the specific code path
  (the CLI's stdout echo) that would have reproduced the same class of
  incident on the first real use of this feature.

## Verification

- Gate 1 coverage check: PASS - D1-D21 all have AC coverage in
  `docs/plans/setup-profile-applier/ACs.md`.
- Gate 2 anti-drift check: PASS - AC Pass cells state invariants (e.g.
  "sentinel value absent from all captured output"), not config-literal
  equality.
- `npm run typecheck`: PASS
- `npm.cmd run test -- --run`: PASS, 66 tests across 13 files (including 6
  setup-profile-applier files: profile-schema, setup-api-client,
  railway-variables, apply-profile, openrouter-provisioning, cli)
- `npm run build`: PASS
- `npm audit --omit=dev`: PASS, 0 vulnerabilities
- Schema validated directly against two real generated profiles (managed +
  BYOK tier): both parse cleanly post-fix.
- Sentinel-secret sweep: no sentinel or real secret value found in any
  committed file (dedicated grep pass across all new/changed files).
- No test in this feature calls a real external network endpoint — every
  OpenRouter and `/setup` API test stubs `fetch`; every Railway CLI test
  uses `FakeRailwayRunner`.

## AC Coverage

All AC rows in `docs/plans/setup-profile-applier/ACs.md` have both Agent and
QC evidence for Session 1 and Session 2. AC-SEC-001's QC note explicitly
records that the fetch/`FakeRailwayRunner`-stubbed test suite cannot observe
the real spawn-based runner's stdout-echo path — the CLI-level leak found
and fixed above was caught by code review, not by that AC's test. Reviewer
column remains pending human review throughout.

## Residual Risk

- **`authGroup`/`authChoice` enum not re-verified live**, and
  **`/setup/api/run` payload shape for multiple channels not independently
  confirmed live** (array-shaped `channels` sent; issue #7's prose describes
  named per-channel-type fields like `telegramToken`/`slackBotToken`/
  `slackAppToken`, which may describe a flat payload instead). Filed as
  [issue #9](https://github.com/yuens1002/openclaw-control-plane/issues/9)
  rather than resolved here — resolving properly means either a live,
  read-only `GET /setup/api/auth-groups` call plus inspecting `/setup/app.js`,
  or an actual live `/setup/api/run` mutation to observe the multi-channel
  shape, and this plan's implementing sessions were deliberately run under a
  no-live-calls constraint after the Session 1 exposure incident. Confirm
  against a live instance before trusting this applier's provider/channel
  handling against production client onboarding.
- **Live-secret-exposure operational gap, still open outside this
  package.** Any developer running the raw `railway` CLI (`variable list`,
  or any other secret-bearing subcommand) unscoped on a machine linked to a
  live Railway project will print real secrets to whatever is capturing
  that terminal's output. This was the proximate cause of Session 1's
  exposure incident, and it is not something this plan can fix — it's a
  property of the Railway CLI itself, invoked outside this package's code.
  What *is* in scope has been addressed: this package's own CLI
  (`packages/openclaw-setup-applier/src/cli.ts`) no longer echoes any
  Railway subprocess's stdout (see Findings), so using this feature as
  intended does not reproduce the incident. Using the raw `railway` CLI by
  hand on a machine linked to a live project still can. Worth a follow-up
  issue if the user wants a broader guard (e.g. a wrapper that warns before
  any unscoped secret-bearing command, or a machine-level policy). Filed as
  [issue #10](https://github.com/yuens1002/openclaw-control-plane/issues/10);
  not part of this plan's scope.
- ~~`docs/architecture.md`'s package list did not previously include
  `packages/openclaw-railway-installer`~~ **Fixed** (`0e3fbb3`) as a
  drive-by, outside this plan's D19 scope but trivial and unrelated-risk.
- No live smoke test exercises the mutating path end-to-end against a real
  OpenClaw instance, by design (this plan's Out of Scope) — all mutating-
  path confidence comes from stubbed tests plus code review.

## Recommendation

Approved for human review. The schema-validation hard blocker is resolved
with real evidence; the two enum/payload-shape caveats above are flagged,
not blocking, and should be confirmed against a live instance before this
applier is trusted against production client onboarding.
