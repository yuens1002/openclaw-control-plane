# Decision Runtime Release Versioning Plan

Status: **draft for review** — no implementation yet.
Revisits the disposition of issue #90 (see Current State).

## Summary

Treat the Decision Runtime as **one product with one version**, not three
independently-triggered services, and make cutting a release **automated
machinery rather than a human step**.

```text
merge to main ──▶ tag v{version} ──▶ release ──▶ canary   all automated
                                        │
                                        ▼
                                   pinned instances        deliberate, later
```

**Release cadence is a policy dial, not an architecture.** During heavy
development the dial sits at "every merge," so a release costs nothing and the
canary stays current. When a client instance exists, the dial turns down and
the same machinery serves a slower cadence. That is a configuration change, not
a re-plumb — which is why the seam is worth building now and the client upgrade
path is not.

The client-facing half of this — pinning, ledgers, fleet gates, upgrade kits —
is **deliberately deferred**. There is no client instance today, and optimising
an upgrade path with no one on it is speculative work. What is built now is
what serves active development: one coherent version, a dev target that does
not exist yet, and provenance for what shipped.

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

**Dev does not exercise the runtime at all.** The dev instances run OpenClaw
only. The Decision Runtime and MCP exist solely in the client-facing project,
so every runtime change today reaches a real instance with no dev stop in front
of it. In an active development cycle this is the most expensive gap on the
list, and it is the one with no workaround.

