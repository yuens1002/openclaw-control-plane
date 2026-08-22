# OpenClaw on Railway

Use OpenClaw's Railway-recommended template instead of deploying the raw
`ghcr.io/openclaw/openclaw` image directly. The template runs a Railway wrapper
that listens on the public port, stores state on `/data`, serves `/setup`, and
proxies the Control UI at the root path `/`.

> **Canonical Control UI URL is `/`, not `/openclaw`.** The application's
> `gateway.controlUi.basePath` is unset (its documented default), so the Control
> UI is root-mounted. A prefixed URL such as `/openclaw` may appear to load, but
> only through the SPA fallback serving `index.html` for unmatched navigations;
> its manifest, icons, service worker, and bootstrap config all 404 under that
> prefix. Earlier revisions of this document claimed `/openclaw` was the served
> path — that claim was wrong, and nothing in this repo ever set a base path.
> See `docs/plans/live-instance-operations/mount-analysis.md`.

## One-Command Install

From a Railway-linked project directory:

```powershell
.\deploy\openclaw-railway\install-template.ps1
```

The script:

- deploys the `clawdbot-railway-template` marketplace template
- generates `SETUP_PASSWORD` and `OPENCLAW_GATEWAY_TOKEN`
- reuses an existing healthy template service on rerun
- waits for the newest deployment to reach `SUCCESS`
- updates the generated Railway domain to target port `8080`
- polls the auth-gated `/setup/api/status` (with the newly generated setup
  credentials) as the readiness signal, not the unauthenticated
  `/setup/healthz` — a container mid-transition can return `200` on
  `/setup/healthz` before the new credentials are actually live
