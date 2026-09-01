# Decision Runtime Release Versioning Plan

Status: **draft for review** — no implementation yet.
Revisits the disposition of issue #90 (see Current State).

## Goals

1. **An automated development cycle** with a **local** environment that mimics
   the layered dogfood profile — no deployed dev tier.
2. **A release branch as a dial** protecting the running agency build, with
   **near-instant reversible rollback and no operational data lost**.
3. **A new client can follow a chosen build** via the private profile repo,
   independent of both the agency build and the automated development cycle.

## Summary

Treat the Decision Runtime as **one product with one version**, not three
independently-triggered services; make cutting a release **automated machinery
rather than a human step**; and keep the pre-merge loop **local**.

```text
local: verify:decision-runtime + dogfood harness + suite
  │ merge
  ▼
main ──[green + version bumped]──▶ tag v{version} ──▶ release ──▶ agency (auto)
                                                        │           ▲
                                                        │  ephemeral throwaway
                                                        │  for fresh-provisioning
                                                        ▼
                                                  a client pins a build
```

**Release cadence is a policy dial, not an architecture.** During heavy
development the dial sits at "every green, versioned merge," so a release costs
nothing and agency stays current. When a client exists, the dial turns down and
the same machinery serves a slower cadence — a configuration change, not a
re-plumb.

**There is no deployed dev tier.** Local verification here is unusually strong
(§3), and the two standing dev deployments are retired: the bug classes this
repo actually hits are fresh-provisioning ordering and live-traffic behavior,
and a standing dev instance catches neither (see Current State).

## Current State

Verified against the repository and the live platform, not assumed.

**The product is already one unit mechanically — the repo just does not treat
it as one.** `apps/worker/src/index.ts` and `apps/api/src/server.ts` both call
`initializePostgresRuntime`, which runs `runSqlMigrations`
(`packages/db/src/runtime-bootstrap.ts`). Both auto-migrate the shared database
at startup, before listening, so a worker at one version migrates the database
out from under an API at another. **API, worker, and MCP cannot be versioned
separately.** The unit is API + worker + MCP + `packages/contracts` +
`packages/db`.

**A standing dev instance would not have caught the bugs this repo actually
hits.** Issues #77, #78, and #84 were fresh-provisioning ordering defects,
found by provisioning a genuinely fresh instance — a standing instance already
has baseline config, which is the exact condition that hides them. Issues #86
and #89 were static deploy-config questions, now guarded by a test. The wrapper
authentication regressions were found by reading live HTTP logs under real
traffic, which a dev instance does not have. The residual risk concentrates in
**ephemeral fresh provisioning** and **live traffic**, and a standing dev tier
addresses neither.

**Local verification already covers a great deal.**
`scripts/verify-decision-runtime.mjs` builds the real production image from
`deploy/decision-runtime/Dockerfile`, runs real PostgreSQL 16 and a real HTTPS
JWKS server (so genuine OIDC JWT auth), runs migrations through the image's own
startup path, stops and restarts the API, then `pg_dump`/`pg_restore`s into a
second database and rebuilds projections to compare counts. The suite also
spawns the real MCP executable and a hosted MCP process. Its one gap: it tests
a **fresh install and never an upgrade**.

