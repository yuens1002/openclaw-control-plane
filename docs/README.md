# Documentation

This directory contains durable project documentation. Prefer short, focused
files with grep-friendly names over large catch-all documents.

## File Convention

Use lowercase kebab-case filenames:

```text
docs/<topic>.md
docs/<area>/<topic>.md
docs/plans/<feature-slug>/{plan,ACs,review}.md
docs/adr/<NNNN>-<topic>.md
```

Examples:

- `docs/architecture.md`
- `docs/openclaw-tools.md`
- `docs/vending.md`
- `docs/plans/client-grade-railway-install/plan.md`
- `docs/adr/0001-identity-and-communication-boundary.md`

## Document Types

- Architecture docs describe durable system boundaries and design decisions.
- Feature docs describe one product or worker vertical.
- Operations docs describe setup, deploy, verification, and recovery flows.
- Plans live under `docs/plans/<feature-slug>/` and are used by the
  agentic-workflow cadence.
- ADRs (architecture decision records) live under `docs/adr/`, one
  sequentially numbered file per point-in-time decision (status, context,
  decision, consequences). Unlike architecture docs, an ADR is not updated
  to match the latest state — a changed decision gets a new ADR that
  supersedes the old one.

## Start Here

- [Architecture](architecture.md): current package, ownership, and
  deployment-topology boundaries.
- [Decision Runtime](decision-runtime.md): durable model, API, usage examples,
  typed tools, and extension path.
- [Runtime Authentication And Authorization](runtime-authentication.md): OIDC,
  stable identity, policy, delegation, and key rotation.
- [Private Decision Runtime Deployment](decision-runtime-deployment.md):
  service topology, readiness, smoke, backup/restore, and rollback.
- [OpenClaw Tools](openclaw-tools.md): typed adapter surface exposed to agents.

## Public-Repo Rule

This rule applies to everything written in this public repo: docs, plans,
ACs, GitHub issues, PR descriptions, issue/PR comments, and pull request review
comments.

Docs must not contain client data, private credentials, production tokens,
handoff passwords, or private operational URLs. Put local-only values in ignored
files such as `.env.local` or generated `*.local.md` handoff files.

Public deployment evidence records behavior, not the operator's implementation.
Use generic roles and placeholders for configured principals and actors,
deployment-specific service names, domains, deployment IDs, generated record
IDs, and private workflow names. Exact values belong in the deployment owner's
private operational record. It is still useful to state that readiness passed,
attribution was preserved, replay was idempotent, or provenance was traversable.

Public docs should describe OpenClaw Control Plane as a workflow-neutral
baseline. Business workflows, connectors, credentials, and client automations
belong in private repos or plugin packages unless they are explicitly framed as
fake/manual examples.

Do not name a specific private repo, agency, or client, even in passing —
describe the source generically instead, the same way this repo already talks
about "private agency/client repos" and "the client's private source of
truth" rather than any one of them by name.

| Instead of | Write |
| --- | --- |
| `acme-agency/acme-client-profile` (a real private repo slug) | "a private agency/client profile repo" |
| "our agency's Railway project" | "the target Railway service" |
| "the ACME client workflow" | "a client-specific workflow (fake/manual example)" |
| "a real principal, actor, domain, or deployment ID" | "the configured service principal" or "the target deployment" |

If a specific private name is genuinely necessary to explain something (rare —
usually a generic description works), stop and ask whether it belongs in this
repo at all before writing it down.
