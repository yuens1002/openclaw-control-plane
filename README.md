# OpenClaw Control Plane

[![Railway Deploy Verify](https://github.com/yuens1002/openclaw-control-plane/actions/workflows/railway-deploy-verify.yml/badge.svg)](https://github.com/yuens1002/openclaw-control-plane/actions/workflows/railway-deploy-verify.yml)

OpenClaw Control Plane is a reusable TypeScript monorepo for durable business
workflows managed by OpenClaw through stable tools.

It is intentionally a workflow-neutral baseline. The public repo provides the
control-plane shell, contracts, persistence primitives, adapter patterns, Railway
installer, fake/manual examples, and tests. Client-specific workflows,
connectors, credentials, and automations are attached after onboarding from the
client's private source of truth.

## Why This Template

If you only want the fastest generic OpenClaw instance, use the recommended
OpenClaw Railway template directly. This repo is for teams that want OpenClaw on
Railway with source-controlled operating discipline around it.

The value here is not a replacement dashboard or a prebuilt client workflow.
OpenClaw still supplies `/setup`, login, and the `/openclaw` Control UI. This
repo supplies the governed install path around that runtime:

- pinned, auditable upstream OpenClaw Railway wrapper dependency
- weekly update detection without automatic production upgrades
- live Railway proof checks for source repo, runtime settings, domain port,
  deployment source, `/setup`, `/setup/healthz`, and `/openclaw`
- workflow-neutral starter-kit boundary with no baked-in client pipeline,
  connector, database, or secret assumptions
- a [setup profile applier](docs/setup-profile-applier.md) that private
  agency/client profile repos can target: it reads a generated profile,
  resolves or mints the secrets it declares, and drives OpenClaw's `/setup`
  API idempotently, so provider, channel, and plugin attachment is
  automated rather than a human filling in the wizard by hand
- handoff and verification discipline for repeatable client onboarding

Install the recommended template for speed. Install this template when you want
a reproducible, verifiable, agency-ready OpenClaw control-plane baseline.

## Status

This project provides a tested public foundation for authenticated typed work,
durable runtime state, and reproducible OpenClaw deployment. Production
connectors and client-specific assumptions remain intentionally out of scope.
The default runtime ships only workflow-neutral `example.*` registrations and
handlers; deployments inject their own consumer registrations and behavior.

## Architecture

OpenClaw manages the system; it does not become the system. This repository
provisions and configures OpenClaw instances and builds the wrapper image they
run as — it holds no runtime engine of its own.

- `packages/openclaw-railway-installer`: OpenClaw Railway template installer
  and agency-controlled per-client provisioning — see
  [deploy/openclaw-railway](deploy/openclaw-railway/README.md).
- `packages/openclaw-setup-applier`: reads a generated client profile and
  drives a live OpenClaw instance's `/setup` API idempotently — see
  [docs/setup-profile-applier.md](docs/setup-profile-applier.md).
- `workers/vending`: fake/manual example worker package.
- root `Dockerfile` + `scripts/*.mjs` + `railway.toml`: the wrapper image.
- `docs`: architecture, feature, and operations documentation.

See [docs/architecture.md](docs/architecture.md) for the full package and
deployment-topology breakdown.

## External MCP Attachments

A provisioned OpenClaw instance may attach an external MCP server —
independently versioned and deployed, and not code in this repo — declared
as a profile attachment like any other model provider or channel
(`attachments.mcpServers[]`; see
[docs/setup-profile-applier.md](docs/setup-profile-applier.md)) — never
through a workspace dependency. This repo does not name or depend on which
server, if any, a given instance attaches; that server's own architecture
and docs live in its own repository.

`attachments.mcpServers[]` is a schema capability only today: the setup-profile
applier parses and validates it, but no code path acts on it yet, so declaring
an MCP server in a profile does not by itself attach one. Wiring a consumer is
separate, still-unlanded work.

## Local Setup

```bash
npm install
npm test
npm run build
```

There is no local HTTP API to run in this repo; its packages are provisioning
tooling (CLIs and library code invoked by `tsx`) plus the wrapper image build.
See [docs/setup-profile-applier.md](docs/setup-profile-applier.md) for driving
a live OpenClaw instance's `/setup` API from a generated profile.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

The test suite covers the Railway installer and the setup-profile applier —
provisioning, template-lock checks, onboarding, and Railway variable guard
behavior — plus `openclaw-railway-wrapper-patches.test.ts` (23 tests) for the
wrapper's build-time patches (scoped state export, restart-gateway helper).
Live Railway smoke tests remain opt-in so normal CI does not create cloud
resources.

Workspace packages are marked `private: true` intentionally. The GitHub repo can
be public while npm publishing remains out of scope.

## OpenClaw on Railway

Use the OpenClaw-recommended Railway template flow in
[deploy/openclaw-railway](deploy/openclaw-railway/README.md). Do not deploy the
raw OpenClaw image directly for hosted Control UI installs; the template wrapper
handles setup, persistent `/data` state, public routing, and `/openclaw` proxying.
The Railway flow is a shell Chief of Staff install only: it does not install or
enable the vending vertical, location-spec automation, or any other
client-specific pipeline.

The Railway template source, currently `vignesh07/clawdbot-railway-template`, is
treated as an upstream runtime/template dependency. This repo can document or
orchestrate that baseline install, but client workflows and plugins should live
outside the public baseline and be connected afterward.

The installer writes local handoff values to ignored files such as `.env.local`
and `openclaw-railway-handoff.local.md`.

For the public proof instance, the Railway service source should point at this
repo's `main` branch. The root `railway.toml` and `Dockerfile` then govern the
runtime by pulling the pinned OpenClaw Railway wrapper from
`deploy/openclaw-railway/template-lock.json`. In other words, the Railway
dashboard can show this public repo as the source while `/setup` and `/openclaw`
still come from OpenClaw.

### Scoped state export (`GET /setup/export?scope=state`)

The pinned wrapper's `GET /setup/export` archives all of the state directory
plus the workspace directory with no filter. This repo's `Dockerfile` adds a
build-time patch (`scripts/patch-wrapper-scoped-export.mjs`, logic in
`scripts/wrapper-state-export.mjs`) so the same route, with `?scope=state`,
returns only the state an instance needs restored. Auth is unchanged: the
route still sits behind the wrapper's setup password.

- **Contains** (relative to the state directory): `openclaw.json`,
  `exec-approvals.json`, `credentials/`, `devices/`, `cron/`, `identity/`,
  `memory/`, `state/`, and under `agents/<id>/agent/` only `*.sqlite`,
  `models.json`, and `auth-profiles*`. Every `*.sqlite` file is a consistent
  `VACUUM INTO` snapshot taken over a read-only `node:sqlite` connection, not
  a hot copy of a WAL-mode database.
- **Excludes**: `bin/`, `lib/`, `media/`, `logs/`, `backups/`, `sessions/`,
  `plugins/`, `codex-home/`, the workspace, `*-wal`/`*-shm` siblings,
  `*.bak*`/`*.migrated` leftovers, and any symlink or non-regular file.
  Measured on one instance during planning (read-only `du -sh`): the full
  state directory was 541 MB (`bin/` 415 MB, `agents/main/sessions/` 64 MB,
  `lib/` 32 MB) while the state subset was about 7 MB.
- **Archive layout**: gzip tar with paths as `.openclaw/...` relative to
  `/data`, the same shape the unscoped export uses, so the archive is a valid
  input for the wrapper's own `POST /setup/import` (which extracts under
  `/data` and never deletes existing files).
- **Size cap**: the subset is built in a temp directory and the request fails
  with `500` before any archive bytes stream if it exceeds
  `OPENCLAW_STATE_EXPORT_MAX_BYTES` (default 200 MiB; positive integer bytes).
  A missing `node:sqlite` also fails the request rather than degrading to an
  inconsistent copy.
- **Other scopes**: any other non-empty `scope` value returns `400`; no
  `scope` is the unmodified full export.

The same Dockerfile stage also replaces the wrapper's inline
`kill -> sleep(750)` gateway stop in `POST /setup/import` and
`restartGateway()` with one exit-confirmed helper
(`scripts/patch-wrapper-restart-gateway.mjs`). Both changes are proposed
upstream in
[docs/plans/wrapper-scoped-export-and-import-restart/upstream-issues.md](docs/plans/wrapper-scoped-export-and-import-restart/upstream-issues.md).

### GitHub webhook signature verification (`POST /hooks/github-webhook-verify`)

Neither upstream OpenClaw's generic `/hooks` gateway nor its bundled
`webhooks` plugin can verify a GitHub App webhook delivery: both authenticate
with a static shared secret compared against a request header, while GitHub
signs the raw body with HMAC-SHA256 and sends the digest in
`X-Hub-Signature-256`. This repo's `Dockerfile` adds a build-time patch
(`scripts/patch-wrapper-github-webhook.mjs`, logic in
`scripts/wrapper-github-webhook-verify.mjs`) that registers one new
wrapper-owned route, `POST /hooks/github-webhook-verify`, ahead of both the
wrapper's global JSON body parser and its catch-all proxy, so a request to it
is verified and answered here -- with its own raw-body read, before anything
else can consume the request stream -- and never reaches the OpenClaw
gateway. (Registering it after the body parser looks equivalent but isn't:
the parser drains the stream first, so the route's own body listeners never
fire and every request hangs to a timeout -- the anchor is deliberately the
body-parser line, not the later catch-all.)

The route and its `GITHUB_WEBHOOK_SECRET` env var are deliberately named
generically, not tied to any one deployed instance: this patch lands in the
shared wrapper image every provisioned instance builds from, and each
instance opts in independently, out of band from this repo, by setting its
own secret and registering its own App webhook URL. Until an instance sets
`GITHUB_WEBHOOK_SECRET`, the route responds `404` (before reading the body or
comparing any signature), so the change is inert by default. A valid
signature responds `200`; a missing or invalid one responds `401`. (The
handler also defends against a non-`POST` request with its own `405`, but
since it's registered via `app.post(...)`, Express's router already filters
to `POST` before the handler ever runs -- the `405` guard is unreachable
through this route today and exists only in case the handler is ever reused
behind a method-agnostic registration.) See
[issue #108](https://github.com/yuens1002/openclaw-control-plane/issues/108).

Run the source/static proof check locally with:

```bash
npm run railway-proof:verify
```

When Railway project/service/domain environment variables are present, the same
command also checks that the live proof deployment is sourced from
`yuens1002/openclaw-control-plane@main`, is not sourced directly from the
upstream template repo, uses the expected Railway Dockerfile/runtime settings,
and serves `/setup/healthz`, `/setup`, and `/openclaw`.

## Documentation

See [docs/README.md](docs/README.md) for the documentation layout and naming
conventions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). New client-specific behavior should
prove itself with fake/manual examples and no private assumptions before being
promoted into the reusable core.

## Security

See [SECURITY.md](SECURITY.md). Do not commit `.env`, `.env.local`, Railway
tokens, setup passwords, provider API keys, client data, or generated handoff
artifacts.

## License

MIT. See [LICENSE](LICENSE).
