# Railway CLI Spawn Contract Plan

Branch: `feat/railway-cli-spawn-contract`
Source: session discussion — "test the control plane e2e," scoped down to the
Railway installer's foundation-automation layer (`packages/openclaw-railway-installer`),
deliberately stopping before `packages/openclaw-setup-applier` (the "profile
layer," out of scope — a separate, throwaway-client, live e2e is being built
for that in a sibling private client-profile repo).

## Summary

Every orchestration test for this repo's Railway installer
(`installOpenClawOnRailway`, `provisionClientInstance`, `updateClientTemplateRef`)
runs only against a fake `RailwayRunner` — never against the real
`spawn()`-based `runCommand` that actually talks to a child process. That gap
already caused a real incident (a secret-leak stdout echo shipped and was
only caught by a human, not a test — see Current State). This plan adds
real-process ("spawn contract") tests for the one seam a fake can never
validate, and separately dedupes the three near-identical `FakeRailwayRunner`
classes used by the orchestration-level tests. No production behavior
changes except exporting one already-private function.

## Current State

- `packages/openclaw-railway-installer/src/cli.ts` (marketplace-template
  install path, `installOpenClawOnRailway`) and
  `packages/openclaw-railway-installer/src/client-cli.ts` (agency per-client
  path, `provisionClientInstance` / `updateClientTemplateRef`) each define
  their own `runCommand(command, args, stdin?)`, both wrapping
  `child_process.spawn(..., { shell: false })` with near-identical
  stdout/stderr capture and non-zero-exit rejection logic.
- The two implementations deliberately differ in one place:
  `client-cli.ts`'s `runCommand` does **not** echo captured stdout to this
  process's own `process.stdout`, because that CLI's command set includes
  `railway variable list` (via `readRailwayVariable`, on the idempotent-rerun
  path), and Railway's own `--json`/`--kv` output on that subcommand prints
  raw secret values. `cli.ts`'s `runCommand` **does** echo — correct today,
  since its command set never touches `variable list`, but nothing currently
  proves that invariant holds.
- This split exists because of a real incident: `tests/openclaw-railway-client-cli.test.ts`'s
  own comment records that "a sibling wrapper's stdout-echo was copied
  verbatim into a new call site without re-checking the new command set — and
  no test caught it, because every test used a fake runner that never
  exercised the real spawn path." One narrow regression test was added there
  afterward (`runCommand` never writes the spawned process's stdout to this
  process's own stdout, even though it's still captured for parsing) — but
  only for `client-cli.ts`. `cli.ts`'s `runCommand` has zero real-process
  coverage of any kind.
- `tests/openclaw-railway-provision-client.test.ts` has a test explicitly
  titled around "issue #18: no PowerShell-pipe BOM/CRLF corruption," but it
  only asserts the string `provisionClientInstance` hands to the *fake*
  `RailwayRunner.run()` is byte-clean — it never spawns a real child process,
  so it cannot actually catch corruption introduced inside the real
  `spawn()` + `child.stdin.end()` path itself.
- `FakeRailwayRunner` (implementing the `RailwayRunner` interface used by
  `installOpenClawOnRailway`/`provisionClientInstance`/`updateClientTemplateRef`)
  is independently reimplemented in three test files
  (`openclaw-railway-installer.test.ts`, `openclaw-railway-provision-client.test.ts`,
  `openclaw-railway-update-client-ref.test.ts`), each a partial subset of the
  same command dispatch logic (`deploy` / `init`+`link`+`up` / `service list`
  / `service <name>` / `volume add` / `variable set`+`variable list` /
  `redeploy` / `domain list`+`domain update`). `provision-client`'s version is
  a strict superset of the other two.
- Explicitly considered and rejected: chaining `provisionClientInstance`'s
  output into `verifyOpenClawRailwayProof`. `verifyOpenClawRailwayProof`
  audits the **public proof instance** — a Railway service manually
  configured to GitHub-track `yuens1002/openclaw-control-plane@main` — and
  its checks explicitly *reject* a deployment still sourced from the upstream
  template repo. `installOpenClawOnRailway` deploys exactly that upstream
  template (`railway deploy -t clawdbot-railway-template`), and
  `provisionClientInstance` deploys via `railway up` as a one-shot local
  snapshot with no GitHub tracking at all. Neither function is proof's
  producer; no code in this repo is. Chaining them would test a composition
  that never happens in real usage, so this plan does not do it.
