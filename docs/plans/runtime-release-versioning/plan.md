# Decision Runtime Release Versioning Plan

Status: **draft for review** — no implementation yet.
Revisits the disposition of issue #90 (see Current State).

## Summary

Treat the Decision Runtime as **one product with one version**, not three
independently-triggered services. A release is a named revision of the whole
product; a deployed instance pins a release and upgrades deliberately.

Two triggers, not one:

```text
merge to main   ──▶ dev instances      continuous, disposable
tag vX.Y.Z      ──▶ prod + clients     deliberate, whole-product, pinned
```

This buys three things the current arrangement does not: a client instance can
sit on a known version while the branch moves; an upgrade moves every part of
the product together, so no part can be skewed against another; and what
shipped is a named revision rather than whatever was on an operator's disk.

## Current State

Verified against the repository and the live platform, not assumed.

**The product is already one unit mechanically — the repo just does not treat
it as one.** `apps/worker/src/index.ts` and `apps/api/src/server.ts` both call
`initializePostgresRuntime`, which runs `runSqlMigrations`
(`packages/db/src/runtime-bootstrap.ts`). Both processes auto-migrate the
shared database at startup, before listening. A worker at one version therefore
migrates the database out from under an API at another. **API, worker, and MCP
cannot be versioned separately.** The unit is API + worker + MCP +
`packages/contracts` + `packages/db`.

**Two propagation models run side by side today.** OpenClaw client instances
are version-pinned per client (`OPENCLAW_GIT_REF` and `OPENCLAW_TEMPLATE_REF`
service variables overriding Dockerfile `ARG` defaults; `template-lock.json`
with `autoApply: false` and `requiresSmokeBeforeBump: true`) and upgrade
through compare-and-swap helpers in `provision-client.ts`. The Decision Runtime
services are git-connected to the tracked branch with no pin at all. Same
repository, opposite models.

**Dev does not exercise the runtime.** The dev instances run OpenClaw only. The
Decision Runtime and MCP exist solely in the client-facing project, so every
runtime change today reaches a real instance with no dev stop in front of it.
The continuous-deployment half of this plan currently has no target.