**The reported version is wrong by construction.** `apps/mcp/src/index.ts`
surfaces `CONTROL_PLANE_VERSION` from the root `package.json` baked at image
build, but version-bump commits deliberately no longer trigger redeploys
(issues #86, #89) — so the value reported is whatever the last code-triggering
commit carried. The API's `/health` reports no version at all.

**A version is already produced on every merge.** The `/commit` flow bumps the
root `package.json` on every pull request, so `main` already carries a distinct
version per merge. Release automation consumes that rather than inventing a
parallel numbering scheme, and `.github/workflows/ci.yml` already runs on push
to `main`.

**The weekly proof workflow has never worked.** `Railway Proof Verify` has
failed every Monday since at least 2026-08-17 with "Live Railway proof checks
are required. Set RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID,
RAILWAY_SERVICE_ID, and RAILWAY_PROOF_URL." Those secrets were never
configured. It therefore watches neither dev deployment, provides no coverage,
and is a standing red signal that trains the team to ignore scheduled-workflow
results. Retiring the dev deployments does not break it; it is already broken.

**Two propagation models run side by side today.** OpenClaw client instances
are version-pinned per client (`OPENCLAW_GIT_REF`, `OPENCLAW_TEMPLATE_REF`
overriding Dockerfile `ARG` defaults; `template-lock.json` with
`autoApply: false`). The Decision Runtime services are git-connected to the
tracked branch with no pin. Same repository, opposite models.

**Registry versioning is already solved.**
`docs/plans/runtime-registry-version-compatibility/` (issue #57) established
immutable versioned operation registrations under the gate "No migration
rewrites or deletes an existing persisted registration." This plan extends that
to the schema layer; it does not restate it.

**Governance is per-instance data.** Vocabulary lives in `type_registrations`
and `operation_registrations` in each deployment's own database; authorization
comes from `RUNTIME_AUTH_CONFIG_JSON`. No repository change can alter a
deployed instance's rules. Load-bearing; must not regress.

## Approach

### 1. Product-scoped watch patterns, replacing per-service ones

The three `railway.toml` files converge on **one shared pattern set** covering
the union of the product's build inputs. Any change to the product redeploys
all of it; documentation, installer, and OpenClaw-wrapper changes still
redeploy none of it.

This reconciles "deploy everything for consistency" with issues #86 and #89:
the consistency wanted is *within* the product, the efficiency those issues
bought was *outside* it. Both survive. `tests/decision-runtime-watch-patterns.test.ts`
changes shape rather than intent — one expected set derived from the union of
the three Dockerfiles' `COPY` sources, keeping the exclusion mechanism and
drift detection.

### 2. Automated release, gated on green and versioned

On push to `main`, after `Verify` passes, CI reads the root `package.json`
version, creates annotated tag `v{version}` if absent, and fast-forwards
`release` to it.

`release` mirrors **green, versioned** `main` — not raw `main`. The
fast-forward is conditional on Verify passing *and* a version bump being
present. CI already knows both, so the condition is free, and it makes the
branch a working gate from day one rather than a future seam: **a broken merge
never reaches the running agency build.** A merge that does not bump the
version moves nothing and fails nothing.

**`railway up` is not the mechanism.** It deploys one service from local disk
with no recorded source revision, so it cannot express "these services are on
one release." It is also the `deploy` tier `docs/live-instance-operations.md`
§2.2 isolates, §2.5 forbids ad hoc, and §6.1 records an incident against. Its
legitimate use remains `provisionClientInstance`'s one-shot bootstrap of a
service with no live state.

**`npm version` is not the mechanism either.** It rewrites
`package-lock.json`, which is watched, reintroducing the per-release redeploy
issue #86 removed. The `version` field is edited directly — already documented
and guarded by the drift test.

### 3. The development loop stays local, including the dogfood profile

Replacing the retired dev deployments: a local harness that stands up the
runtime product **and** applies the layered dogfood profile, so the
profile-applier path is exercised before merge rather than after.

Built on what exists rather than beside it — `verify-decision-runtime.mjs`
already orchestrates the production image, PostgreSQL, and a JWKS server, and
`packages/openclaw-setup-applier` already owns profile application. The harness
composes them: bring the product up, apply the vanilla dogfood profile against
it, assert the resulting configuration.

Two things stay off the laptop by nature and are handled where they belong:
**fresh provisioning** against a real Railway project (ephemeral: create,
verify, destroy — the pattern the throwaway instance already served), and
**live traffic behavior**, which only the running agency build has.

### 4. Rollback: near-instant, reversible, no operational data lost

The goal is a reversal that costs no operational data. Three mechanisms
together deliver it, and the third is the one that actually makes it true:

- **Code reversal is a Railway deployment rollback** — redeploying a prior
  deployment restores the image reference *and* the variables. Near-instant, no
  rebuild.
- **Branch reversal** is fast-forwarding `release` back to the prior tag, for
  when the fleet should follow rather than one service.
- **Schema is not reversed, and does not need to be.** Migrations are
  forward-only with no down migrations (`packages/db/src/migrations.ts`), so a
  rollback always leaves the schema ahead of the code. That is safe **only**
  under expand-contract (§5 rule 1), which is therefore not a nicety here but
  the precondition of the rollback guarantee. Nothing is dropped, so no
  operational data is lost; the older code simply ignores what it does not know
  about.

The guarantee is only as good as the discipline, which is why §5 rule 1 and the
upgrade-path verifier (D6) exist.

### 5. Migration rules, written now while they are cheap

Migrations are forward-only, checksum-ledgered, and auto-run at startup. Three
rules follow, all free to adopt today because no migration yet violates them:

1. **Expand-contract.** Version *N* code must run against version *N+1*
   schema. Additive changes only in the release that introduces them;
   destructive changes wait at least one release. This is what makes §4's
   rollback guarantee real.
2. **Migration files must be fast.** `healthcheckTimeout` is 300s and
   migrations run before listen, so a slow backfill inside a transactional file
   times out, the container is killed mid-boot, and the restart policy retries
   into a loop. Schema-only; backfills go in chunked idempotent post-start code
   or a later release.
3. **Migrations are structural only.** The registration tables hold
   per-instance governance data, so seeding or rewriting registration rows from
   the shared migration stream can collide with rows an instance created
   itself — issue #57's gate extended to the schema layer.

### 6. Client independence

A client instance follows a **chosen build**, not a moving branch. Its
independence has two halves, both already established patterns:

- **The OpenClaw instance** is pinned as it is today —
  `OPENCLAW_GIT_REF` / `OPENCLAW_TEMPLATE_REF` per service, `autoApply: false`,
  updated through the compare-and-swap helpers in `provision-client.ts`.
- **The profile** comes from the client's own private profile repo, which is
  what lets a client sit on a build independently of both the agency build and
  the automated development cycle.

The **runtime pin mechanism** is deliberately undecided (see Out of Scope): a
git-connected Railway service cannot hold an older tag while its branch
advances, so it will need either a per-instance release ref with opaque naming
(branch names are public) or a registry image tag. That choice is made when a
client exists, and nothing in this plan forecloses either.

MCP-to-API compatibility is **deleted**, not managed: same tag, same
`packages/contracts`, deployed together. For the future client boundary, one
rule stated now so nothing is built that violates it: `/v1/runtime` is
**additive-only for its lifetime**; a breaking transport change is `/v2` served
alongside.

## Deliverables

| ID | Deliverable | Role |
| --- | --- | --- |
| D1 | Product-scoped watch patterns across the three `railway.toml` files, with the drift test reshaped to derive one union set | `/devops` |
| D2 | Release ref as a build `ARG` in all three Dockerfiles, surfaced on API and worker `/health` and in MCP server identity | `/backend-architect` |
| D3 | Local dogfood harness: bring the runtime product up locally and apply the layered vanilla profile, composing `verify-decision-runtime.mjs` and `openclaw-setup-applier` | `/test-engineer` |
| D4 | Release automation in CI: tag `v{version}` from the root manifest on green, versioned `main`; fast-forward `release`; no-op when unchanged | `/devops` |
| D5 | `release` branch created, agency runtime services repointed to it, and a release/rollback runbook in `docs/decision-runtime-deployment.md` | `/devops` |
| D6 | Upgrade-path verification: extend `verify-decision-runtime.mjs` to take a "from" ref and run old, new, then old again against one database — the executable form of the §4 rollback guarantee | `/test-engineer` |
| D7 | Migration rules (§5) and the `/v1` additive-only rule documented, extending issue #57's gate | `/backend-architect` |
| D8 | Retire the two standing dev deployments, and either configure or delete `Railway Proof Verify` | `/devops` |

## Acceptance Criteria

Full table in `ACs.md` once agreed. The load-bearing ones:

- A commit touching only documentation, the installer, or the OpenClaw wrapper
  deploys no runtime service; a commit touching any product input deploys all
  of them.
- A merge that is green and bumps the version produces exactly one tag and
  moves `release` once. A merge that is red moves nothing. A merge that does
  not bump the version moves nothing and fails nothing.
- Every running service reports its release ref, and the value changes when and
  only when the deployed release changes.
- The local harness applies the dogfood profile and asserts the result, without
  any Railway project.
- `verify:decision-runtime` fails when a migration in the candidate release
  breaks the previous release's code against the upgraded schema.
- Rolling the agency runtime back to the prior release restores service without
  a rebuild and without losing operational data.

## Sequencing

1. **D1 + D2** — product-scoped patterns and an observable version. No topology
   change, no live-target risk; D2 fixes an existing reporting defect anyway.
2. **D3 + D6** — the local loop: dogfood harness and upgrade-path verification.
   The highest-value work, and none of it is deployed infrastructure.
3. **D7** — write the rules down while they are still vacuously true.
4. **D4 + D5** — release automation and the agency seam. Last, because it is
   the only step that changes how a live service receives code, and it is worth
   little until the local loop in front of it is real.
5. **D8** — retire the dev deployments and dispose of the dead workflow, once
   D3 has replaced what they were nominally providing.

## Dependencies

- A CI token permitted to push tags and fast-forward `release`;
  `.github/workflows/ci.yml` currently declares `contents: read`.
- Railway service-settings access to change a tracked branch (D5) — a settings
  change, not a re-provision.
- Docker locally for D3 and D6, as `verify-decision-runtime.mjs` already
  requires.

## Out of Scope — deferred until a client exists

- **The client runtime pin mechanism.** A git-connected Railway service cannot
  hold an older tag while its branch advances; disabling autodeploy only defers
  *when* the branch head is deployed. Per-instance pinning will need either an
  opaque per-instance release ref or a registry image tag. Decided when a
  client exists; nothing here forecloses either.
- **Fleet ledger and the destructive-migration gate.** Needs a fleet. The
  instance-to-version record stays in the operator's private notes; the
  consequence is that the gate cannot be CI-enforced, which is moot until there
  is more than one instance.
- **Upgrade kit / patch bundles**, and bounding upgrades to a single major
  step. Recorded because it has one live consequence — migrations must stay
  replayable across that span, so none may be deleted — but not built.
- **A container registry pipeline (GHCR).** The right end-state if the fleet
  outgrows a handful of instances.
- **`/v2`.** Nothing breaking is planned.
- **Relocating the runtime into this repository's own project** (issue #90).
- **Publishing to npm.** No consumer; `private: true`; trips the lockfile
  guard.

## Decisions Taken

- Agency tracks `release` continuously; during heavy development that is one
  automated hop behind `main`, which is intended.
- The instance-to-version ledger stays in the operator's private record. If it
  later needs automating, an opaque in-repo ledger (`instance-01: v0.7.0`)
  names no client and would restore machine-checkability.
- Both standing dev deployments are retired in favour of a local harness. The
  loss is a standing place to click through the Control UI, recreatable on
  demand through automated provisioning.
- Agency becomes the first and only live target. The conditional fast-forward
  is therefore not decoration — it is what stands between a red build and the
  running agency instance.
