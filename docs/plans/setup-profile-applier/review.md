# Setup Profile Applier Review

## Summary

This review tracks the machine gate for the setup-profile-applier feature
(issue #7): automating `/setup` API configuration on a live OpenClaw
instance from a generated client profile. Session 1 (D1–D10, non-mutating)
and Session 2 (D11–D21, mutating) are both complete on
`feat/setup-profile-applier`.

## Verdict

**Minor.** No blocking findings. This `/review` pass's holistic cross-check
(deliverables↔code, ACs↔tests, docs drift) surfaced one new issue beyond the
QC pass already recorded below — a stale CLI-invocation example in
`docs/setup-profile-applier.md` — found and fixed during this pass. Proceed
to human review.

## Workflow Notes

- Branch created for this workflow: `feat/setup-profile-applier`.
- Project-specific agentic-workflow hooks and
  `.claude/verification-status.json` are not present in this repo. The plan
  records manual Gate 1/2 checks, same as `docs/plans/open-source-readiness/`.
- Split into two sessions along a risk seam (non-mutating vs. mutating), not
  a module seam, per the plan's Approach section.
- Step 0 role context loaded for this `/review` pass: `~/.claude/commands/
  {backend-architect,devops,test-engineer,project-manager,security}.md` (the
  distinct owning roles across D1–D21; no project-local override exists in
  this repo). Held in context for Steps 1–3 and used to ground the "Inputs
  for /retro" section below.

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
| --- | --- | --- |
| D1 | `packages/openclaw-setup-applier/src/profile-schema.ts:1-85` | ✓ shipped |
| D2 | `packages/openclaw-setup-applier/src/setup-api-client.ts:23-39` (read calls) | ✓ shipped |
| D3 | `packages/openclaw-setup-applier/src/railway-variables.ts:12-27` (read path) | ✓ shipped |
| D4 | `packages/openclaw-setup-applier/src/apply-profile.ts:42-95` (dry-run path) | ✓ shipped |
| D5 | `fixtures/setup-profile/{channel,key-provisioning-provider,plain-secret-provider}.json` | ✓ shipped |
| D6 | `tests/openclaw-setup-applier-{profile-schema,setup-api-client,railway-variables,apply-profile}.test.ts` (Session 1 cases) | ✓ shipped |
| D7 | `tsconfig.json`, `tsconfig.base.json`, `tests/tsconfig.json` | ✓ shipped, minus the root CLI script (deliberately deferred — no stable invocation story existed at D7 time; D15 supplied the CLI later in Session 2) |
| D8 | `docs/setup-profile-applier.md` | ✓ shipped |
| D9 | `docs/plans/setup-profile-applier/plan.md` | ✓ shipped |
| D10 | `docs/plans/setup-profile-applier/ACs.md` | ✓ shipped |
| D11 | `packages/openclaw-setup-applier/src/openrouter-provisioning.ts:1-64` | ✓ shipped |
| D12 | `packages/openclaw-setup-applier/src/railway-variables.ts:29-60` (write path) | ✓ shipped |
| D13 | `packages/openclaw-setup-applier/src/setup-api-client.ts:37-62` (mutating calls) | ✓ shipped |
| D14 | `packages/openclaw-setup-applier/src/apply-profile.ts:97-258` (full apply path) | ✓ shipped |
| D15 | `packages/openclaw-setup-applier/src/cli.ts:1-162` | ✓ shipped |
| D16 | `tests/openclaw-setup-applier-apply-profile.test.ts:207-231` (sentinel-capture case) + code review (no filesystem writes) | ✓ shipped |
| D17 | `tests/openclaw-setup-applier-{openrouter-provisioning,cli}.test.ts` (new) + extended Session 1 files (Session 2 cases) | ✓ shipped |
| D18 | `.env.example` | ✓ shipped |
| D19 | `README.md:25-30`, `docs/architecture.md:16-18`, `docs/setup-profile-applier.md` | ✓ shipped |
| D20 | Verification run (typecheck/test/build/audit) — no file, see Verification section | ✓ shipped |
| D21 | `docs/plans/setup-profile-applier/review.md` (this file) | ✓ shipped |

### Code changes not tied to any deliverable

- `.github/ISSUE_TEMPLATE/change.md`, `CONTRIBUTING.md`, `docs/README.md` —
  the public-repo-voice guardrail work (extending the Public-Repo Rule to
  issues/PRs) done in this same session *before* this plan was authored, on
  the same branch. Not scope creep by an implementing agent — deliberate,
  discussed with the user, bundled onto this branch by explicit choice
  rather than a separate one.
- `packages/openclaw-railway-installer/src/index.ts` (`RailwayRunner.run`'s
  new optional `stdin` parameter) and `src/cli.ts` (wiring it through) —
  necessary supporting infrastructure for D12's `--stdin` write, added by
  the parent thread ahead of the Session 2 fork rather than as a named
  deliverable. **This is a real plan gap, not just an omission**: the plan's
  "Files to Edit" table never anticipated touching
  `packages/openclaw-railway-installer` at all — D12's design decision (add
  `--stdin`) was written into the plan *after* Session 1 shipped, but the
  Files to Edit table wasn't updated to name the cross-package file it
  actually required. Worth a `/retro` item (see below) so future plans that
  add a design decision mid-flight also update the files table.
