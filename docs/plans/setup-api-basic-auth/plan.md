# Setup API Basic Auth Plan

Branch: `feat/setup-api-basic-auth`
Source: [GitHub issue #12](https://github.com/yuens1002/openclaw-control-plane/issues/12)
"setup-api-client.ts sends no auth on /setup/api/* calls, but
SETUP_PASSWORD-protected instances require HTTP Basic auth," filed
2026-08-15.

## Summary

`packages/openclaw-setup-applier/src/setup-api-client.ts` sends no
authentication header on any `/setup/api/*` call. A live OpenClaw instance
with `SETUP_PASSWORD` set (the normal/recommended setup per
`deploy/openclaw-railway/README.md`) requires HTTP Basic auth on those
routes, so `applyProfile()`'s mutating path fails against any protected
instance as shipped. This plan adds Basic auth support to the client and
wires the target instance's credentials through the CLI, without touching
the dry-run path (which never calls the instance's HTTP API at all).

This blocks issue #9's live verification work (`GET /setup/api/auth-groups`
against a real instance) — a protected instance 401s the same
unauthenticated client #9 would otherwise have to use. Fixing this first is
a prerequisite, not just an improvement.

**Deviation from issue #12's literal wording:** #12 proposes sourcing the
target instance's credentials from `OPENCLAW_SETUP_USERNAME`/
`SETUP_PASSWORD`. This plan uses `OPENCLAW_INSTANCE_SETUP_USERNAME`/
`OPENCLAW_INSTANCE_SETUP_PASSWORD` instead — see Current State below for
why the reused names are a real collision risk, not just a naming
coincidence, given how this repo is actually being used (bootstrapping the
agency's own instance from a profile of itself, the same usage pattern
every client onboarding will later follow).

## Current State

- `setup-api-client.ts`'s `createSetupApiClient` sends every `/setup/api/*`
  request with no `Authorization` header (`setup-api-client.ts:23-64`).
- `cli.ts`'s `main()` already has one precedent for a "fail loud before any
  network call" required-env-var check: `OPENROUTER_MANAGEMENT_KEY`
  (`cli.ts:42-45`), inlined directly in `main()` and not independently
  testable — `tests/openclaw-setup-applier-cli.test.ts` only covers the
  exported `parseArgs`.
- This control-plane's own `apps/api` server already implements a Basic-auth
  gate using the identical env var names (`apps/api/src/index.ts:163-173`:
  `SETUP_PASSWORD` / `OPENCLAW_SETUP_USERNAME`, default `"openclaw"`) via
  Hono's `basicAuth` middleware — but that gates *this repo's own* API, a
  completely different server than the target OpenClaw instance
  `setup-api-client.ts` talks to. The name reuse is a real operational
  collision risk, not just a naming coincidence: this repo is used to
  bootstrap the agency's own OpenClaw instance from a client profile of the
  agency itself, so the control-plane's own API and the target instance the
  setup-applier CLI configures can end up deployed and credentialed
  side-by-side, in the same project. A single `SETUP_PASSWORD` in a shared
  shell or deploy environment can't serve both — whichever process reads it
  second gets the wrong instance's password. Renaming the setup-applier's
  vars (see Approach) removes the collision structurally instead of relying
  on an operational convention to keep the two environments apart.
- Confirmed live (per issue #12): an unauthenticated `GET /setup/api/status`
  against a real `SETUP_PASSWORD`-protected instance returns `401`.
- `apply-profile.ts` never constructs its own HTTP requests — every call
  goes through the injected `setupApiClient` (`apply-profile.ts:146,227,229`).
  So D1 + D2 below are sufficient; `apply-profile.ts` needs no change,
  matching issue #12's stated out-of-scope.

## Approach

Add an optional `auth` field to `SetupApiClientOptions`. When present,
every request (`getStatus`, `getAuthGroups`, `run`, `reset`) carries an
`Authorization: Basic <base64(username:password)>` header. When absent,
behavior is unchanged (no header) — preserves the existing contract against
unprotected instances and every existing test.

`cli.ts` resolves `OPENCLAW_INSTANCE_SETUP_PASSWORD` (required) and
`OPENCLAW_INSTANCE_SETUP_USERNAME` (optional, default `"openclaw"`) from
the environment — deliberately distinct from this repo's own
`SETUP_PASSWORD`/`OPENCLAW_SETUP_USERNAME` (see Current State) — in the
same place and the same fail-loud style as the existing
`OPENROUTER_MANAGEMENT_KEY` check — after the `--dry-run` early return, so
dry-run remains unaffected.
Both checks are refactored into one small exported `requireEnv(name)`
helper: this is not a new abstraction for its own sake, it's what makes the
new check testable at all (the existing inline check has no test coverage
today for the same structural reason noted in issue #8's review — `main()`
has no test double) and it removes the now-duplicated inline pattern.

## Deliverables (with spec-role assignment)

| ID | Deliverable | Kind | Owning role | Session |
| --- | --- | --- | --- | --- |
| D1 | `packages/openclaw-setup-applier/src/setup-api-client.ts` — optional `auth: { username, password }` on `SetupApiClientOptions`; `Authorization: Basic <base64>` header added to all four calls when present, omitted when absent | client | `/backend-architect` | 1 |
| D2 | `packages/openclaw-setup-applier/src/cli.ts` — exported `requireEnv(name): string` helper; `OPENCLAW_INSTANCE_SETUP_PASSWORD`/`OPENCLAW_INSTANCE_SETUP_USERNAME` resolved via it and wired into `createSetupApiClient({ ..., auth })` on the apply path only (not dry-run); existing `OPENROUTER_MANAGEMENT_KEY` check refactored onto the same helper | cli | `/backend-architect` | 1 |
| D3 | `tests/openclaw-setup-applier-setup-api-client.test.ts` — new cases: `Authorization` header present and correctly base64-encoded when `auth` is given; no `Authorization` header when `auth` is omitted (regression covering every existing unprotected-instance test) | test | `/test-engineer` | 1 |
| D4 | `tests/openclaw-setup-applier-cli.test.ts` — new cases for exported `requireEnv`: returns the value when the env var is set; throws `Missing required env var: <name>` when unset | test | `/test-engineer` | 1 |
| D5 | `docs/setup-profile-applier.md` — add `OPENCLAW_INSTANCE_SETUP_USERNAME` / `OPENCLAW_INSTANCE_SETUP_PASSWORD` to the "Required env vars" table, scoped explicitly to the apply path (not dry-run); one-line note on why these are deliberately *not* named `SETUP_PASSWORD`/`OPENCLAW_SETUP_USERNAME` (this repo's own, different, API auth gate) | doc | `/backend-architect` | 1 |
| D6 | `.env.example` (root) — add commented `OPENCLAW_INSTANCE_SETUP_PASSWORD`/`OPENCLAW_INSTANCE_SETUP_USERNAME` entries alongside the existing `SETUP_PASSWORD`/`OPENCLAW_SETUP_USERNAME` ones, with a one-line comment distinguishing the two pairs | doc | `/backend-architect` | 1 |
| D7 | `docs/plans/setup-api-basic-auth/plan.md` — this plan | doc | `/project-manager` | 1 |
| D8 | `docs/plans/setup-api-basic-auth/ACs.md` — structured AC table with Plan-ref and Role columns | doc | `/project-manager` | 1 |
| D9 | `docs/plans/setup-api-basic-auth/review.md` — `/review` report | doc | `/project-manager` | 1 |

### Design decisions carried into Implement

- **Header construction** (D1): `Buffer.from(\`${username}:${password}\`).toString("base64")` — Node's standard primitive, no new dependency. No existing client-side Basic-auth-header code exists in this repo to reuse (the only precedent, `apps/api`'s `basicAuth` middleware, is server-side/receiving, not client-side/sending).
- **`requireEnv` scope** (D2): only replaces the two call sites that already exist or are being added in `cli.ts`'s `main()` (`OPENROUTER_MANAGEMENT_KEY`, `OPENCLAW_INSTANCE_SETUP_PASSWORD`) — not a generic env-loading framework.
- **Dry-run stays untouched** (D2): the `OPENCLAW_INSTANCE_SETUP_PASSWORD` check goes in the same place as the existing `OPENROUTER_MANAGEMENT_KEY` check, strictly after the `if (options.dryRun) { ...; return; }` branch.
- **No `apply-profile.ts` change**: confirmed by reading its only three `setupApiClient.*` call sites (`apply-profile.ts:146,227,229`) — all go through the injected client, so auth is fully encapsulated by D1+D2.

### Files to Create

- `tests` additions only (D3, D4 extend existing files — see below).
- `docs/plans/setup-api-basic-auth/plan.md`, `ACs.md`, `review.md`.

### Files to Edit

- `packages/openclaw-setup-applier/src/setup-api-client.ts`
- `packages/openclaw-setup-applier/src/cli.ts`
- `tests/openclaw-setup-applier-setup-api-client.test.ts`
- `tests/openclaw-setup-applier-cli.test.ts`
- `docs/setup-profile-applier.md`
- `.env.example`

## Sessions

Single session — D1-D9 all land together. This is a small, self-contained
fix (issue #12's own scope has no natural session split).

## Acceptance Criteria

See `docs/plans/setup-api-basic-auth/ACs.md`.

## Gate 1/2 Pre-Check

No project-specific `scripts/check-acs-coverage.ts` / `scripts/check-test-drift.ts`
exist in this repo (it has not opted into the full agentic-workflow
tooling — see `/review`'s structural-exception precedent from the #8 fix).
Gate 1 (deliverable ↔ AC coverage) and Gate 2 (anti-drift literal-pin check)
are performed manually: every deliverable D1-D9 has at least one AC row
whose Plan-ref names it, and every AC's Pass condition below states a
runtime behavior/relation (header present + correctly encoded, header
absent, helper return/throw) rather than a value that already lives in the
producer.

## Commit Schedule

1. Plan + ACs commit: `docs: add setup api basic auth plan`
2. Implementation + tests: `fix(setup-applier): add basic auth to setup api client`
3. Verification: confirmed inline (typecheck/test/build), no separate commit
4. Review: `docs: record setup api basic auth review`

## Dependencies

None outside this repo. No live network call required to implement or
verify this fix — every AC is testable with a stubbed `fetchImpl`, matching
the existing test file's convention. (Live confirmation that a protected
instance now accepts the header is issue #9's job, not this plan's — #9 is
still blocked on nothing else once this merges.)

## Out of Scope

- `dryRunApplyProfile` / the dry-run path (never calls the instance's HTTP
  API — issue #12's own stated out-of-scope).
- Any change to `/setup`'s own auth behavior (issue #12's own stated
  out-of-scope).
- Issue #9's live API-contract verification — this plan only removes the
  blocker; it does not perform the live verification itself.