- patches `gateway.controlUi.allowedOrigins` to include the instance's own
  Railway domain, since it has no environment-variable override and isn't
  auto-seeded for a Railway-style reverse-proxied deployment (this is the
  confirmed cause of the dashboard's "origin not allowed" error, not `PORT`)
- approves the installer's own device pairing request if exactly one is
  pending (first-time browser/device connections require pairing approval
  even with a correct `OPENCLAW_GATEWAY_TOKEN`); a client's own first real
  browser login still triggers its own separate, per-device pairing request
- writes `.env.local` and `openclaw-railway-handoff.local.md`
- prints the setup URL and setup password for the current run

These three post-deploy steps close out [issue #18](https://github.com/yuens1002/openclaw-control-plane/issues/18)
items 3, 4, and 5. Two related items from the same issue live elsewhere:
credential-write BOM safety, pre-deploy variable ordering, and the `railway
volume add` CLI panic workaround (items 1, 2, 7) are owned by the
agency-controlled client provisioning path (issue #16); seeding the agent's
identity/soul from a client profile (Part 2 of #18) is tracked separately in
issue #20, since its transport mechanism isn't live-tested yet and its
content half lives in the private client-profile repo.

### Workspace identity file transport (not yet wired in)

[Issue #20](https://github.com/yuens1002/openclaw-control-plane/issues/20)
splits ownership between the private `openClaw-CoT-agency-profile` repo
(the *content* — intake fields and templating the actual
`IDENTITY.md`/`USER.md`/`SOUL.md` markdown, tracked as that repo's own #3,
not yet done) and this repo (the *transport*).
`packages/openclaw-railway-installer/src/import-workspace-files.ts` ships
that transport half: `importWorkspaceFiles(baseUrl, auth, files)` packs a
workspace-relative file map into a `tar.gz` and `POST`s it to the wrapper's
`/setup/import` (the documented inverse of `GET /setup/export`), so a
client's `IDENTITY.md`/`USER.md`/`SOUL.md` can be seeded at apply time
instead of through the dashboard's interactive first-run Q&A. It is not
yet called from either provisioning path (`installOpenClawOnRailway` or
`provisionClientInstance`) — there's no real content to pass until
profile-repo #3 lands, and whether pre-seeding `IDENTITY.md` alone actually
updates the dashboard's displayed identity (versus needing
`openclaw agents set-identity --from-identity`, which isn't in the
wrapper's `ALLOWED_CONSOLE_COMMANDS` allowlist today) is still an open
question that needs a live test against real content.

This install path is intentionally a shell Chief of Staff install. It brings up
OpenClaw, setup auth, public routing, and persistent state, but it does not
install, enable, or assume any client-specific pipeline, connector, service, or
workflow. Client tools and workflows should be attached after the shell install
from the client's private source of truth.

The template source is an upstream runtime dependency of this public control
plane, not a client workflow repository. A Railway service connected to the
template can be used as a proof instance for the shell setup; client-specific
workflows or plugins should be connected separately after the baseline is
healthy.

For the public proof instance, prefer connecting Railway to
`yuens1002/openclaw-control-plane@main` and letting this repo's root
`railway.toml`/`Dockerfile` pull the pinned wrapper commit. That keeps the
public repo as the auditable Railway source while preserving the OpenClaw
runtime routes supplied by the wrapper:

- `/setup/healthz`
- `/setup`
- `/` (the Control UI)

The live proof should not be a deployment of the TypeScript API shell alone, and
it should not source `vignesh07/clawdbot-railway-template` directly except as the
pinned dependency declared in `template-lock.json`.

If Railway retains historical template metadata on a service that was originally
created from `vignesh07/clawdbot-railway-template`, treat that as provenance,
not active source ownership. The clean proof setup is a Railway service created
from, or reconnected directly to, `yuens1002/openclaw-control-plane@main`, with
no active upstream URL pointing at `vignesh07`. The `vignesh07` repo should
appear only as the pinned wrapper dependency in this repo's Dockerfile and lock
file.

## Agency-Controlled Client Provisioning (per-client version pinning)

`install-template.ps1` (above) and the public-proof `main`-tracked pattern
are each right for their own purpose, but neither gives the agency
independent control over *when* a specific client's wrapper version
updates:

- `install-template.ps1` deploys `vignesh07/clawdbot-railway-template`
  directly — the marketplace template's own update cadence, not the
  agency's.
- Pointing a client's Railway service at
  `yuens1002/openclaw-control-plane@main` (the public-proof pattern) would
  couple that one client's redeploy timing to control-plane's own unrelated
  day-to-day commits.

`provision-client.ps1` and `update-client-template-ref.ps1` close that gap
(see issue [#16](https://github.com/yuens1002/openclaw-control-plane/issues/16))
by deploying **this repo's own Dockerfile** per client via `railway up` —
a one-shot snapshot build, not
continuously tracked — with a per-client `OPENCLAW_TEMPLATE_REF` Railway
service variable overriding the Dockerfile's `ARG` default. Updating one
client's wrapper version is setting a new ref on that client's service and
redeploying; it never touches any other client's service, the marketplace
template, or control-plane's own `main`.

```powershell
.\deploy\openclaw-railway\provision-client.ps1 -ClientName acme
.\deploy\openclaw-railway\provision-client.ps1 -ClientName acme -ProjectId <existing-project-id>
.\deploy\openclaw-railway\provision-client.ps1 -ClientName acme -TemplateRef <commit-sha>

.\deploy\openclaw-railway\update-client-template-ref.ps1 -Service acme-openclaw -TemplateRef <new-commit-sha> -ExpectedCurrentRef <current-commit-sha>
```

`OPENCLAW_TEMPLATE_REF` defaults to this repo's own
`template-lock.json` → `pinnedCommit` when not passed explicitly.

`-ExpectedCurrentRef` is required on both update scripts. State the ref you
believe the service is currently on: the update reads the live value first,
does nothing at all when it already equals the ref you asked for (a redeploy
is downtime, so a no-op must not cause one), and aborts without writing when
the live value is neither the expected one nor the target. That makes it
impossible to redeploy a client without knowing what you are replacing. It
is a read-then-write check, not an atomic compare-and-swap, so it catches
drift that already existed rather than serialising two updates racing each
other. After the redeploy both scripts wait for the instance to answer an
*authenticated* request, not merely for the platform to report a finished
deployment.

Pass `-SetupUsername` if the client was provisioned with a non-default
setup username; the readiness check authenticates with it, and would
otherwise fail until timeout against a service that does not use the
default.

For a client's **first** OpenClaw version bump, pass `-ExpectedCurrentRef
'<unset>'`. Provisioning writes `OPENCLAW_TEMPLATE_REF` but not
`OPENCLAW_GIT_REF` — the application ref exists only as a Dockerfile
build-time default until the first bump sets it as a service variable — so
a freshly provisioned client genuinely has no current value to state. The
sentinel makes that an explicit declaration rather than a silent special
case: passing it against a service that *does* have a value is refused,
just like any other mismatch.

`OPENCLAW_TEMPLATE_REF` is a **different** pin from `OPENCLAW_GIT_REF`: the
template ref is the Railway wrapper/scaffold (`vignesh07/clawdbot-railway-template`)
that serves `/setup` and proxies to OpenClaw; `OPENCLAW_GIT_REF` is the
`openclaw/openclaw` application version actually running inside it, which
is what a connecting OpenClaw client (e.g. the mobile app) needs to match
for protocol compatibility. It defaults to the `ARG OPENCLAW_GIT_REF` value
baked into this repo's `Dockerfile` and, like the template ref, can be
overridden per client without touching any other service:

```powershell
.\deploy\openclaw-railway\update-client-openclaw-ref.ps1 -Service acme-openclaw -OpenClawRef v2026.7.1-2 -ExpectedCurrentRef v2026.6.0-1
```

Provisioning sets `PORT=8080`, `OPENCLAW_STATE_DIR=/data/.openclaw`, and
`OPENCLAW_WORKSPACE_DIR=/data/workspace` as explicit Railway service
variables even though the root `railway.toml` already declares an
equivalent `[variables]` block — `railway up` (a local snapshot build)
does **not** apply that block, so leaving these to it silently writes the
running instance's config to non-persistent container storage. Passing
`-ProjectId` on a rerun against an already-provisioned client is what
makes provisioning idempotent: it detects the existing service and skips
re-bootstrapping, and reuses the service's actual `SETUP_PASSWORD` rather
than generating (and overwriting) a new one.

Issue [#18](https://github.com/yuens1002/openclaw-control-plane/issues/18)
later corrected an earlier misattribution in #16: a BOM-corrupted `SETUP_PASSWORD` observed during
manual testing was caused by PowerShell's own `|` pipe operator injecting
a UTF-8 BOM into piped stdin, not Railway's dashboard "reveal variable"
UI. This provisioning path is unaffected — it writes secrets via Node's
`child_process.spawn` + `stdin.end()` from inside the installer process
itself, never through a PowerShell pipe.

No live Railway smoke test has been run against this path yet; it is
verified against a mocked Railway CLI (see `tests/openclaw-railway-provision-client.test.ts`
and `tests/openclaw-railway-update-client-ref.test.ts`).

## Onboarding Regression Pipeline

`onboarding-cycle` (see [issue #16](https://github.com/yuens1002/openclaw-control-plane/issues/16)
and [#18](https://github.com/yuens1002/openclaw-control-plane/issues/18)'s
follow-up dogfood work) turns the provisioning + apply chain above into a
reusable, schedulable regression check against a dedicated fixture instance
— proving the client-onboarding automation keeps working over time, without
leaving a live OpenRouter key standing between runs.

```bash
# One-time: provision the fixture (or reuse it if it already exists) and
# apply a profile to it. Leaves the minted OpenRouter key alive — a
# human-supervised verification step (e.g. a dashboard login) needs a
# working key. Delete it explicitly once that's done.
OPENROUTER_MANAGEMENT_KEY=<mgmt-key> \
  npm run onboarding-cycle -- bootstrap --client-name <fixture-name> --profile <path/to/profile.json>

npm run onboarding-cycle -- delete-key --hash <hash-printed-by-bootstrap>

# Recurring: mints a fresh key, verifies the fixture is still configured and
# healthy, and deletes the key again in a `finally` block — regardless of
# whether the check passed or failed. No browser step; safe to schedule
# unattended.
OPENROUTER_MANAGEMENT_KEY=<mgmt-key> \
OPENCLAW_INSTANCE_SETUP_PASSWORD=<fixture-setup-password> \
  npm run onboarding-cycle -- regression-check --service <fixture-name> --instance-url <https://fixture-domain> --profile <path/to/profile.json>
```

What `regression-check` proves: the OpenRouter mint/delete API still works,
and the fixture Railway service is still reachable and reports configured.
It does **not** prove a live chat response through the running gateway —
`/setup/api/run` is only ever called once, by `bootstrap`; a real dashboard
chat proof stays a human-supervised step, not something this unattended
check does.

**Accepted tradeoff, not a bug:** between scheduled runs, the fixture's
model-provider Railway variable holds the *previous* run's now-deleted key
value. That's fine — the fixture doesn't serve real traffic between runs,
and the value is overwritten (with a fresh, immediately-deleted key) on the
next run. No Railway project-delete capability exists in this toolchain
(neither in this package nor in Railway's own CLI/API surface used here),
so the fixture project itself is a standing target, reused indefinitely —
only the OpenRouter key has a per-run lifecycle.

## Template Pinning and Updates

This repo pins the verifiable upstream template ref in
`template-lock.json`. The weekly GitHub Action runs:

```bash
npm run railway-template:check
```

The end-state proof verifier runs:

```bash
npm run railway-proof:verify
```

Without Railway environment variables it checks the source-owned runtime
contract. With `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`,
`RAILWAY_SERVICE_ID`, and `RAILWAY_PROOF_URL`, it also checks the live Railway
deployment source, active runtime settings, active domain, and OpenClaw wrapper
endpoints.

The scheduled GitHub proof workflow sets `RAILWAY_PROOF_LIVE_REQUIRED=true`, so
missing Railway secrets/vars fail the workflow instead of silently falling back
to source-only checks. Configure repository secrets for the Railway IDs/token
and repository variable `RAILWAY_PROOF_URL` for autonomous weekly verification.

If the upstream ref has moved, the check fails and reports the pinned commit and
latest upstream commit. It does not update the lock automatically. Bump the lock
only after a Railway proof smoke confirms `/setup/healthz`, `/setup`, `/` (the
Control UI), domain/port behavior, and persistent `/data` state still work.

For an immutable proof instance, eject or mirror the upstream template into an
OpenClaw-controlled GitHub repo and point Railway at an approved branch such as
`openclaw-control-plane-approved`. Advance that branch only through a reviewed
PR after the smoke test passes.

The setup password is needed for HTTP Basic auth on `/setup` and on the Control
UI at `/` (use any username), or a correct
`Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>` is accepted as an alternative
-- see fix 3 below.

**Recurring browser sign-in prompt, even after entering the correct
password or verifying the gateway token**: three independent wrapper issues
cause this, all patched in this repo's `Dockerfile` (via `sed` against the
wrapper's `src/server.js` in the `template-source` build stage) so the fix
applies automatically on every future `OPENCLAW_GIT_REF` bump rather than
needing to be rediscovered per client:

1. `requireDashboardAuth` gates every route with Basic Auth by design, but
   browsers never attach cached Basic-Auth credentials to
   `<link rel="manifest">` or favicon fetches (a browser security rule, not a
   credential problem) -- so `/manifest.webmanifest`, favicons, and `sw.js`
   401 forever and the sign-in dialog re-fires every time the browser retries
   them, no matter what password is entered. Patched by exempting those known
   browser-managed static paths from the auth gate.
2. The bigger one: `attachGatewayAuthHeader` only injects the real OpenClaw
   gateway's Bearer token when no `Authorization` header is already present.
   Once a browser has cached dashboard Basic-Auth credentials for the origin
   (guaranteed -- `/setup` requires it), Chrome auto-attaches that cached
   header to *every* same-origin request, including the app's own `fetch()`
   calls -- satisfying `requireDashboardAuth`'s gate, then getting forwarded
   as-is to the gateway, which only understands `Bearer <token>` and rejects
   it. The app's frontend then shows its own sign-in prompt. Not scoped to
   one route -- confirmed live on `/control-ui-config.json`
   (`{"error":{"message":"Unauthorized"}}` even with valid dashboard
   credentials), and can hit any proxied request once the browser starts
   attaching cached credentials. Patched by always overwriting the
   `Authorization` header with the gateway's Bearer token before proxying,
   regardless of what the client sent to satisfy the wrapper's own gate.
3. `requireDashboardAuth` also only accepts the `Basic` scheme -- it rejects
   any other scheme outright, including a perfectly valid
   `Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>` the Control UI itself
   sends directly for its own API calls once paired (unlike WebSocket
   upgrades, regular `fetch()` calls can set custom headers, so the app
   doesn't rely on the wrapper's Basic-Auth caching for these at all).
   Confirmed live: with the gateway token verified correct in the app's own
   Control UI settings, calls like `/control-ui-config.json` kept 401'ing
   regardless, because the wrapper's gate simply didn't recognize `Bearer` as
   valid. Patched by accepting a correct `Bearer <OPENCLAW_GATEWAY_TOKEN>` as
   an alternative to dashboard Basic Auth.

Even with fix 3 landed, `/control-ui-config.json` kept flipping between `401`
and `200` for the *same* browser session within the same second -- confirmed
live in the request logs. That's a client-side bug in the OpenClaw app's own
(compiled/minified) frontend inconsistently attaching its Bearer token to
this frequently-polled call, not anything the wrapper or this repo controls.
Since its response body is confirmed non-sensitive (`assistantName`, avatar
status, local media paths -- no secrets) and it was the dominant real-world
source of the recurring popup, it's exempted from the Basic-Auth gate
entirely (added to the fix 1 path list above) rather than left to keep
re-triggering the browser's native challenge on every failed poll.

`/avatar/<agentId>` (e.g. `/avatar/main`) needed the same fix 1 treatment as
manifest/favicon, for the original browser-passive-fetch reason: confirmed
live it was `401` in 100% of real request-log samples, never once
succeeding -- consistent with an `<img>` tag load the browser never attaches
cached Basic-Auth to. Confirmed with valid credentials it currently `404`s
(no avatar configured yet), so nothing sensitive was ever exposed by
exempting it, and an avatar image wouldn't be sensitive once one is set
either. Matched by path prefix, not a literal path, since it's built from
the agent id.

Both local output files are ignored by git. They are handoff conveniences, not
source artifacts.

Useful options:

```powershell
.\deploy\openclaw-railway\install-template.ps1 -SetupUsername client-admin
.\deploy\openclaw-railway\install-template.ps1 -ForceNew
.\deploy\openclaw-railway\install-template.ps1 -NoLocalFiles
.\deploy\openclaw-railway\install-template.ps1 -HandoffPath "client-handoff.local.md"
```

## Secret-Bearing CLI Commands

`railway variable list --json`/`--kv` print raw secret values to stdout, with
no `--service` requirement and no confirmation prompt -- an unscoped run on a
machine whose Railway CLI is linked to a live project dumps that project's
real secrets to whatever is capturing the terminal (shell history, a log
file, a screen share). This has already caused a real secret-exposure
incident in this repo's history.

Never run `railway variable list`/`set` directly by hand. Use the guard
wrapper instead:

```bash
npm run railway-vars:guard -- variable list --service <name> --json --i-know-this-prints-secrets
```

The guard refuses to run without an explicit `--service`, and refuses to run
any `variable list` (in any output format, including the plain table --
Railway's docs confirm `--json`/`--kv` print raw values but say nothing about
whether the plain form masks them either) without
`--i-know-this-prints-secrets`. It never spawns the real `railway` CLI when
either check fails, so a rejected command never has a chance to print
anything.

That is the specific rule for these two Railway subcommands. The general
rule it is an instance of -- how any operator (this repo's code, a human
at a terminal, or an agent mid-session) may read or write state on an
already-provisioned instance, including the two-axis classification, the
prohibition on putting a secret in any command's argument string, and the
pre-flight declaration required before any ad hoc command -- lives in
[docs/live-instance-operations.md](../../docs/live-instance-operations.md).
Note that the guard covers direct human CLI invocation only: the
programmatic variable read/write helpers in
`packages/openclaw-railway-installer/src/railway-variables.ts` do not pass
through it (tracked as gap G4 in that document).

## Manual Install

> The `-v "NAME=VALUE"` form below puts secret values on the argument
> line, which
> [docs/live-instance-operations.md](../../docs/live-instance-operations.md)
> forbids against a live instance at every tier, including reads. It is
> shown here only as the raw fallback for standing up a brand-new
> throwaway service; prefer the guarded and programmatic paths above,
> which pipe values via stdin.

```powershell
railway deploy -t clawdbot-railway-template `
  -v "SETUP_PASSWORD=<generated-setup-password>" `
  -v "OPENCLAW_GATEWAY_TOKEN=<generated-gateway-token>"
```

After deployment, verify the service domain target port:

```powershell
railway domain list --service clawdbot-railway-template --json
railway domain update <domain> --service clawdbot-railway-template --port 8080 --json
```

Then open:

```text
https://<your-railway-domain>/setup
```

## Notes

- The template creates and mounts a Railway volume at `/data`.
- The wrapper healthcheck is `/setup/healthz`; public runtime status is `/healthz`.
- Do not deploy the raw OpenClaw image directly on Railway for this flow. It does
  not provide the wrapper behavior the hosted Control UI needs.
- Client installs should use a client-owned Railway project or workspace.
- Rotate temporary handoff credentials after onboarding if the client stores
  different long-term credentials.
