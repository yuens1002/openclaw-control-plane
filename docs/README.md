# Documentation

This directory contains durable project documentation. Prefer short, focused
files with grep-friendly names over large catch-all documents.

## File Convention

Use lowercase kebab-case filenames:

```text
docs/<topic>.md
docs/<area>/<topic>.md
docs/plans/<feature-slug>/{plan,ACs,review}.md
```

Examples:

- `docs/architecture.md`
- `docs/openclaw-tools.md`
- `docs/vending.md`
- `docs/plans/client-grade-railway-install/plan.md`

## Document Types

- Architecture docs describe durable system boundaries and design decisions.
- Feature docs describe one product or worker vertical.
- Operations docs describe setup, deploy, verification, and recovery flows.
- Plans live under `docs/plans/<feature-slug>/` and are used by the
  agentic-workflow cadence.

## Public-Repo Rule

Docs must not contain client data, private credentials, production tokens,
handoff passwords, or private operational URLs. Put local-only values in ignored
files such as `.env.local` or generated `*.local.md` handoff files.
