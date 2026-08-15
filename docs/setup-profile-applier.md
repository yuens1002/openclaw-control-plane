# Setup Profile Applier

Automates driving a live OpenClaw instance's `/setup` JSON API from a
generated client profile, closing the gap between the shell Railway install
(`deploy/openclaw-railway`) and a configured instance. See
[docs/plans/setup-profile-applier/plan.md](plans/setup-profile-applier/plan.md)
for the full plan; this doc is the operator-facing reference.

This package (`packages/openclaw-setup-applier`) implements both a
non-mutating dry-run path and the mutating apply path. **Start with
dry-run.** It parses a profile, checks which required secrets already exist
as Railway variables, and previews the would-be `/setup/api/run` payload
with every secret field redacted, making no network mutation of any kind —
that's the safe way for any agency to sanity-check a profile before running
it for real.

The apply path mints an OpenRouter key when a `keyProvisioning` attachment's
secret doesn't already exist, writes it to Railway, and calls
`POST /setup/api/run` against the live instance. It is idempotent: calling
it against an already-configured instance is a no-op (no `run` call), and
calling it when a secret was already minted on a prior run skips minting
again (variable presence is the proxy for "already minted").

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
| `OPENROUTER_MANAGEMENT_KEY` | Agency-held OpenRouter management key, used only by the apply path's key-minting step |

A Railway API token with access to the target service is also required for
the apply path; it is supplied at run time, never committed.

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
of the payload the apply path would send. No secret value is ever included
in the result or in what gets printed — only presence/absence per required
secret name.

## Apply usage

```ts
import { applyProfile } from "@openclaw-control-plane/openclaw-setup-applier/apply-profile";
import { createSetupApiClient } from "@openclaw-control-plane/openclaw-setup-applier/setup-api-client";

const setupApiClient = createSetupApiClient({ baseUrl: "https://your-instance.example.com" });
const result = await applyProfile(
  profileJson,
  { service: "your-railway-service-name", instanceBaseUrl: "https://your-instance.example.com" },
  { runner: yourRailwayRunner, setupApiClient, openRouterManagementKey: process.env.OPENROUTER_MANAGEMENT_KEY! }
);
console.log(result.outcome); // "already-configured" | "applied"
```

Or via the CLI:

```bash
npm exec -- tsx packages/openclaw-setup-applier/src/cli.ts \
  --profile ./profile.json --service your-railway-service-name \
  --instance-url https://your-instance.example.com [--dry-run]
```

(Matches the `tsx`-based invocation convention `deploy/openclaw-railway/install-template.ps1` already uses for
`packages/openclaw-railway-installer/src/cli.ts` — `tsx` is an existing devDependency, unlike Node's
`--experimental-strip-types` flag, which isn't available on every Node version this repo supports.)

## Secret-safety

This package writes no local files. Its only outputs are stdout (with every
secret-bearing field redacted, in both dry-run and apply modes — the apply
path prints only its outcome, `"already-configured"` or `"applied"`, never
a resolved or minted value) and the network calls each secret value serves.
This is a deliberate departure from
`packages/openclaw-railway-installer`'s convention of printing generated
values to stdout and writing them to `.env.local`/handoff files — the
values this package handles are third-party provider/channel credentials,
not values it minted for its own local use.

Railway variable writes pipe the value via `--stdin`, never as an inline
`KEY=VALUE` argument, so it never lands in shell history or a process
listing.

**Open, non-blocking caveat:** the exact `/setup/api/run` payload shape for
multiple channel attachments (and the `authGroup`/`authChoice` enum) is not
independently confirmed against a live instance — see
`docs/plans/setup-profile-applier/plan.md`'s Dependencies section and
`review.md`'s residual risk notes before relying on this against production
traffic.