- `docs/architecture.md`'s `packages/openclaw-railway-installer` line — a
  drive-by fix for a pre-existing gap unrelated to this plan (see Residual
  Risk), done after this plan's D19 already shipped.

## ACs ↔ Tests (Gate 3 spot-check)

Sampled every `AC-TST-*` row plus a purposeful sample of `AC-FN-*`/`AC-SEC-*`
rows whose Pass cells make a specific, checkable claim.

| AC | Test file | Asserts invariant? | Notes |
| --- | --- | --- | --- |
| AC-TST-001 | 4 Session 1 test files | ✓ | Ran directly; 15 tests, matches AC's own count claim. |
| AC-TST-002 | 5 Session 2 test files | ✓ | Ran directly; 28 tests post-QC-fix, matches ACs.md's updated QC note. |
| AC-TST-003 | full suite | ✓ | Ran directly; 66 tests/13 files, typecheck/build clean, matches. |
| AC-FN-001 | `tests/openclaw-setup-applier-profile-schema.test.ts` | ✓ | Asserts both the passthrough case and the exact missing-field error path string — not a vacuous literal, it's the actual invariant the AC names. |
| AC-FN-006 | `tests/openclaw-setup-applier-railway-variables.test.ts:56-104` | ✓ | Asserts the full `args` array for both `skipDeploys` branches AND that the value never appears in `args.join(" ")` — directly verifies the AC's "never as an inline argument" claim, not just that the function runs. |
| AC-FN-005 | `tests/openclaw-setup-applier-openrouter-provisioning.test.ts` | ✓ | Asserts request field names, auth header, and returned key — matches the AC's Pass cell claim field-for-field. |
| **AC-FN-009** | `tests/openclaw-setup-applier-cli.test.ts` | ⚠ **PARTIAL — structural gap, not a defect** | The test file exercises `parseArgs` only. `runCommand` (the real spawn-based `RailwayRunner`, where the stdout-echo leak lived until this session's QC pass) has **zero** test coverage and structurally cannot get any under the no-live-calls constraint (asserting "no echo" would require inspecting a real spawned child's stdout stream). AC-FN-009's Pass cell now documents this gap explicitly (added during QC), so the record is honest, but the AC itself doesn't name it as a "code review only, no test" verification method the way some other rows do — worth a `/retro` note for AC-authoring going forward (see Inputs for /retro). |
| AC-SEC-001 | `tests/openclaw-setup-applier-apply-profile.test.ts:207-231` | ✓, with the same gap noted | Genuinely asserts no sentinel appears in spied `console.log`/`console.error` across a full stubbed apply run. QC's note on this row already states plainly that this can't see the CLI-level leak — confirmed correct on inspection, not overclaiming. |
| AC-SEC-002 | code review, no test | ✓ | Verified directly: neither `apply-profile.ts` nor `cli.ts` imports a filesystem-write API. `cli.ts` does import `readFile` (read-only, for loading the profile) — correctly excluded from this AC's "writes no local files" claim. |

No `WEAK (passes vacuously)` or `MISSING (no test found)` verdicts among the
sampled rows — Rule 6/Rule 8 (`/test-engineer`'s AC-label-matches-assertion
rules) hold throughout. AC-FN-009 is the one `PARTIAL` verdict, already
self-documented in ACs.md rather than silently overclaimed.

## Docs drift

- **Found and fixed during this `/review` pass**:
  `docs/setup-profile-applier.md`'s CLI usage example recommended
  `node --experimental-strip-types packages/openclaw-setup-applier/src/cli.ts
  ...`. This repo's actual established convention — used by the sibling
  `packages/openclaw-railway-installer` CLI, confirmed at
  `deploy/openclaw-railway/install-template.ps1:21-25` — is
  `npm exec -- tsx <path>`. `tsx` is already a devDependency
  (`package.json`); `--experimental-strip-types` is a Node-version-gated
  flag this repo's `package.json` doesn't pin a minimum for. Fixed to match
  the established convention, with a one-line note explaining why.
