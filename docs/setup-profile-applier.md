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

The two endpoints are not equally available, and this rule is the floor for
`run` rather than the whole story for `reset`. `POST /setup/api/run` has a
legitimate tested caller: `applyProfile`. `POST /setup/api/reset` has none.
[`docs/live-instance-operations.md`](live-instance-operations.md) classifies
the reset endpoint as **destructive**, and the rule for that tier is
Forbidden outright — not gated, not confirmed, not available — so there is
no "tested code path" exception for it to reach. This package's setup API
client therefore exposes **no** `reset()` method: it was removed rather than
gated, because a gate around a capability nothing calls protects nothing
while leaving it one call away. The endpoint still exists on the instance;
nothing in this repo offers a way to reach it.

That is the specific rule for these two endpoints. The general rule it is
an instance of — how any operator (this repo's code, a human at a
terminal, or an agent mid-session) may read or write state on an
already-provisioned instance, including the classification these
endpoints fall under and the pre-flight declaration required before any
ad hoc command — lives in
[docs/live-instance-operations.md](live-instance-operations.md).

## What it consumes

A **client profile**: a JSON document produced by a private agency/client
profile repo (this package does not depend on any one such repo — the
schema is intentionally tolerant of fields it doesn't recognize). The
fields this applier reads:

- `attachments.modelProviders[]` / `attachments.channels[]` /
  `attachments.mcpServers[]` — one entry per provider, channel, or MCP server
  to attach. All three default to an empty array when omitted.
- For providers, each attachment's `nonSecretConfig`: `authGroup`,
  `authChoice`, `flow` (`quickstart` | `advanced` | `manual`), and an
  optional `keyProvisioning` block (`method: "openrouter-provisioning-api"`,
  `spendLimitUsd`, `limitReset`) signaling that the attachment's secret must
  be minted rather than supplied. For channels, a top-level `type` field
  (e.g. `"slack"`, `"telegram"`) — channels carry no `nonSecretConfig`. For
  MCP servers, `name` (identifies the server), `transport` (a free string,
  e.g. `"http"`, `"sse"`, `"stdio"` — not an enum, matching how `channels[].type`
  is not an enum of known channel names) and an optional `url` (the
  connection endpoint for a network transport; omitted for a locally-launched
  one).
- Each attachment's `requiredSecretNames[]` — the exact Railway variable
  names holding the secrets this profile needs. The profile never contains
  a secret *value*, only the *name* of the Railway variable that holds it.

`attachments.mcpServers[]` is a schema-only capability today: this package
parses and validates it like any other attachment, but neither the dry-run
nor apply path reads or acts on it yet — declaring one has no effect until a
future change wires a consumer. It intentionally declares no fixed server
name or vocabulary: any MCP server a profile wants an OpenClaw instance to
use, a company's own runtime engine included, is expressed the same way.

`/setup/api/run` only accepts three channel `type`s, confirmed live against
the real wizard's own request-building source: `"telegram"` and
`"discord"` (1 required secret name each) and `"slack"` (exactly 2 —
`requiredSecretNames[0]` is the bot token, `[1]` is the app token, an
ordering convention, not independently confirmed live). Any other `type`,
or more than one attachment of the same `type`, fails loudly before any
network call — the underlying OpenClaw CLI supports many more channel
types (see `channels add --help`), but only these three are settable
through this specific endpoint.

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
| `OPENCLAW_INSTANCE_SETUP_PASSWORD` | The *target OpenClaw instance's* setup password, used for HTTP Basic auth on every `/setup/api/*` call. Required by the CLI's apply path. Programmatic use of `applyProfile()`/`createSetupApiClient()` only needs it when the target instance is Basic-auth protected — `auth` on `SetupApiClientOptions` is optional, and dry-run never calls the instance's HTTP API at all. |
| `OPENCLAW_INSTANCE_SETUP_USERNAME` | Basic auth username for the target instance. Optional, defaults to `openclaw`. |

These are deliberately **not** named `SETUP_PASSWORD`/`OPENCLAW_SETUP_USERNAME`:
an OpenClaw instance's *own* setup auth gate reads those exact names (see the
wrapper patch in this repo's `Dockerfile` and
`deploy/openclaw-railway/.env.example`). Reusing the names would make "the
instance I am running on" and "the instance I am configuring" indistinguishable
whenever this CLI runs in the same environment as an instance — including the
normal case of using this repo to bootstrap its own agency instance from a
profile of itself.

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

Dry-run **throws**, rather than printing a misleading preview, if the
profile's channel attachments couldn't actually be applied (an unsupported
channel `type`, more than one attachment of the same `type`, or a `slack`
attachment without exactly 2 `requiredSecretNames`) — the same validation
the apply path runs, run early on purpose, since dry-run exists to catch
exactly this kind of problem before a live call.

## Apply usage

```ts
import { applyProfile } from "@openclaw-control-plane/openclaw-setup-applier/apply-profile";
import { createSetupApiClient } from "@openclaw-control-plane/openclaw-setup-applier/setup-api-client";
import { requireEnv } from "@openclaw-control-plane/openclaw-setup-applier/cli";

const setupApiClient = createSetupApiClient({
  baseUrl: "https://your-instance.example.com",
  // Required whenever the target instance has SETUP_PASSWORD set (the
  // normal/recommended setup) — omit `auth` entirely only against an
  // unprotected instance. requireEnv() throws a clear
  // "Missing required env var: ..." message instead of a confusing
  // runtime failure if the var isn't set, unlike a `!` non-null assertion.
  auth: {
    username: process.env.OPENCLAW_INSTANCE_SETUP_USERNAME ?? "openclaw",
    password: requireEnv("OPENCLAW_INSTANCE_SETUP_PASSWORD")
  }
});
const result = await applyProfile(
  profileJson,
  { service: "your-railway-service-name", instanceBaseUrl: "https://your-instance.example.com" },
  { runner: yourRailwayRunner, setupApiClient, openRouterManagementKey: requireEnv("OPENROUTER_MANAGEMENT_KEY") }
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

The `/setup/api/run` payload is **flat**, not an array of attachments: one
optional field per supported channel `type`
(`telegramToken`/`discordToken`/`slackBotToken`/`slackAppToken`), plus
`authChoice` (not `authGroup` — that's UI-grouping-only in the real
wizard), `flow`, `authSecret`, and the `customProvider*` fields. Multiple
channels are set by filling multiple fields in one call, not multiple
calls. Confirmed live — see
`docs/plans/setup-run-payload-contract/plan.md`'s Live Confirmation.
