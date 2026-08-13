# Contributing

Thanks for taking a look at OpenClaw Control Plane.

This repo is early and private-first in its development style. Contributions
should keep the reusable core free of client-specific assumptions, real customer
data, private credentials, and external connector commitments that have not been
modeled with fake data first.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Use Docker Postgres for local DB work:

```bash
docker compose up -d postgres
```

## Pull Requests

- Keep changes narrowly scoped.
- Add or update tests for behavior changes.
- Update docs when behavior, setup, or architecture changes.
- Do not commit `.env`, `.env.local`, generated handoff files, provider keys,
  Railway tokens, or client data.
- For larger features, write a plan and acceptance criteria under
  `docs/plans/<feature-slug>/`.

## Documentation

Use the conventions in [docs/README.md](docs/README.md). New durable project
knowledge belongs in `docs/`, not only in chat history.

## Security

Report security issues privately. See [SECURITY.md](SECURITY.md).