**The reported version is wrong by construction.** `apps/mcp/src/index.ts`
surfaces `CONTROL_PLANE_VERSION` from the root `package.json` baked at image
build, but version-bump commits deliberately no longer trigger redeploys
(issues #86, #89) — so the value reported is whatever the last code-triggering
commit happened to carry. The API's `/health` reports no version at all.

**A version is already produced on every merge.** The `/commit` flow bumps the
root `package.json` on every pull request, so `main` already carries a
distinct, human-authored version per merge. Release automation consumes that
rather than inventing a parallel numbering scheme, and `.github/workflows/ci.yml`
already runs on push to `main`, so it has somewhere to live.

**Two propagation models run side by side today.** OpenClaw client instances
are version-pinned per client (`OPENCLAW_GIT_REF`, `OPENCLAW_TEMPLATE_REF`
overriding Dockerfile `ARG` defaults; `template-lock.json` with
`autoApply: false`). The Decision Runtime services are git-connected to the
tracked branch with no pin. Same repository, opposite models.

**Registry versioning is already solved and must be reused, not reinvented.**
`docs/plans/runtime-registry-version-compatibility/` (issue #57) established
immutable versioned operation registrations under the gate "No migration
rewrites or deletes an existing persisted registration." This plan extends that
principle to the schema layer; it does not restate it.

**Governance is per-instance data and stays that way.** Vocabulary lives in
`type_registrations` and `operation_registrations` in each deployment's own
database; authorization comes from `RUNTIME_AUTH_CONFIG_JSON`. No repository
change can alter a deployed instance's rules. That property is load-bearing and
must not regress.

**On issue #90.** It recorded per-client runtime placement as an accepted
tradeoff whose bad property was auto-deploy fan-out. A pinned instance does not
fan out, which makes per-client placement correct rather than tolerated.

## Approach

### 1. Product-scoped watch patterns, replacing per-service ones

The three `railway.toml` files converge on **one shared pattern set** covering
the union of the product's build inputs. Any change to the product redeploys
all of it; a change to documentation, the installer, or the OpenClaw wrapper
still redeploys none of it.

This reconciles "deploy everything for consistency" with issues #86 and #89:
the consistency wanted is *within* the product; the efficiency those issues
bought was *outside* it. Both survive. The repo-root `package.json` stays
excluded and `package-lock.json` stays watched, unchanged.

`tests/decision-runtime-watch-patterns.test.ts` changes shape rather than
intent — one expected set derived from the union of the three Dockerfiles'
`COPY` sources instead of three sets from three Dockerfiles, keeping the
existing exclusion mechanism and drift detection.

### 2. Automated release: the version bump is the release declaration

On push to `main`, after `Verify` passes, CI reads the root `package.json`
version, creates annotated tag `v{version}` if it does not already exist, and
fast-forwards `release` to it. No human step is added; the `/commit` bump that
already happens on every pull request becomes the trigger.

- `release` is the branch the canary tracks. Railway tracks branches, not tags,
  so the branch carries the tag.
- Rollback is Railway's redeploy of a prior deployment, which restores the
  image reference *and* the variables.
- If the version was not bumped, no tag is cut and `release` does not move —
  the workflow is a no-op rather than a failure.

**`railway up` is not the mechanism.** It deploys one service from local disk
with no recorded source revision, so it cannot express "these services are on
one release" — the property being bought. It is also the `deploy` tier
`docs/live-instance-operations.md` §2.2 isolates, §2.5 forbids ad hoc, and §6.1
records an incident against. Its legitimate use remains
`provisionClientInstance`'s one-shot bootstrap of a service with no live state.

**`npm version` is not the mechanism either.** It rewrites
`package-lock.json`, which is watched, reintroducing the per-release redeploy
issue #86 removed. The `version` field is edited directly — already documented
and guarded by the drift test.

### 3. Make the running version observable

A release is worthless if an instance cannot be asked what it runs. Inject the
release ref as a Docker build `ARG` in all three Dockerfiles and surface it on
`/health` for the API and worker and in the MCP server identity, replacing the
current baked-`package.json` read. In an active development cycle this is a
debugging tool, not bookkeeping.

### 4. Migration rules, written now while they are cheap

Migrations are forward-only, checksum-ledgered, and auto-run at startup; there
are no down migrations and rollback does not reverse them
(`packages/db/src/migrations.ts`). Three rules follow, and all three cost
nothing to adopt today because no migration yet violates them:

1. **Expand-contract.** Rolling an instance back leaves the schema ahead of the
   code, so version *N* code must run against version *N+1* schema. Additive
   changes only in the release that introduces them; destructive changes wait
   at least one release.
2. **Migration files must be fast.** `healthcheckTimeout` is 300s and
   migrations run before listen, so a slow backfill inside a transactional file
   times out, the container is killed mid-boot, and the restart policy retries
   into a loop. Schema-only in migrations; backfills go in chunked idempotent
   post-start code or a later release.
3. **Migrations are structural only.** The registration tables hold
   per-instance governance data, so seeding or rewriting registration rows from
   the shared migration stream can collide with rows an instance created
   itself — issue #57's gate extended to the schema layer.

The *enforcement* machinery for rule 1 across a fleet (a ledger, a gate on
destructive migrations) is deferred with the rest of the client work. With one
canary and no clients, the rule is a discipline, not yet a process.

### 5. Compatibility

MCP-to-API compatibility is **deleted**, not managed: same tag, same
`packages/contracts`, deployed together.

For the future client boundary, one rule stated now so nothing is built that
violates it later: `/v1/runtime` is **additive-only for its lifetime** — new
routes and new optional fields, never a removed or retyped field; a breaking
transport change is `/v2` served alongside. Recorded intent, not built
machinery.

## Deliverables

| ID | Deliverable | Role |
| --- | --- | --- |
| D1 | Product-scoped watch patterns across the three `railway.toml` files, with the drift test reshaped to derive one union set | `/devops` |
| D2 | Release ref as a build `ARG` in all three Dockerfiles, surfaced on API and worker `/health` and in MCP server identity | `/backend-architect` |
| D3 | A dev deployment of the runtime product — one shared runtime serving both dev instances, with distinct principals per instance | `/devops` |
| D4 | Release automation in CI: tag `v{version}` from the root manifest on green `main`, fast-forward `release`, no-op when unchanged | `/devops` |
| D5 | `release` branch created and the canary repointed to it, plus a short release/rollback runbook in `docs/decision-runtime-deployment.md` | `/devops` |
| D6 | Migration rules (§4) and the `/v1` additive-only rule (§5) documented, extending issue #57's gate | `/backend-architect` |

## Acceptance Criteria

Full table in `ACs.md` once agreed. The load-bearing ones:

- A commit touching only documentation, the installer, or the OpenClaw wrapper
  deploys no runtime service; a commit touching any product input deploys all
  of them.
- A merge that bumps the version produces exactly one tag and moves `release`
  once; a merge that does not bump the version moves nothing and fails nothing.
- Every running service reports its release ref, and the value changes when and
  only when the deployed release changes.
- Both dev instances reach the shared dev runtime as distinct principals, and
  one instance's traffic is attributable separately from the other's.

## Sequencing

Ordered so each step stands alone and the highest-value gap closes first.

1. **D3 — dev runtime.** The only item with no workaround: there is nowhere to
   test runtime changes before they reach a real instance. Everything else is
   an improvement; this is a missing floor.
2. **D1 + D2** — product-scoped patterns and an observable version. No topology
   change, no live-target risk, and D2 fixes an existing reporting defect
   regardless of whether the rest proceeds.
3. **D6** — write the rules down while they are still vacuously true.
4. **D4 + D5** — release automation and the canary seam. Last because it is the
   only step that changes how a live service receives code, and because it is
   worth nothing until there is a dev tier in front of it.

## Dependencies

- A dev Railway project able to host the runtime product and its database (D3).
- Railway service-settings access to change a tracked branch (D5) — a settings
  change, not a re-provision.
- A CI token permitted to push tags and fast-forward `release` (D4).
  `.github/workflows/ci.yml` currently declares `contents: read`.

## Out of Scope — deferred until a client exists

Deliberately not built. There is no client instance today, and an upgrade path
with no one on it is speculative.

- **Client pinning mechanism.** A git-connected Railway service cannot hold an
  older tag while its branch advances — disabling autodeploy only defers *when*
  you deploy the branch head. So per-instance pinning will need either a
  per-instance release ref (with **opaque** names, since branch names are
  public) or a registry image tag. Decided when a client exists.
- **Fleet ledger and the destructive-migration gate.** Needs a fleet.
- **Upgrade kit / patch bundles**, and the intent to bound upgrades to a single
  major step. Recorded because it has one live consequence — migrations must
  stay replayable across that span, so none may be deleted — but not built.
- **A container registry pipeline (GHCR).** The right end-state if the fleet
  outgrows a handful of instances; a larger change than today's value requires.
- **`/v2`.** Nothing breaking is planned.
- **Relocating the runtime into this repository's own project** (issue #90).
- **Publishing to npm.** No consumer; `private: true`; trips the lockfile guard.

## Decisions Taken

- The canary tracks `release` continuously rather than being pinned; during
  heavy development that means it is effectively one automated hop behind
  `main`, which is intended.
- The instance-to-version ledger stays in the operator's private record. The
  consequence is that a fleet gate cannot be enforced by CI — accepted, and
  moot until there is a fleet. If it later needs automating, an opaque in-repo
  ledger (`instance-01: v0.7.0`) names no client and would restore
  machine-checkability.
- Both dev instances share one runtime deployment. They differ by profile data
  rather than runtime contract, so one suffices — and two consumers against one
  runtime exercises the multi-consumer authorization path, which nothing tests
  today. Dev therefore validates the code but not the one-runtime-per-instance
  topology; the canary is the first place that shape is exercised.
