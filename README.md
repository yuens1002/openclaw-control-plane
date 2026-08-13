# OpenClaw Control Plane

Private-first TypeScript control plane for durable business workflows managed by OpenClaw through stable tools.

M1 is intentionally small: contracts, Postgres migrations, Hono API stubs, a vending worker skeleton, OpenClaw adapter stubs, fake fixtures, and tests for event validation plus idempotency.

## Local Setup

```bash
npm install
docker compose up -d postgres
npm test
npm run build
npm run --workspace @openclaw-control-plane/api dev
```

The API listens on `PORT` from `.env` or `8787` by default.

## Boundaries

OpenClaw manages the system; it does not become the system. The adapter calls the API, the API owns control-plane state transitions, the DB package owns persistence, and workers own domain behavior.

No external connectors are included in M1.
