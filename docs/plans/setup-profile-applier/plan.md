# Setup Profile Applier Plan

Branch: `feat/setup-profile-applier`
Source: [GitHub issue #7](https://github.com/yuens1002/openclaw-control-plane/issues/7)
"Automate post-install /setup configuration from a client profile," filed
2026-08-14.

## Summary

Close the gap between the shell Railway install
(`deploy/openclaw-railway/install-template.ps1` →
`packages/openclaw-railway-installer`) and a fully configured OpenClaw
instance. Today a human must open `/setup` in a browser and fill in the
onboarding wizard by hand. This plan builds an applier that reads a
generated client profile, resolves secrets from Railway variables (minting
an OpenRouter provisioning key when the profile calls for one), and drives
the live instance's `/setup` JSON API to the same end state — idempotently,
and without ever logging or persisting a secret value.

This is the capability the README already reserves a place for: "a clean
place to define setup-profile conventions that private agency/client repos
can use to automate provider, channel, plugin, and workflow attachment"
(README.md:28). It ships as reusable core, not a client-specific example,
because the profile *shape* it consumes is generic — no client identity,
workflow, or credential is baked in.

## Current State

- The installer (`packages/openclaw-railway-installer/src/index.ts`,
  `installOpenClawOnRailway`) deploys the Railway template, healthchecks
  `/setup/healthz`, and writes local handoff files. It stops there —
  `/setup`'s onboarding wizard is never called.
- `/setup` exposes a JSON API (`GET /setup/api/status`,
  `GET /setup/api/auth-groups`, `POST /setup/api/run`,
  `GET`/`POST /setup/api/config/raw`, `POST /setup/api/reset`, pairing and
  device endpoints), confirmed against a live proof instance and documented
  in issue #7.
- A private agency/client profile repo (issue #7's originating example is
  not accessible from this repo, and this plan does not depend on any one
  such repo) generates a client profile whose
  `attachments.modelProviders` / `attachments.channels` carry
  `nonSecretConfig` (`authGroup`, `authChoice`, `flow` for providers; channel
  type for channels) plus `requiredSecretNames` — the exact Railway variable
  names holding the secrets `/setup/api/run` needs. One provider attachment
  may carry `nonSecretConfig.keyProvisioning: { method:
  "openrouter-provisioning-api", spendLimitUsd, limitReset }`, signaling that
  its secret must be minted via OpenRouter's Provisioning API before it
  exists anywhere.
- No code in this repo talks to a client profile, the `/setup` API, or the
  OpenRouter Provisioning API today. Railway variables are currently only
  *written* by the installer, via `railway deploy -v K=V`; nothing in this
  repo reads back an existing Railway variable's value.
- No secret-redaction or never-log convention exists in this repo yet. The
  installer's existing convention is the opposite: it prints the generated
  setup password to stdout and writes it to `.env.local` and a local handoff
  file. This plan deliberately diverges from that convention for the values
  it handles, because the values here are third-party provider/channel
  credentials, not a value this repo minted for its own local use.

## Approach

Build a new package, `packages/openclaw-setup-applier`, following the
`packages/openclaw-railway-installer` conventions already in the repo:
dependency-injected external calls (Railway CLI runner, `fetch`), a plain
orchestration function, a `tsx` CLI entrypoint. Add the profile schema to
this new package rather than `packages/contracts` — `contracts` holds
control-plane runtime shapes with multiple internal consumers; this schema
has exactly one consumer and describes an external repo's output format
(similar reasoning to why `contracts/src/vending.ts` was removed in
`ddaf8d2`). Parse the profile tolerantly (`.passthrough()`, validate only
the fields the applier consumes) so an unrelated field added upstream never
breaks parsing — only a *missing* field the applier needs should fail, with
the actual field path in the error.

Split the work into two sessions along a risk seam, not a module seam:
Session 1 builds every non-mutating path (schema, `GET` calls, Railway
variable *read*, a `--dry-run` mode that resolves and prints a redacted
payload) so it can be verified safely against the live proof instance and
gives other agencies a safe on-ramp. Session 2 adds every mutating path
(OpenRouter key minting, Railway variable *write*, `POST /setup/api/run`,
`POST /setup/api/reset`) plus the secret-safety guarantees, behind the
orchestrator and CLI.

## Deliverables (with spec-role assignment)

| ID | Deliverable | Kind | Owning role | Session |
| --- | --- | --- | --- | --- |
| D1 | `packages/openclaw-setup-applier/src/profile-schema.ts` — tolerant Zod schema for the generated client profile (`attachments.modelProviders`/`channels`, `nonSecretConfig.{authGroup,authChoice,flow}`, `requiredSecretNames`, `keyProvisioning.{method,spendLimitUsd,limitReset}`); unknown fields pass through, only consumed fields are validated | schema | `/backend-architect` | 1 |
| D2 | `packages/openclaw-setup-applier/src/setup-api-client.ts` — non-mutating calls: `GET /setup/api/status`, `GET /setup/api/auth-groups` | client | `/backend-architect` | 1 |
| D3 | `packages/openclaw-setup-applier/src/railway-variables.ts` — read path: resolve a named variable's value on the target Railway service | client | `/devops` | 1 |
| D4 | `packages/openclaw-setup-applier/src/apply-profile.ts` — `--dry-run` mode: parse profile, resolve which secrets exist vs. are missing, build the would-be `/setup/api/run` payload, print it with secret values redacted; no network mutation | orchestrator | `/backend-architect` | 1 |
| D5 | `fixtures/setup-profile/` — fake/manual example client profiles (one plain-secret provider, one `keyProvisioning` provider, one channel) with sentinel secret values, following the `fixtures/vending` convention | fixture | `/test-engineer` | 1 |
| D6 | `tests/openclaw-setup-applier-*.test.ts` — unit tests for D1–D4: schema tolerance (unknown field passes, missing consumed field fails with field path), setup-api-client read calls, railway-variables read, dry-run payload redaction | test | `/test-engineer` | 1 |
| D7 | Workspace wiring — `tsconfig.json` project reference, `tsconfig.base.json` path alias, `tests/tsconfig.json` reference, root `package.json` script for the CLI | config | `/devops` | 1 |
| D8 | `docs/setup-profile-applier.md` — feature doc: what the applier does, the profile shape it consumes, required env vars, dry-run-first usage, and an explicit warning not to call `/setup/api/run` or `/setup/api/reset` against a live instance except through this applier's tested code path | doc | `/project-manager` | 1 |
| D9 | `docs/plans/setup-profile-applier/plan.md` — this plan | doc | `/project-manager` | 1 |
| D10 | `docs/plans/setup-profile-applier/ACs.md` — structured AC table with Plan-ref and Role columns | doc | `/project-manager` | 1 |
| D11 | `packages/openclaw-setup-applier/src/openrouter-provisioning.ts` — mint a scoped key via OpenRouter's Provisioning API (`POST /api/v1/keys`) using an agency-held management key, matching the profile's `spendLimitUsd`/`limitReset` | client | `/backend-architect` | 2 |
| D12 | `packages/openclaw-setup-applier/src/railway-variables.ts` — write path: set one variable on the target Railway service | client | `/devops` | 2 |
| D13 | `packages/openclaw-setup-applier/src/setup-api-client.ts` — mutating calls: `POST /setup/api/run`, `POST /setup/api/reset` | client | `/backend-architect` | 2 |
| D14 | `packages/openclaw-setup-applier/src/apply-profile.ts` — full orchestration: idempotency checks, mint-if-needed, write variable, re-healthcheck, call `run`, verify via `status`; secret values never logged or persisted beyond the call that needs them | orchestrator | `/backend-architect` | 2 |
| D15 | `packages/openclaw-setup-applier/src/cli.ts` — `tsx` CLI entrypoint exposing `--dry-run` and apply modes, following `packages/openclaw-railway-installer/src/cli.ts` conventions | cli | `/devops` | 2 |
| D16 | Secret-safety verification — sentinel secret values from D5's fixtures never appear in captured stdout/stderr or any file written during a full `apply-profile` run | security-audit | `/security` | 2 |
| D17 | `tests/openclaw-setup-applier-*.test.ts` — unit tests for D11–D15: OpenRouter mint (fetch-stubbed only, real API never called), Railway variable write (`FakeRailwayRunner`), mutating setup-api-client calls, both idempotency branches, CLI | test | `/test-engineer` | 2 |
| D18 | `.env.example` — placeholder entries for new env vars (e.g. `OPENROUTER_MANAGEMENT_KEY`); no real values or IDs | config | `/devops` | 2 |
| D19 | `README.md`, `docs/architecture.md`, `docs/setup-profile-applier.md` — replace the aspirational "a clean place to define setup-profile conventions" line with a concrete pointer to the applier; add the package to the architecture package list; document the dry-run-first workflow for other agencies | doc | `/project-manager` | 2 |
| D20 | Verification suite — `npm run typecheck`, `npm test`, `npm run build`, `npm audit --omit=dev` clean for the full feature | test | `/test-engineer` | 2 |
| D21 | `docs/plans/setup-profile-applier/review.md` — final review scaffold and record | doc | `/project-manager` | 2 |

### Design decisions carried into Implement

- **Idempotency rule** (D14): `GET /setup/api/status` reporting configured
  means skip `POST /setup/api/run` entirely. A declared secret name already
  present in Railway variables means skip OpenRouter minting for that
  attachment — variable presence is the proxy for "already minted," not a
  query against OpenRouter for existing keys.
- **Railway CLI commands** (D3, D12), confirmed locally with
  `railway variable --help` (Railway CLI 5.40.0): read via
  `railway variable list --service <service> --json` (raw values included in
  JSON — never printed); write via
  `railway variable set KEY=VALUE --service <service> --skip-deploys --json`.
  `--skip-deploys` is the default for D12's writes.
- **Ordering** (D14): `--skip-deploys` means most writes (the values that go
  directly into the `POST /setup/api/run` payload — `authSecret`, channel
  tokens) never need a restart, because the applier passes the value it just
  minted or read straight into the payload; it never re-reads it back from
  the running process's environment. The one exception is
  `customProviderApiKeyEnv`: that field names an env var the *running
  OpenClaw process* must resolve itself, so a variable feeding it must be
  written **without** `--skip-deploys`, and the applier must re-run the
  existing `/setup/healthz` healthcheck (already implemented in the
  installer) before calling `POST /setup/api/run` for that path, so the call
  doesn't race the restart.
- **Error shapes** (D2, D13): follow `openclaw-adapter`'s convention — thrown
  errors carry only the HTTP status, never the request or response body.
  Zod validation failures report the failing field path, never the field's
  value.
- **Secret-safety divergence** (D14, D16): this package does not follow the
  installer's print-and-write-locally convention for the values it handles,
  and it writes no local files at all — its only outputs are stdout (with
  every secret field redacted, in both `--dry-run` and apply modes) and the
  network calls each secret value serves.

### Files to Create

| File | Purpose |
| --- | --- |
| `packages/openclaw-setup-applier/package.json`, `tsconfig.json`, `src/*.ts` | New package implementing D1–D4, D11–D15 |
| `fixtures/setup-profile/*.json` | Fake/manual example profiles for D5 |
| `tests/openclaw-setup-applier-profile-schema.test.ts` | D6 — schema tolerance cases |
| `tests/openclaw-setup-applier-setup-api-client.test.ts` | D6 (read cases), D17 (mutating cases added) |
| `tests/openclaw-setup-applier-railway-variables.test.ts` | D6 (read cases), D17 (write cases added) |
| `tests/openclaw-setup-applier-apply-profile.test.ts` | D6 (dry-run cases), D17 (full-apply + idempotency cases added) |
| `tests/openclaw-setup-applier-openrouter-provisioning.test.ts` | D17 — mint cases, fetch-stubbed only |
| `tests/openclaw-setup-applier-cli.test.ts` | D17 — CLI argument parsing |
| `docs/setup-profile-applier.md` | D8 |
| `docs/plans/setup-profile-applier/plan.md`, `ACs.md`, `review.md` | D9, D10, D21 |

### Files to Edit

| File | Change |
| --- | --- |
| `tsconfig.json` | Add project reference for the new package |
| `tsconfig.base.json` | Add path alias for the new package |
| `tests/tsconfig.json` | Add reference so tests resolve the new package |
| `package.json` | Add a script for the applier CLI |
| `.env.example` | Add placeholder env vars, no real values |
| `README.md` | D19 positioning update |
| `docs/architecture.md` | Add `packages/openclaw-setup-applier` to the package list |

## Sessions

| Session | Scope (deliverable IDs) | ACs |
| --- | --- | --- |
| Session 1 (non-mutating) | D1–D10 | `docs/plans/setup-profile-applier/ACs.md` |
| Session 2 (mutating) | D11–D21 | `docs/plans/setup-profile-applier/ACs.md` |

## Acceptance Criteria

See `docs/plans/setup-profile-applier/ACs.md`. Every AC row carries a Plan
ref and owning Role so coverage can be checked against this deliverables
table.

## Gate 1/2 Pre-Check

- Gate 1 coverage: Manual check required in this repo — no
  `scripts/check-acs-coverage.ts` exists yet (same as
  `docs/plans/open-source-readiness/plan.md`). Every deliverable D1–D21
  must have at least one AC row before implementation proceeds.
- Gate 2 anti-drift: Manual check required. AC Pass cells must state
  invariants (e.g. "sentinel value absent from all captured output"), never
  a config-literal equality pinning a fixture string.

## Commit Schedule

1. Plan + ACs commit: `docs: add setup profile applier plan`
2. Session 1 implementation: `feat: add setup profile applier read/dry-run path`
3. Session 1 verification: `test: verify setup profile applier dry-run path`
4. Session 2 implementation: `feat: add setup profile applier mutating path`
5. Session 2 verification: `test: verify setup profile applier end to end`
6. Review: `docs: record setup profile applier review`

## Dependencies

- ~~**Hard blocker before Session 1 Implement starts**: validate
  `profile-schema.ts` (D1) against at least one real profile generated by a
  private agency/client profile repo.~~ **Resolved.** Validated D1 against
  two real generated profiles (a managed tier and a BYOK tier) supplied by
  the human running this plan. The model-provider shape (issue #7's
  reconstruction) matched exactly, including `keyProvisioning`. The channel
  shape did not: the reconstruction invented `nonSecretConfig.channelType`,
  but real profiles carry a top-level `type` field on each channel
  attachment with no `nonSecretConfig` at all. Fixed in `profile-schema.ts`,
  `apply-profile.ts`, `fixtures/setup-profile/channel.json`, and
  `docs/setup-profile-applier.md`; both real profiles now parse (confirmed
  by running D1's built schema against them directly, not just by
  inspection), and the full test suite (11 files, 48 tests) still passes.
  D1's tolerant `.passthrough()` design held up as intended — the real
  documents carry many more top-level and `attachments`-level fields
  (`environments`, `setupPhases`, `businessPractices`, `pluginPacks`,
  `clientConnectors`, `workflows`, `verification`, `handoff`, `security`,
  `agency`, `client`, `repository`, `controlPlane`) than issue #7 described,
  and none of them broke parsing.
- Before D2/D13 are implemented: re-verify the `authGroup`/`authChoice`
  enum via a live, read-only `GET /setup/api/auth-groups` call against the
  existing Railway proof instance (issue #7 flags the moonshot/z.ai/minimax/
  qwen/copilot/synthetic/opencode-zen slugs as unconfirmed).
- An agency-held OpenRouter management key and Railway API token with access
  to the target service, supplied via env var at run time — never committed.
- Human approval of this plan before implementation continues.

## Out of Scope

- A public-facing web form or landing page that triggers the applier (issue
  #7: needs its own trust/auth model, separate future work).
- Client-owned Railway accounts or billing.
- Treating the `authGroup` enum list in this plan as final without the
  live re-verification named under Dependencies.
- An automated CI workflow that calls the mutating `/setup/api/run` or
  `/setup/api/reset` endpoints, or the real OpenRouter Provisioning API,
  against a live instance. Tests use fakes/stubs only; a live smoke test
  analogous to `railway-proof:verify` is future work, not this plan.
- `deploy/openclaw-setup-applier/apply-profile.ps1` or any PowerShell
  wrapper — the CLI (D15) is the only entrypoint this plan ships.
- Changing `install-template.ps1` or the existing installer's shell-install
  behavior.
- Logging or persisting any secret value beyond the single API call that
  needs it (this is a constraint, not a scope item — called out here because
  it bounds what D14/D16 are allowed to build).
