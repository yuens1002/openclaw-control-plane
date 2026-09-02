# OpenClaw Control Plane Architecture

The control plane is a reusable TypeScript monorepo for the vending and
provisioning tooling that stands up an OpenClaw instance, and for the wrapper
image that instance runs as. It does not contain a runtime engine: the
Decision Runtime that a provisioned instance talks to lives in a separate
repository, `decision-runtime`, and is reached only over the network — never
as a workspace package.

OpenClaw manages the system; it does not become the system. This repository's
own job is narrower still: it provisions and configures the OpenClaw instance,
and builds the wrapper image that instance runs as. Domain behavior for a
deployed instance lives in that instance's own configuration and, where
attached, the external Decision Runtime — not in this repo.

## Packages

- `packages/openclaw-railway-installer`: shell-installs the OpenClaw Railway
  template and verifies the resulting proof instance — see
  [deploy/openclaw-railway](../deploy/openclaw-railway/README.md).
- `packages/openclaw-setup-applier`: reads a generated client profile and
  drives a live OpenClaw instance's `/setup` API idempotently — see
  [docs/setup-profile-applier.md](setup-profile-applier.md). The profile's
  `attachments.mcpServers[]` is where a client declares an external MCP
  server, such as a Decision Runtime deployment, for the instance to use.
- `workers/vending`: Fake/manual example worker package.
- root `Dockerfile` + `scripts/*.mjs` + `railway.toml`: the wrapper image —
  pulls and patches the upstream OpenClaw Railway template. Builds no
  workspace package.

## Runtime Boundary

- OpenClaw owns user interaction, prioritization, briefings, approvals,
  scheduling decisions, management commands, and notifications.
- This repository owns provisioning a client's OpenClaw instance and the
  wrapper image that instance runs as — not any runtime engine.
- The **Decision Runtime** (a separate repository) is an external dependency
  a provisioned instance may talk to over MCP, declared as a profile
  attachment like any other (see `attachments.mcpServers[]` above), never as
  code in this repo. It owns durable entities, state transitions, event
  ingestion, idempotency, audit records, approval records, artifact records,
  and worker registry state for the client that attaches it. Its own
  architecture, API surface, and deployment topology are documented in that
  repository, not here.

## Public Baseline

The repository includes the vending/provisioning tooling, the wrapper image
build, and a public conformance suite for both. A deployment adds its own
profile (model providers, channels, and any MCP server attachments), identity
policy, connectors, and private credentials — none of which are baked into
this repo.

External connectors, consumer-specific workflows, and any runtime engine
remain out of scope for the public baseline.

## Deployment Topology

The repository builds and deploys one Railway service from its Git
history: the wrapper image, sourced from the root `railway.toml` and
`Dockerfile`. It declares no `watchPatterns` and deploys on every commit to
the tracked branch — deliberate, since the wrapper image is the one service
this repository directly owns and ships.

Everything else a provisioned instance depends on — a Decision Runtime
attachment included — is provisioned and versioned independently, in its own
repository, on its own Railway project/service boundary, and reached only
over the network (HTTP/MCP) once live. This repository's provisioning
tooling (`packages/openclaw-railway-installer`, `packages/openclaw-setup-
applier`) drives that setup from the outside; it does not build or deploy
those services itself.

```text
repo (one default branch)
 └─ railway.toml   → OpenClaw wrapper service
                      (no watchPatterns; deploys on every commit)

external, per attached instance:
 └─ decision-runtime repo → its own Railway project/services
                             (reached over MCP, declared as a profile
                              attachment; no code dependency either way)
```
