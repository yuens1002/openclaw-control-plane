# Setup Profile Applier

Automates driving a live OpenClaw instance's `/setup` JSON API from a
generated client profile, closing the gap between the shell Railway install
(`deploy/openclaw-railway`) and a configured instance. See
[docs/plans/setup-profile-applier/plan.md](plans/setup-profile-applier/plan.md)
for the full plan; this doc is the operator-facing reference.

**Current status: dry-run only.** This package
(`packages/openclaw-setup-applier`) currently implements the non-mutating
path — parsing a profile, checking which required secrets already exist as
Railway variables, and previewing the would-be `/setup/api/run` payload. It
does not yet mint keys, write Railway variables, or call `/setup/api/run` /
`/setup/api/reset` — that mutating path is a later addition to this same
package, gated behind its own review because it touches live instance state
and billable third-party APIs.

## Do not call the mutating `/setup` endpoints yourself

`/setup` exposes `POST /setup/api/run` and `POST /setup/api/reset`. Both
mutate a live instance's configuration (`POST /setup/api/reset` deletes the
config file outright). **Do not call either endpoint against a live
instance except through this applier's own tested code path.** Calling them
by hand, from a script, or from an ad-hoc HTTP client bypasses the
idempotency and ordering guarantees this package is built to provide.

## What it consumes

A **client profile**: a JSON document produced by a private agency/client
profile repo (this package does not depend on any one such repo — the
schema is intentionally tolerant of fields it doesn't recognize). The
fields this applier reads:

- `attachments.modelProviders[]` / `attachments.channels[]` — one entry per
  provider or channel to attach.
- For providers, each attachment's `nonSecretConfig`: `authGroup`,
  `authChoice`, `flow` (`quickstart` | `advanced` | `manual`), and an
  optional `keyProvisioning` block (`method: "openrouter-provisioning-api"`,
  `spendLimitUsd`, `limitReset`) signaling that the attachment's secret must
  be minted rather than supplied. For channels, a top-level `type` field
  (e.g. `"slack"`, `"telegram"`) — channels carry no `nonSecretConfig`.
- Each attachment's `requiredSecretNames[]` — the exact Railway variable
  names holding the secrets this profile needs. The profile never contains
  a secret *value*, only the *name* of the Railway variable that holds it.

A real profile also carries a top-level `environments[].requiredSecretNames`
list — this is a broader rollup (infra secrets like `RAILWAY_TOKEN` plus
every attachment's secrets combined) and is **not** what this applier reads;
it only ever consumes the per-attachment `requiredSecretNames[]` under
`attachments.modelProviders[]` / `attachments.channels[]`.

See `fixtures/setup-profile/` for example profiles (sentinel values only,
no real credentials).

## Required env vars

| Var | Purpose |
| --- | --- |
| `OPENROUTER_MANAGEMENT_KEY` | Agency-held OpenRouter management key, used only by the mutating path's key-minting step (not yet implemented) |

A Railway API token with access to the target service is also required for
the mutating path; it is supplied at run time, never committed.

## Dry-run usage

```ts
import { dryRunApplyProfile, printDryRunResult } from "@openclaw-control-plane/openclaw-setup-applier/apply-profile";

const result = await dryRunApplyProfile(
  profileJson,
  { service: "your-railway-service-name" },
  { runner: yourRailwayRunner }
);
printDryRunResult(result);
```

Dry-run makes no network mutation: it only reads Railway variables (to
report which required secrets already exist) and prints a redacted preview
of the payload the mutating path would eventually send. No secret value is
ever included in the result or in what gets printed — only presence/absence
per required secret name.

## Secret-safety

This package writes no local files. Its only outputs are stdout (with every
secret-bearing field redacted) and, once the mutating path lands, the
network calls each secret value serves. This is a deliberate departure from
`packages/openclaw-railway-installer`'s convention of printing generated
values to stdout and writing them to `.env.local`/handoff files — the
values this package handles are third-party provider/channel credentials,
not values it minted for its own local use.
