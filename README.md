# OpenClaw Control Plane

OpenClaw Control Plane is a private-first TypeScript monorepo for durable
business workflows managed by OpenClaw through stable tools.

The first vertical is intentionally small: contracts, Postgres migrations, Hono
API stubs, a vending worker skeleton, OpenClaw adapter stubs, fake fixtures, and
tests for event validation plus idempotency.

## Status

This project is in early M1 foundation work. It is structured to become public,
but production connectors and client-specific assumptions are intentionally out
of scope until the reusable core is stable.

## Architecture

OpenClaw manages the system; it does not become the system.

- `apps/api`: control-plane HTTP API
- `apps/worker`: background worker runner
- `packages/contracts`: shared schemas and TypeScript types
- `packages/db`: migrations and typed persistence primitives
- `packages/openclaw-adapter`: OpenClaw-facing API wrappers
- `workers/vending`: first vertical worker
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

## Verification

```bash
npm run typecheck
npm test
npm run build
```

The current test suite covers event envelope validation and event idempotency.
Client-grade Railway install verification is planned as a separate feature with
mocked Railway CLI tests and optional live smoke tests.

## OpenClaw on Railway

Use the OpenClaw-recommended Railway template flow in
[deploy/openclaw-railway](deploy/openclaw-railway/README.md). Do not deploy the
raw OpenClaw image directly for hosted Control UI installs; the template wrapper
handles setup, persistent `/data` state, public routing, and `/openclaw` proxying.

## Documentation

See [docs/README.md](docs/README.md) for the documentation layout and naming
conventions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). This repo uses a private-first workflow:
new client-specific behavior should prove itself with fake data and no private
assumptions before being promoted into the reusable core.

## Security

See [SECURITY.md](SECURITY.md). Do not commit `.env`, `.env.local`, Railway
tokens, setup passwords, provider API keys, client data, or generated handoff
artifacts.

## License

MIT. See [LICENSE](LICENSE).