- Checked for in-progress-branch collisions before starting (retro lesson —
  a prior session's plan flagged a same-file conflict risk but didn't
  re-check it before handoff, and the conflict landed after human approval):
  `feat/onboarding-regression-pipeline` touches
  `packages/openclaw-setup-applier/**` and `deploy/openclaw-railway/README.md`
  only; `feat/20-workspace-identity-transport` touches only its own
  `docs/plans/workspace-identity-transport/**`. Neither touches
  `packages/openclaw-railway-installer/**`, `tests/openclaw-railway-*.test.ts`,
  or `tests/fixtures/**`. Re-check both against `origin/main` again
  immediately before Phase 5 handoff, not just here.

## Approach

Two independent tracks, both test-only:

1. **Spawn contract tests** — for each of `cli.ts`'s and `client-cli.ts`'s
   `runCommand`, add tests that spawn a real child process (via
   `process.execPath -e "<inline script>"`, the same technique the one
   existing real-spawn test already uses — no fake `railway` binary needed,
   no network, no live Railway) and assert: (a) stdin written via
   `child.stdin.end(value)` round-trips byte-identical to what the child
   reads (closing the "issue #18" gap — this is the first test that actually
   exercises the real spawn+stdin path for byte fidelity), (b) a non-zero
   child exit code rejects with the documented
   `railway <args> failed with exit code <code>: <stderr>` message built from
   the real captured stderr, and (c), `cli.ts` only, that stdout is both
   captured for parsing **and** written to this process's `process.stdout`
   (a spy-based test that documents the deliberate echo behavior so a future
   accidental copy-paste from `client-cli.ts`, or vice versa, fails loudly
   instead of shipping a silent secret leak or a silently-broken echo).
   `cli.ts`'s `runCommand` is currently module-private; it needs an `export`
   keyword (no logic change) to be testable directly, matching
   `client-cli.ts`'s existing `export function runCommand`.
2. **Fixture dedup** — extract one shared `FakeRailwayRunner` into
   `tests/fixtures/fake-railway-runner.ts`, implementing the union of all
   three existing fakes' command dispatch (superset already exists in
   `provision-client`'s version; only the `deploy` branch from `installer`'s
   version is missing from it). Migrate all three orchestration test files
   onto it, deleting their private class definitions. No assertions change —
   this is a pure refactor to remove duplicated simulation logic that could
   otherwise silently drift out of sync with the real Railway CLI JSON
   shapes in three different, independently-maintained places.

## Deliverables (with spec-role assignment)

| ID | Deliverable | Kind | Owning role | Session |
| --- | --- | --- | --- | --- |
| D1 | `packages/openclaw-railway-installer/src/cli.ts` — export the existing `runCommand` function; no logic change | client | `/backend-architect` | 1 |
| D2 | `tests/openclaw-railway-cli.test.ts` — real-spawn contract tests for `cli.ts`'s `runCommand`: byte-identical stdin round-trip, non-zero-exit rejection message, stdout captured-and-echoed | test | `/test-engineer` | 1 |
| D3 | `tests/openclaw-railway-client-cli.test.ts` — add the missing real-spawn cases for `client-cli.ts`'s `runCommand`: byte-identical stdin round-trip, non-zero-exit rejection message (stdout-not-echoed case already covered, not duplicated) | test | `/test-engineer` | 1 |
| D4 | `tests/fixtures/fake-railway-runner.ts` — new shared `FakeRailwayRunner` implementing `RailwayRunner`, superseding the three private copies | test | `/test-engineer` | 1 |
| D5 | `tests/openclaw-railway-installer.test.ts` — migrate off its private `FakeRailwayRunner` onto D4; no assertion changes | test | `/test-engineer` | 1 |
| D6 | `tests/openclaw-railway-provision-client.test.ts` — migrate off its private `FakeRailwayRunner` onto D4; no assertion changes | test | `/test-engineer` | 1 |
| D7 | `tests/openclaw-railway-update-client-ref.test.ts` — migrate off its private `FakeRailwayRunner` onto D4; no assertion changes | test | `/test-engineer` | 1 |
| D8 | `docs/plans/railway-cli-spawn-contract/plan.md` — this plan | doc | `/project-manager` | 1 |
| D9 | `docs/plans/railway-cli-spawn-contract/ACs.md` — structured AC table with Plan-ref and Role columns | doc | `/project-manager` | 1 |
| D10 | `docs/plans/railway-cli-spawn-contract/review.md` — `/review` report | doc | `/project-manager` | 1 |

### Design decisions carried into Implement

