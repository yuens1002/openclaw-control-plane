# OpenClaw Control Plane

OpenClaw Control Plane is a reusable TypeScript monorepo for durable business
workflows managed by OpenClaw through stable tools.

It is intentionally a workflow-neutral baseline. The public repo provides the
control-plane shell, contracts, persistence primitives, adapter patterns, Railway
installer, fake/manual examples, and tests. Client-specific workflows,
connectors, credentials, and automations are attached after onboarding from the
client's private source of truth.

## Status

This project is in early M1 foundation work. Production connectors and
client-specific assumptions are intentionally out of scope. The default API and
worker runner start with no registered workflows.

## Architecture

OpenClaw manages the system; it does not become the system.

- `apps/api`: control-plane HTTP API
- `apps/worker`: background worker runner
- `packages/contracts`: shared schemas and TypeScript types
- `packages/db`: migrations and typed persistence primitives
- `packages/openclaw-adapter`: OpenClaw-facing API wrappers
- `workers/vending`: fake/manual example worker package
- `deploy/openclaw-railway`: OpenClaw Railway template installer
- `docs`: architecture, feature, and operations documentation

## Local Setup

```bash
npm install
docker compose up -d postgres
npm test
npm run build
npm run --workspace @openclaw-control-plane/api dev
```

The API listens on `PORT` from `.env` or `8787` by default.
Set `SETUP_PASSWORD` to require HTTP Basic auth on the API root and
control-plane endpoints. `/health` stays public for platform healthchecks. The
default username is `openclaw`; override it with `OPENCLAW_SETUP_USERNAME`.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

The current test suite covers event envelope validation and event idempotency.
Client-grade Railway install verification uses mocked Railway CLI tests. Live
Railway smoke tests are intentionally opt-in so normal CI does not create cloud
resources.

Workspace packages are marked `private: true` intentionally. The GitHub repo can
be public while npm publishing remains out of scope for the M1 baseline.

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
