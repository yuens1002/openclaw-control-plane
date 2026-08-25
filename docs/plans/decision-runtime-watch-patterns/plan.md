# Decision Runtime Watch Patterns Plan

Issue: https://github.com/yuens1002/openclaw-control-plane/issues/62
Branch: `feat/decision-runtime-watch-patterns`
Source: GitHub issue #62 — "build(railway): scope decision-runtime deploys with
watch patterns"

## Summary

Add `build.watchPatterns` to the decision-runtime API and worker Railway
configurations so each service deploys only when its own transitive Docker
build input changes. Today neither `deploy/decision-runtime/railway.toml` nor
`worker.railway.toml` declares `watchPatterns`, so a GitHub-connected service
redeploys on every commit to its tracked branch — including commits that touch
only documentation, the OpenClaw wrapper, or an unrelated package. Root
OpenClaw deploy behavior is intentionally untouched.

## Current State

- `deploy/decision-runtime/railway.toml` builds the API image from
  `deploy/decision-runtime/Dockerfile`; `worker.railway.toml` builds the
  worker image from `worker.Dockerfile`. Neither file defines
  `[build] watchPatterns` today — this is a clean addition, no existing key to
  reconcile.
- Each Dockerfile's **build-stage `COPY` instructions are the complete,
  provable transitive build input** for that image — not an inferred
  approximation. The API Dockerfile's build stage copies exactly:
  `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.base.json`,
  `apps/api/package.json`, `packages/contracts/package.json`,
  `packages/runtime-auth/package.json`, `packages/db/package.json`, then the
  full `apps/api`, `packages/contracts`, `packages/runtime-auth`, and
  `packages/db` directories. The worker Dockerfile is identical except
  `apps/worker` in place of `apps/api`. Nothing else reaches the image; the
  `COPY --from=build ...` lines in each Dockerfile's runtime stage copy
  *compiled output* (`dist/`) that has no corresponding source path in the
  repository and is therefore excluded from watch-pattern derivation.
- `.dockerignore` controls the Docker build context for every Dockerfile
  build at the repo root (all three services share one build context) and
  already excludes `docs` and `tests` — consistent with keeping doc/test-only
  changes out of watch patterns too.