- **No fake `railway` executable file** (D2, D3): `process.execPath -e "<script>"`
  (Node spawning Node) is sufficient to stand in for the real child process
  boundary — it's the actual thing being tested (does our `spawn()` wrapper
  round-trip bytes and surface exit codes correctly), not a Railway-specific
  concern. This is the same technique `client-cli.test.ts`'s existing
  real-spawn test already uses; do not introduce a separate fixture script.
- **`resolveRailwayExecutable` stays untouched and unexported** (D1): tests
  call `runCommand` directly with `process.execPath` as the command, bypassing
  executable resolution entirely — matching the existing pattern in
  `client-cli.test.ts`. Only `runCommand` needs exporting.
- **D4's fixture is the union of the three existing fakes, not a redesign**:
  `provision-client`'s existing `FakeRailwayRunner` is already a strict
  superset of `update-client-ref`'s; only `installer`'s `deploy` branch is
  new to the union. No new configurability beyond what the three existing
  constructors/setters already expose (`serviceListResponses` queue,
  `setDomainList`, `setDomainUpdate`, `setVariableListResponse`).
- **D5–D7 are refactors, not rewrites**: every existing `expect(...)` in
  these three files stays as-is; only the `FakeRailwayRunner` class
  definition and its import are replaced.

### Files to Create

- `tests/fixtures/fake-railway-runner.ts` (D4)
- `docs/plans/railway-cli-spawn-contract/plan.md`, `ACs.md`, `review.md`

### Files to Edit

- `packages/openclaw-railway-installer/src/cli.ts`
- `tests/openclaw-railway-cli.test.ts`
- `tests/openclaw-railway-client-cli.test.ts`
- `tests/openclaw-railway-installer.test.ts`
- `tests/openclaw-railway-provision-client.test.ts`
- `tests/openclaw-railway-update-client-ref.test.ts`
- `tests/tsconfig.json` — add `fixtures/**/*.ts` to `include` (discovered
  during Implement: the `tests` TS project only included `**/*.test.ts` and
  `fixtures/**/*.json`; D4's new `.ts` fixture file needs its own include
  pattern to compile under Gate — TS6307)

## Sessions

Single session — D1-D10 all land together. Small, self-contained, test-only
scope with no natural split.

## Acceptance Criteria

See `docs/plans/railway-cli-spawn-contract/ACs.md`.

## Gate 1/2 Pre-Check

No project-specific `scripts/check-acs-coverage.ts` / `scripts/check-test-drift.ts`
exist in this repo (same structural exception as `setup-api-basic-auth` and
`client-template-pinning`). Gate 1 (deliverable ↔ AC coverage) and Gate 2
(anti-drift literal-pin check) are performed manually: every deliverable
D1-D10 has at least one AC row whose Plan-ref names it, and every AC's Pass
condition below states a runtime behavior/relation (byte-identical round
trip, real rejection message built from real stderr, echoed-and-captured)
rather than a value that already lives in the producer.

## Commit Schedule

1. Plan + ACs commit: `docs: add railway CLI spawn contract plan`
2. Spawn contract tests: `test(railway-installer): add real-spawn contract tests for runCommand`
3. Fixture dedup: `test(railway-installer): dedupe FakeRailwayRunner into a shared fixture`
4. Verification: confirmed inline (typecheck/test/build), no separate commit
5. Review: `docs: record railway CLI spawn contract review`

## Dependencies

None outside this repo. No live network or Railway access required for any
AC — every new test spawns a real *local* child process (Node spawning
Node), never the real `railway` binary. Re-check `feat/onboarding-regression-pipeline`
and `feat/20-workspace-identity-transport` against `origin/main` immediately
before Phase 5 handoff (see Current State) in case either has merged and
newly touches a file this plan edits.

## Out of Scope

- `packages/openclaw-setup-applier` (the "profile layer") and its own
  `runCommand`/`resolveRailwayExecutable` copy — a live, throwaway-client e2e
  for that layer is being built separately in a sibling private
  client-profile repo.
- Chaining `provisionClientInstance` or `installOpenClawOnRailway` output
  into `verifyOpenClawRailwayProof` — explicitly considered and rejected,
  see Current State; no such composition exists in production.
- Any change to `verify-proof.ts` or its existing tests.
- Any change to `railway-guard.test.ts`, `railway-variables.ts`,
  `template-lock.ts`, or `check-template-lock.ts` — unrelated seams, already
  independently tested.
- A live Railway smoke test in this repo's CI — intentionally opt-in today
  (`railway-proof-verify.yml`) and stays that way; this plan's tests run in
  `npm test` on every merge without any live dependency.
