# OpenClaw Control Plane Architecture

The control plane is a reusable TypeScript monorepo for the vending and
provisioning tooling that stands up an OpenClaw instance, and for the wrapper
image that instance runs as. It does not contain a runtime engine of its own:
whatever external MCP servers a provisioned instance talks to are reached only
over the network — never as a workspace package — and this repo neither names
nor depends on which ones, if any, a given instance attaches.

OpenClaw manages the system; it does not become the system. This repository's
own job is narrower still: it provisions and configures the OpenClaw instance,
and builds the wrapper image that instance runs as. Domain behavior for a
deployed instance lives in that instance's own configuration and, where
attached, whatever external MCP servers its profile declares — not in this
repo.

## Packages

- `packages/openclaw-railway-installer`: shell-installs the OpenClaw Railway
  template and verifies the resulting proof instance — see
  [deploy/openclaw-railway](../deploy/openclaw-railway/README.md).
- `packages/openclaw-setup-applier`: reads a generated client profile and
  drives a live OpenClaw instance's `/setup` API idempotently — see
  [docs/setup-profile-applier.md](setup-profile-applier.md). The profile's
  `attachments.mcpServers[]` is where a client declares an external MCP
  server for the instance to use — this repo does not know or care which
  server that is.
- `workers/vending`: Fake/manual example worker package.
- root `Dockerfile` + `scripts/*.mjs` + `railway.toml`: the wrapper image —
  pulls and patches the upstream OpenClaw Railway template. Builds no
  workspace package.

## Runtime Boundary

- OpenClaw owns user interaction, prioritization, briefings, approvals,
  scheduling decisions, management commands, and notifications.
- This repository owns provisioning a client's OpenClaw instance and the
  wrapper image that instance runs as — not any runtime engine.
- An **external MCP server** is an optional dependency a provisioned
  instance may talk to over MCP, declared as a profile attachment (see
  `attachments.mcpServers[]` above), never as code in this repo. Whatever
  domain state, entities, or behavior it owns belongs entirely to that
  server's own repository and documentation — this repo neither names nor
  assumes which server, if any, is attached.

## Public Baseline

The repository includes the vending/provisioning tooling, the wrapper image
build, and a public conformance suite for both. A deployment adds its own
profile (model providers, channels, and any MCP server attachments), identity
policy, connectors, and private credentials — none of which are baked into
this repo.

External connectors, consumer-specific workflows, and any runtime engine
remain out of scope for the public baseline.

## Deployment Topology

The repository builds the wrapper image from the root `railway.toml` and
`Dockerfile`, and sources **two** independently git-connected Railway
deployments of it from the same tracked branch:

- **Public-proof deployment**: sourced from root `railway.toml` via
  Railway's Config as Code mechanism, which Railway has deprecated in favor
  of Infrastructure as Code — existing adopters keep working until a
  published sunset date, after which this deployment needs its own
  migration (see [Railway's Config as Code docs](https://docs.railway.com/config-as-code)
  for current status and the cutoff). Declares no `watchPatterns` and
  deploys on every commit to the tracked branch — deliberate, since this is
  the reference deployment proving the wrapper image builds and runs
  cleanly, and staleness there would defeat its purpose.
- **The canary**: the one instance in continuous, heavy real-world use.
  Config as Code isn't available to it (it has never used a config file,
  and Railway no longer allows a service to newly adopt one). Instead, once
  reconnected (a live-infra step tracked separately from this repo's own
  commits — see `docs/plans/canary-scoped-watch-deploy/plan.md`'s Session 2),
  its Railway service is git-connected directly, with `watchPatterns` and
  the rest of its build/deploy settings applied as native, non-deprecated
  per-service settings — the same fields Config as Code would otherwise
  express in a file, set directly instead. `deploy/openclaw-railway/canary.railway.toml`
  is committed as the readable, drift-guarded reference spec for what those
  live settings should be (see that file and
  `tests/canary-watch-patterns.test.ts`'s drift guard, which checks it
  against the Dockerfile's own `COPY` sources) — Railway does not read it.
  Once connected, a commit that doesn't touch a build-relevant path (docs,
  plans, CHANGELOG, unrelated packages) will not trigger a rebuild.

A one-off pinned client instance (see
[deploy/openclaw-railway/README.md](../deploy/openclaw-railway/README.md#agency-controlled-client-provisioning))
is deployed by a different mechanism entirely — CLI, version-pinned,
deliberately not git-connected — and is unaffected by either deployment
above.

Everything else a provisioned instance depends on — any MCP server
attachment included — is provisioned and versioned independently, in its
own repository, on its own infrastructure boundary, and reached only over
the network (HTTP/MCP) once live. This repository's provisioning tooling
(`packages/openclaw-railway-installer`, `packages/openclaw-setup-applier`)
drives instance setup from the outside; it does not build or deploy any
attached server itself.

```text
repo (one default branch)
 ├─ railway.toml                                  → public-proof deployment
 │                                                   (Config as Code; no watchPatterns;
 │                                                    deploys on every commit)
 └─ deploy/openclaw-railway/canary.railway.toml   → reference spec only, NOT read by Railway
                                                      (applied to the canary's live service as
                                                       native per-service settings; watchPatterns
                                                       scoped to the Dockerfile's own COPY sources)

per pinned client instance (CLI, version-pinned, not git-connected):
 └─ see deploy/openclaw-railway/README.md's Agency-Controlled Client Provisioning

external, per attached instance (if any):
 └─ whatever repository an attached MCP server comes from
                             (reached over MCP, declared as a profile
                              attachment; no code dependency either way)
```