**The reported version is wrong by construction.** `apps/mcp/src/index.ts`
surfaces `CONTROL_PLANE_VERSION` from the root `package.json` baked at image
build, but version-bump commits deliberately no longer trigger redeploys
(issues #86, #89) — so the value reported is whatever the last code-triggering
commit happened to carry. The API's `/health` reports no version at all.

**Registry versioning is already solved and must be reused, not reinvented.**
`docs/plans/runtime-registry-version-compatibility/` (issue #57) established
immutable versioned operation registrations — an existing version is never
rewritten, and an expanded contract is published as a new version — under the
release gate "No migration rewrites or deletes an existing persisted
registration." This plan extends that principle to the schema and deployment
layers; it does not restate it.

**Governance is per-instance data and stays that way.** Vocabulary lives in
`type_registrations` and `operation_registrations` in each deployment's own
database (the shared migration seeds only retired `legacy.*` rows);
authorization comes from `RUNTIME_AUTH_CONFIG_JSON`. No repository change can
alter a deployed instance's rules. That property is load-bearing here and must
not regress.

**On issue #90.** It recorded per-client runtime placement as an accepted
tradeoff whose bad property was auto-deploy fan-out. Pinning removes that
property, which makes per-client placement correct rather than merely
tolerated. The issue was closed with a different remedy in view.

## Approach

### 1. Product-scoped watch patterns, replacing per-service ones

The three `railway.toml` files converge on **one shared pattern set** covering
the union of the product's build inputs. Any change to the product redeploys
all of it; a change to documentation, the installer, or the OpenClaw wrapper
still redeploys none of it.

This reconciles "deploy everything for consistency" with issues #86 and #89:
the consistency wanted is *within* the product, and the efficiency those issues
bought was *outside* it. Both survive. The repo-root `package.json` stays
excluded and `package-lock.json` stays watched, unchanged.

`tests/decision-runtime-watch-patterns.test.ts` changes shape rather than
intent — it derives one expected set from the union of the three Dockerfiles'
`COPY` sources instead of three sets from three Dockerfiles, keeping the
existing exclusion mechanism and the drift detection.

### 2. Annotated tag plus a `release` branch as the pin

Railway tracks branches, not tags, so a branch carries the tag.

- Cut an annotated tag `vX.Y.Z` on a release-worthy commit; the tag message
  carries the compatibility and migration note (§5).
- Prod and client runtime services track `release`, not the tracked branch.
- Deploying a release is a fast-forward of `release` to the tag. Every service
  moves together, from one named revision, with git provenance.
- Rollback is Railway's redeploy of the prior deployment, which restores the
  image reference *and* the variables.

**`railway up` is not the mechanism.** It deploys one service from local disk
with no recorded source revision, so it cannot express "these services are on
one pinned release" — the exact property being bought. It is also the `deploy`
tier that `docs/live-instance-operations.md` §2.2 isolates, §2.5 forbids ad
hoc, and §6.1 records an incident against. Its legitimate use remains
`provisionClientInstance`'s one-shot bootstrap of a service with no live state.

**Version bumps stay manual.** `npm version` rewrites `package-lock.json`,
which is watched, reintroducing the per-release redeploy that issue #86
removed. Edit the `version` field directly — already documented in
`docs/decision-runtime-deployment.md` and guarded by the drift test.

### 3. Make the running version observable

A pin is worthless if an instance cannot be asked what it runs. Inject the
release ref as a Docker build `ARG` in all three Dockerfiles and surface it on
`/health` for the API and worker and in the MCP server identity, replacing the
current baked-`package.json` read.

### 4. Migration discipline, forced by independent upgrade schedules

Migrations are forward-only, checksum-ledgered, and auto-run at startup; there
are no down migrations, and rollback does not reverse them
(`packages/db/src/migrations.ts`, `docs/decision-runtime-deployment.md`).
Independent per-instance schedules force four rules:

1. **Expand-contract is mandatory.** Rolling an instance back leaves the schema
   ahead of the code, so version *N* code must run against version *N+1*
   schema. Additive changes only in the release that introduces them.
2. **Contract migrations wait for the fleet.** A destructive change ships only
   after every pinned instance has passed the expanding release, which requires
   a written record of instance to pinned version.
3. **Migration files must be fast.** `healthcheckTimeout` is 300s and
   migrations run before listen, so a slow backfill inside a transactional file
   times out, the container is killed mid-boot, and the restart policy retries
   into a loop. Schema-only in migrations; backfills belong in chunked
   idempotent post-start code or a later release.
4. **Migrations are structural only.** The registration tables hold
   per-instance governance data, so seeding or rewriting registration rows from
   the shared migration stream can collide with rows an instance created
   itself. This is the direct extension of issue #57's gate to the schema
   layer.

### 5. Compatibility surfaces

MCP-to-API compatibility is **deleted**, not managed: same tag, same
`packages/contracts`, deployed together. The only remaining matrix is a
client's OpenClaw instance against its runtime over `/v1/runtime`, and both
sides are already independently pinned by design.

Governed by one rule and one line of prose rather than a table: `/v1` is
**additive-only for its lifetime** — new routes and new optional fields, never
a removed or retyped field; a breaking transport change is `/v2` served
alongside. Each release tag carries a one-line note stating which contract
version it serves and whether contract changes were none, additive, or listed.

## Deliverables

| ID | Deliverable | Role |
| --- | --- | --- |
| D1 | Product-scoped watch patterns across the three `railway.toml` files, with the drift test reshaped to derive one union set | `/devops` |
| D2 | Release ref as a build `ARG` in all three Dockerfiles, surfaced on API and worker `/health` and in MCP server identity | `/backend-architect` |
| D3 | A dev deployment of the runtime product, so continuous deployment has a target and the dev instances exercise it | `/devops` |
| D4 | `release` branch, prod services repointed to it, and a release runbook (cut tag, verify on dev, fast-forward, verify, rollback path) in `docs/decision-runtime-deployment.md` | `/devops` |
| D5 | Migration rules (§4) written into `docs/decision-runtime-deployment.md`, extending issue #57's gate | `/backend-architect` |
| D6 | Instance-to-version ledger, and a decision on where it lives | `/project-manager` |
| D7 | Upgrade-path verification: extend `scripts/verify-decision-runtime.mjs` to take a "from" ref and run old, new, then old again against one database | `/test-engineer` |
| D8 | The `/v1` additive-only rule and the per-release compatibility note, documented | `/backend-architect` |

## Acceptance Criteria

The full table follows in `ACs.md` once the plan is agreed. The load-bearing
ones:

- A commit touching only documentation, the installer, or the OpenClaw wrapper
  deploys no runtime service; a commit touching any product input deploys all
  of them.
- A root `package.json` version-only bump deploys nothing.
- Every running service reports its release ref, and the value changes when and
  only when the deployed release changes.
- `verify:decision-runtime` fails when a migration in the candidate release
  breaks the previous release's code against the upgraded schema.
- An instance pinned to an older release is unaffected by a merge to the
  tracked branch — demonstrated, not asserted.

## Sequencing

Ordered so each step stands alone and nothing irreversible happens early.

1. **D1 + D2** — product-scoped patterns and an observable version. No topology
   change, no live-target risk, and D2 closes an existing reporting defect
   regardless of whether the rest proceeds.
2. **D5 + D8** — write the migration and compatibility rules down while they
   are still vacuously true. Cheapest possible moment.
3. **D3** — stand up the runtime in dev. This is the first real prerequisite
   for continuous deployment and the first place to exercise D7.
4. **D7** — upgrade-path verification, once there is a dev target to run it
   against.
5. **D4 + D6** — the `release` branch, repointing prod, and the ledger. Last,
   because it is the only step that changes how a live client-facing service
   receives code.

## Dependencies

- Railway service-settings access to change a service's tracked branch (a
  settings change, not a re-provision).
- A dev Railway project able to host the runtime product (D3).

## Out of Scope

- **A container registry pipeline (GHCR).** Strictly better immutability, and
  the right end-state if the fleet outgrows a handful of instances, but it
  needs CI build, registry auth, and flipping services from repo-connected to
  image-based — a larger change than this plan's value requires today.
- **`/v2`.** Nothing breaking is planned; the rule is described so it is clear,
  not built.
- **Relocating the runtime into this repository's own project** (issue #90);
  pinning addresses the property that made placement a concern.
- **Publishing to npm.** No consumer, `private: true`, and `npm version` trips
  the lockfile guard.
- **Collapsing the services into fewer processes.** They are one product and
  one version, not necessarily one process.

## Open Questions

1. Does the agency instance become the first pinned consumer, or track
   `release` continuously as a pre-client canary?
2. Where does the instance-to-version ledger live — a repository file, or the
   operator's private record? A repository file is auditable but names
   deployments, which the Public-Repo Rule constrains.
3. Do the dev instances share one runtime deployment or take one each? They
   differ by profile data rather than code, which argues for one.