- No other stale claims found. `README.md`, `docs/architecture.md`, and the
  rest of `docs/setup-profile-applier.md` were checked against the actual
  function signatures and CLI flags shipped (`applyProfile`'s parameter
  shape, `dryRunApplyProfile`'s usage example, the required env var table)
  and matched exactly.

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

## Recommendations

1. Confirm the `authGroup`/`authChoice` enum and multi-channel `/setup/api/run`
   payload shape against a live instance before this applier is trusted
   against production client onboarding (tracked in issue #9).
2. Consider a machine-level guard for unscoped `railway` CLI secret-bearing
   commands (tracked in issue #10) — independent of this feature, lower
   urgency.
3. No action needed on the docs-drift finding — already fixed in this pass.

## Inputs for /retro

- **Route:** `/devops` → `.claude/commands/devops.md`
  **Draft principle:** *"A subprocess wrapper that streams a spawned CLI's
  raw stdout straight to the parent process's stdout (for interactive
  progress/UX) must be re-examined per new call site, not assumed safe by
  precedent — if the new call site invokes a subcommand whose own
  documentation says its output includes raw secret values (e.g. a
  credential-manager CLI's `list`/`get` commands), echoing must be disabled
  for that call site specifically, even when an existing sibling wrapper
  echoes safely for its own (non-secret-bearing) commands."*
  **Triggered by:** `packages/openclaw-setup-applier/src/cli.ts`'s
  `runCommand` copied `packages/openclaw-railway-installer/src/cli.ts`'s
  echo-everything pattern verbatim. That pattern is safe for the installer
  (its commands are `deploy`/`service list`/`domain list|update` — no bare
  secret output), but unsafe for the new CLI (`variable list`/`variable
  set`). No test caught it; found only by code review comparing the new
  file's actual command set against Railway's own documented output-shape
  warning for those specific subcommands.

- **Route:** `/test-engineer` → `.claude/commands/test-engineer.md`
  **Draft principle:** *"When an AC's verification method is 'code review'
  or 'test run' but the code path it covers cannot be exercised by any test
  in the suite for a structural reason (e.g. it only exists in the real,
  non-stubbed implementation of an interface every test fakes), say so
  explicitly in the AC's How column at authoring time — not just in the Pass
  cell after the fact. 'Code review: <file>, because the real
  implementation has no test double' is a different, weaker verification
  method than 'Test run: <file>', and Gate 3 spot-checks should be able to
  tell the two apart from the AC table alone."*
  **Triggered by:** AC-FN-009 (setup-profile-applier) was authored with
  `How: Code review: packages/openclaw-setup-applier/src/cli.ts` — accurate,
  but didn't flag that this was the *only* possible verification method,
  because `runCommand`'s real spawn behavior structurally cannot be unit
  tested under this plan's no-live-calls constraint. The gap was caught only
  in QC (an actual defect existed there), not by AC-authoring-time review
  noticing the coverage hole.

- **Route:** `/project-manager` → `.claude/commands/project-manager.md`
  **Draft principle:** *"When a design decision added mid-plan (after
  Session 1 shipped, during Session 2's authoring) requires touching a file
  outside the deliverables the plan originally scoped, update the plan's
  'Files to Edit' table in the same edit that adds the design decision —
  not just the prose design-decision bullet. A design decision that names a
  new mechanism (e.g. `--stdin` needing a new interface parameter) but
  doesn't update the files table creates a real, if minor, plan↔code
  mismatch that `/review`'s Step 1 has to catch after the fact."*
  **Triggered by:** the setup-profile-applier plan's D12 design decision
  (switching Railway variable writes to `--stdin`) was added to `plan.md`
  between Session 1 and Session 2, correctly, but the "Files to Edit" table
  was never updated to name `packages/openclaw-railway-installer/src/
  index.ts`/`cli.ts` — the two files that design decision actually required
  touching. Not scope creep (the change was necessary and correct), but an
  avoidable plan↔code gap.

- **Route:** `/security` → `.claude/commands/security.md`
  **Draft principle** (this role's skill file has no Retro-Sourced
  Principles section yet — this would be its first):
  *"When reviewing code that wraps a CLI/subprocess whose own documentation
  warns that certain subcommands' output includes raw secret values, don't
  stop at checking whether the *application code* logs or persists the
  secret. A generic 'stream subprocess output through for interactive
  visibility' pattern is itself a leak vector, independent of what the
  calling code does with the parsed result — check every place raw
  subprocess stdout/stderr is echoed to a parent process's own output
  stream, and cross-reference the actual subcommands that pattern will run
  against the underlying CLI's own documented output-shape warnings."*
  **Triggered by:** the same `cli.ts` stdout-echo finding above. This is
  the kind of defect a security-focused review pass (as opposed to a
  feature-behavior QC pass) is specifically positioned to catch, since it's
  invisible from the application code's own logging discipline — the leak
  lived entirely in a generic subprocess-wrapper pattern, not in any line
  that "logs a secret."