- No decision-runtime API or worker Railway service is currently provisioned.
  `mcp__railway__list-services` against the `openclaw-control-plane` Railway
  project returns only the root OpenClaw service (source: this repo, root
  `Dockerfile` + `railway.toml`). The issue's "hosted smoke" acceptance test
  therefore has no live service to run against without provisioning one.
  Confirmed with the user: defer the live run to a manual post-merge
  follow-up rather than provisioning disposable services in this session. The
  **generic verification procedure** the AC also requires still ships in
  `docs/decision-runtime-deployment.md` (D5) regardless of that deferral.
  Tracked by issue [#65](https://github.com/yuens1002/openclaw-control-plane/issues/65)
  so the deferral has an open tracker independent of this PR closing #62.
- Railway's Config as Code (`railway.toml`/`railway.json`) is deprecated in
  favor of Infrastructure as Code; existing files keep working for legacy
  services until **2026-12-01**. All three of this repo's Railway services
  (root, API, worker) already use `railway.toml`. This plan stays on
  `railway.toml` — migrating to Infrastructure as Code is a separate,
  unscoped follow-up (see Non-Goals).
- No `check-acs-coverage.ts` / `check-test-drift.ts` gate scripts and no
  `.claude/verification-status.json` exist in this repo (same structural
  exception as `railway-cli-spawn-contract`, `setup-api-basic-auth`, and
  `client-template-pinning`). Gate 1/2 are performed manually below.
- Checked for in-progress-branch collisions before starting (retro lesson —
  a prior plan flagged a same-file conflict but didn't re-check it before
  handoff, and the conflict landed after human approval): a local
  `feat/decision-runtime-mcp` branch exists (no open PR) and genuinely
  overlaps this plan's D4/D5 targets — it adds new bullets/sections to
  `docs/architecture.md` (its own `packages/mcp-service`,
  `packages/decision-runtime-mcp`, `apps/mcp` entries, plus an MCP paragraph
  under Runtime Boundary) and `docs/README.md` (a new MCP Service Host Start
  Here bullet). Diffed both files against that branch: no line-range overlap
  with this plan's insertions today (its architecture.md edits land in
  `## Packages`/`## Runtime Boundary`, before this plan's new `## Deployment
  Topology` section; its docs/README.md edit adds a bullet after this plan's
  edited line). Re-check `git diff origin/main...feat/decision-runtime-mcp`
  against both files again immediately before Phase 5 handoff, in case it
  has merged and the line ranges have shifted.

## Approach

1. **Watch patterns are root-anchored (`/`-prefixed) glob strings**, one
   directory-wildcard pattern per copied directory (`/apps/api/**`) and one
   exact-path pattern per copied file (`/package.json`,
   `/apps/api/package.json`), plus three known extras per service: that
   service's own Dockerfile, that service's own `railway.toml`, and the
   shared `.dockerignore`. No negation patterns are used — Railway's own docs
   note negations only work with a preceding include rule, and a pure
   inclusion list is simpler and safer here.
2. **The new test file mechanically derives each service's expected pattern
   set from its Dockerfile's build-stage `COPY` sources** (excluding
   `--from=build` lines) using a 1:1 mapping — a copied directory becomes
   `dir/**`, a copied file becomes its exact path — plus the three known
   extras, and asserts **set equality** against that service's
   `watchPatterns` array in its `railway.toml`. This is deliberately
   mechanical with no consolidation logic (see Design Decisions), so the
   parity check stays trustworthy rather than clever.
3. **A second, independent check in the same test file** asserts the
   derivation itself actually detects drift: given a synthetic Dockerfile
   fragment with one extra `COPY` source not present in a pattern list, the
   mismatch is flagged. This directly verifies the "config parity" AC's own
   claim about test behavior, not just that today's real files happen to
   agree.
4. **A small, scope-local path-matcher** (also in the new test file)
   evaluates whether a single changed path is covered by a pattern list,
   implementing only the two shapes this feature emits (exact match,
   anchored `dir/**` prefix match) — not general gitignore semantics. It
   drives the representative changed-path-set assertions from the issue's
   acceptance list (API-only, worker-only, shared-package, dependency/config,
   deployment-target, and unrelated changes).
5. **Docs**: extend `docs/architecture.md` with a generic deployment-topology
   section (independent Railway services, per-service build/deploy/runtime
   boundaries, non-cascading deploys) and `docs/decision-runtime-deployment.md`
   with the watch-path trigger matrix, the maintenance rule (update watch
   patterns whenever a Dockerfile gains another copied path), and the
   generic hosted-verification procedure.

## Deliverables (with spec-role assignment)

| ID | Deliverable | Kind | Owning role | Session |
| --- | --- | --- | --- | --- |
| D1 | `deploy/decision-runtime/railway.toml` — add `build.watchPatterns` covering the API image's complete transitive build input | config | `/devops` | 1 |
| D2 | `deploy/decision-runtime/worker.railway.toml` — add `build.watchPatterns` covering the worker image's complete transitive build input | config | `/devops` | 1 |
| D3 | `tests/decision-runtime-watch-patterns.test.ts` — derives each service's expected pattern set from its Dockerfile, asserts set-equality (config parity) and drift detection, and asserts representative changed-path sets match/don't match per service | test | `/test-engineer` | 1 |
| D4 | `docs/architecture.md` — add a deployment-topology / build-lifecycle section: independent Railway services, per-service source/build/deploy boundaries, non-cascading deploys, runtime HTTP/DB relationships; `docs/README.md`'s Architecture one-liner updated to match (discovered mid-Implement — the docs index restates each doc's scope and would otherwise go stale) | doc | `/devops` | 1 |
| D5 | `docs/decision-runtime-deployment.md` — add Railway watch-path behavior, the API/worker trigger matrix, the watch-pattern maintenance rule, and a generic hosted-verification procedure | doc | `/devops` | 1 |
| D6 | `docs/plans/decision-runtime-watch-patterns/plan.md` — this plan | doc | `/project-manager` | 1 |
| D7 | `docs/plans/decision-runtime-watch-patterns/ACs.md` — structured AC table with Plan-ref and Role columns | doc | `/project-manager` | 1 |
| D8 | `docs/plans/decision-runtime-watch-patterns/review.md` — `/review` report | doc | `/project-manager` | 1 |

### Design decisions carried into Implement

- **Root-anchored (`/`-prefixed) pattern form, not bare `src/**`** (D1, D2):
  Railway's own docs show both forms as valid and, since this repo has no
  nested `apps/`/`packages/` duplicates at other depths, both would behave
  identically here today — meaning the test alone cannot force the anchored
  choice. Anchoring is picked deliberately for explicitness and must be
  reflected by the matcher in D3 (same anchoring assumption on both sides).
- **No consolidation in the parity derivation** (D3): the derived set
  includes both a directory's `dir/**` pattern *and* the exact-path pattern
  for any file separately copied from inside that same directory (e.g. both
  `/apps/api/**` and `/apps/api/package.json`) rather than collapsing the
  redundant entry away. A "smart" consolidator would be harder to trust and
  easier to get subtly wrong than a flat 1:1 mapping; the redundancy is
  harmless for Railway's OR-matched pattern list.
- **`COPY --from=build` lines are excluded from derivation** (D3): those
  lines copy compiled `dist/` output that exists only inside the build
  container, never as a source path in the repository.
- **No new runtime or dev dependency for TOML/glob parsing** (D3): the test
  file parses only the `watchPatterns = [...]` array syntax it itself
  produces, and implements only the two path-match shapes this feature
  emits — not a general TOML parser or gitignore-glob library. Matches this
  repo's existing `tests/decision-runtime-deployment.test.ts` convention of
  literal-content assertions over full-format parsing.
- **Root OpenClaw `railway.toml`/`Dockerfile` are not touched and gain no
  `watchPatterns`** (isolation): it intentionally continues to deploy on
  every commit to `main`; only the two decision-runtime configs are scoped.
- **Hosted smoke is a docs deliverable now, a live check later**: D5 ships
  the generic verification procedure this session; the live run against a
  provisioned service is an explicit, confirmed-with-the-user, non-blocking
  follow-up (see Current State).

### Files to Create

- `tests/decision-runtime-watch-patterns.test.ts` (D3)
- `docs/plans/decision-runtime-watch-patterns/plan.md`, `ACs.md`, `review.md`
  (D6-D8)

### Files to Edit

- `deploy/decision-runtime/railway.toml` (D1)
- `deploy/decision-runtime/worker.railway.toml` (D2)
- `docs/architecture.md` (D4)
- `docs/README.md` (D4 — Architecture one-liner kept in sync; discovered
  mid-Implement)
- `docs/decision-runtime-deployment.md` (D5)

## Sessions

Single session — D1-D8 all land together. Small, self-contained, config +
test + docs scope with no natural split.

## Acceptance Criteria

See `docs/plans/decision-runtime-watch-patterns/ACs.md`.

## Gate 1/2 Pre-Check

No project-specific `scripts/check-acs-coverage.ts` /
`scripts/check-test-drift.ts` exist in this repo (same structural exception
as `railway-cli-spawn-contract`, `setup-api-basic-auth`, and
`client-template-pinning`). Gate 1 (deliverable ↔ AC coverage) and Gate 2
(anti-drift literal-pin check) are performed manually: every deliverable
D1-D8 has at least one AC row whose Plan-ref names it, and every AC's Pass
condition states a mechanically-checkable relation (set equality against a
derivation, a match/no-match predicate applied to representative paths) or a
documented deferral (hosted smoke) rather than a pinned literal that already
lives in the files under test.

## Commit Schedule

1. Plan + ACs commit: `docs: add decision-runtime watch-patterns plan`
2. Config + tests: `build(railway): scope decision-runtime deploys with watch patterns`
3. Docs: `docs: document decision-runtime watch-path behavior and topology`
4. Verification: confirmed inline (typecheck/test/build/docker), no separate commit
5. Review: `docs: record decision-runtime watch-patterns review`

## Dependencies

None outside this repo. No live Railway/network access required for any
in-scope AC.

## Out of Scope

- Coupling OpenClaw and decision-runtime release lifecycles.
- Changing runtime APIs, persistence, authentication, authorization, or
  database migrations.
- Introducing a shared root directory that removes service-specific build
  boundaries.
- Encoding a particular Railway project, environment, organization,
  consumer, or production deployment in public source.
- Optimizing non-Railway CI workflows.
- Migrating any of this repo's three `railway.toml` files to Railway's
  Infrastructure as Code — noted as a pending deprecation (legacy support
  through 2026-12-01), not this issue's scope.
- Provisioning a live decision-runtime API/worker Railway service and running
  the hosted-smoke check against it — confirmed deferred to a manual
  post-merge follow-up; the generic procedure still ships in D5.
- Root OpenClaw's own deploy-trigger behavior — it gains no `watchPatterns`
  and intentionally continues to deploy on every commit to `main`.
