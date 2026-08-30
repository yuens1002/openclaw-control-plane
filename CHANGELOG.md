# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/)
and uses semantic versioning.

## [Unreleased]

## [0.6.9] - 2026-08-30

- 2026-08-30 - build(railway): scope the Decision Runtime MCP service's deploy trigger (#89)
  - `deploy/decision-runtime-mcp/railway.toml` declared no `build.watchPatterns`
    at all, so every commit to the tracked branch redeployed the MCP service --
    documentation, installer work, and changelog entries included. An absent
    list is not a narrower boundary but the widest one. Same class as #86, but
    broader: #86 over-triggered on one path, this triggered on all of them.
  - The declared patterns are derived from the service's own Dockerfile `COPY`
    sources: `apps/mcp`, `packages/contracts`, `packages/openclaw-adapter`,
    `packages/mcp-service`, `packages/decision-runtime-mcp`, the shared root
    manifests and TypeScript config, its own Dockerfile and `railway.toml`, and
    `.dockerignore`. The repo-root `package.json` is excluded on the grounds
    established in #86/#88. The database boundary stays excluded, matching the
    image (`tests/decision-runtime-mcp-deployment.test.ts`).
  - `tests/decision-runtime-watch-patterns.test.ts` now covers the MCP service
    the same way it covers the API and worker -- COPY-derived set equality, plus
    cases asserting that MCP-only paths reach only the MCP service and that db,
    api, and worker paths reach it not at all, plus a docs/changelog/installer
    churn case asserted against all three services. Mutation-checked: dropping a
    single declared pattern fails the suite.
  - Pins `matchesAnyPattern`'s directory boundary. It treats `dir/**` as a prefix
    check, and the trailing slash is the only thing stopping `/apps/mcp/**` from
    matching `/apps/mcp-extra/...`; no existing case would have failed if that
    slash were lost, in a repo full of prefix-similar names (`apps/mcp`,
    `packages/mcp-service`, `packages/decision-runtime-mcp`). Mutation-checked.
  - `docs/decision-runtime-deployment.md`: trigger matrix extended to three
    columns and split where the MCP's shared-package set diverges from the
    API/worker's. `docs/architecture.md`: corrected from three services to four
    (the MCP service was absent from the topology and diagram entirely) and
    records that an absent `watchPatterns` is the widest boundary, not a
    narrower one.

## [0.6.8] - 2026-08-30

- 2026-08-30 - build(railway): stop redeploying the decision-runtime services on every version bump (#86)
  - `deploy/decision-runtime/railway.toml` and `worker.railway.toml` listed the
    repo-root `/package.json` in `build.watchPatterns`. Every release bumps that
    file's `version`, so every release rebuilt and redeployed the decision-runtime
    API and worker services -- a `restart-or-redeploy-triggering` operation on a
    live target caused by a version string rather than by a change to the build
    input. Observed on 0.6.6 -> 0.6.7, whose only other changes were to the
    installer and setup-applier packages that neither service builds from.
  - Both entries are removed and replaced with a comment recording why the root
    manifest is deliberately absent: neither Dockerfile invokes a root npm
    script (each runs `npm ci` then an explicit `tsc -b`), and its only
    build-relevant content -- `workspaces` and the root dependency sets -- is
    mirrored into `/package-lock.json`, which stays watched.
  - `tests/decision-runtime-watch-patterns.test.ts` is the drift detector that
    derives each service's expected patterns from its Dockerfile's `COPY`
    sources, so the removal had to be declared to it rather than left to fail:
    `deriveExpectedPatterns` gains an explicit `exclude` argument, and a new
    case pins that a repo-root `package.json` change now matches neither
    service. The 1:1 COPY-source rule still holds for every other path.
  - Two premises of the exclusion are now guarded rather than merely asserted.
    A new test requires the root manifest to declare no install-lifecycle
    scripts (`npm ci` would run one, changing the image with no watched path
    changing -- a silently missed deploy). And `docs/decision-runtime-deployment.md`
    records that mirroring the release version into `package-lock.json` (via
    `npm version` or `npm install --package-lock-only`) would reintroduce the
    per-release redeploy through the still-watched `/package-lock.json`.
  - `docs/decision-runtime-deployment.md`: trigger matrix corrected (root
    `package.json` now deploys neither service) and the maintenance rule
    extended with the exception and its two guards.

## [0.6.7] - 2026-08-27

- 2026-08-27 - fix(installer): refuse to approve device pairing before a baseline config exists (issue #77's sibling)
  - `provisionClientInstance`'s own `approveOwnDevicePairing` call runs before
    a genuinely fresh instance has any baseline config, and the wrapper's
    `/setup/api/devices/pending` proxies to a gateway that has not started
    at all yet -- confirmed live (dogfood-throwaway-01 bootstrap): `{ok:false}`
    with a 500. `approveOwnDevicePairing` now returns a `status` (`"approved"`
    / `"no-pending"` / `"not-ready"`) instead of throwing on `ok:false`, and
    `bootstrapOnboardingCycle` retries it once `apply` has established a
    baseline -- the exact shape issue #77 already established for
    `patchAllowedOrigins`.

## [0.6.6] - 2026-08-27

- 2026-08-27 - fix(wrapper): scoped state export writes zero-byte -wal/-shm placeholders (#79)
  - `buildStateExportTree` (`scripts/wrapper-state-export.mjs`) now writes a
    zero-byte `-wal` and `-shm` placeholder next to every `VACUUM INTO`
    snapshot it produces, accounted against the byte cap like any other
    entry. The pinned wrapper's `POST /setup/import` extracts without
    clearing pre-existing sidecars first, so a target's own stale, live
    `-wal` previously survived a restore beside the freshly-imported main
    file; extracting a zero-byte file over it truncates it instead, giving
    SQLite an empty (nothing-to-replay) WAL on next open.
  - Root-caused a real production incident: importing a scoped-export
    backup onto a live instance corrupted `state/openclaw.sqlite` and
    crash-looped the gateway until the stale sidecars were removed by hand.
    Works around a defect filed upstream at
    [vignesh07/clawdbot-railway-template#236](https://github.com/vignesh07/clawdbot-railway-template/issues/236).
  - `tests/openclaw-railway-wrapper-patches.test.ts`: asserts every
    snapshot's placeholder pair is zero-byte, and restores the produced
    archive over a target with a live, non-empty `-wal` through the real
    `tar` package to prove it gets truncated.

## [0.6.5] - 2026-08-27

- 2026-08-27 - feat(railway-installer): add `rotateGatewayToken` + `client-cli rotate-gateway-token`
  - Rotates `OPENCLAW_GATEWAY_TOKEN` on an already-provisioned client service
    to a fresh random value, redeploys, and waits for the instance to answer
    authenticated requests, mirroring `updateClientTemplateRef`/
    `updateClientOpenClawRef`'s write-then-verify shape. Unlike those two,
    it is not a compare-and-swap (a rotation always replaces the current
    value), and the new value is never returned, logged, or printed.
  - Built to unblock the post-restore-drill step in the consumer repo's
    backup/restore runbook, which had been a manual-only instruction.

## [0.6.4] - 2026-08-27

- 2026-08-27 - fix(installer): refuse to write allowedOrigins before a baseline config exists (#77)

## [0.6.3] - 2026-08-27

- 2026-08-27 - feat(wrapper): add scoped state export and share the exit-confirmed gateway stop (#73)
  - `GET /setup/export?scope=state` on the pinned Railway wrapper: state subset
    only (measured ~7 MB vs 541 MB unscoped), consistent SQLite snapshots via
    `node:sqlite` `VACUUM INTO`, closed include list + explicit excludes, hard
    byte cap (`OPENCLAW_STATE_EXPORT_MAX_BYTES`), archive importable by
    `/setup/import`. Logic lives in `scripts/wrapper-state-export.mjs`
    (copied into the image); `scripts/patch-wrapper-scoped-export.mjs`
    injects only the import and the route delegate.
  - `/setup/import` no longer stops the gateway with an unconfirmed
    `kill → sleep(750)`; `scripts/patch-wrapper-restart-gateway.mjs` now
    defines one `stopGatewayAndWait()` used by both `restartGateway()` and
    the import handler, each site count-guarded at build time.
  - `tests/openclaw-railway-wrapper-patches.test.ts` (21 tests), README
    subsection, Dockerfile assertions; upstream issue drafts in
    `docs/plans/wrapper-scoped-export-and-import-restart/upstream-issues.md`.

## [0.6.2] - 2026-08-26

- Preserve validated MCP tool invocation IDs in effect-free authorization
  denial audits while retaining headerless HTTP compatibility.

## [0.6.1] - 2026-08-26

- 2026-08-26 - fix(runtime): wait for gateway process exit before restart respawns it

## [0.6.0] - 2026-08-26

- Add a secret-backed asymmetric workload-JWT provider for MCP downstream
  authentication while retaining OAuth client credentials as the default.
- Add mutually exclusive provider configuration, bounded token signing and
  caching, runtime rejection conformance, and portable key-rotation guidance.

## [0.5.0] - 2026-08-25

- 2026-08-25 - feat(mcp): add reusable Decision Runtime bridge

## [0.4.3] - 2026-08-25

- 2026-08-25 - build(railway): scope decision-runtime deploys with watch patterns

## [0.4.2] - 2026-08-25

- Generalize public deployment evidence and historical planning references,
  and extend the Public-Repo Rule to issue/PR comments and operational IDs.

## [0.4.1] - 2026-08-25

- 2026-08-25 - fix(runtime): version expanded registry contract

## [0.4.0] - 2026-08-24

- Add the authenticated, versioned Decision Runtime API with OIDC identity,
  static RBAC, delegation, immutable approvals, typed commands and queries,
  bounded audit, and server-derived action attribution.
- Add durable PostgreSQL runtime records, registrations, provenance edges,
  idempotency, projections, migration coverage, and backup/restore verification.
- Add the bearer-authenticated OpenClaw tool adapter, production API and worker
  targets, independent readiness dimensions, and a public container conformance
  verifier covering TLS/JWKS, restart, replay, and recovery.
- Add public Decision Runtime architecture, API, usage, authentication, and
  deployment documentation with workflow-neutral `example.*` fixtures.

- 2026-08-23 - docs(ops): close protocol gap G4 by narrowing its scope rather than building a shared guard (closes #45)
- 2026-08-23 - docs(hygiene): drop private client-profile repo name from the ADR, four plan docs, a deploy doc, and a source comment; add the audit report
- 2026-08-23 - docs(adr): ADR 0001 no longer names which GitHub auth mechanism any tenant currently runs
- 2026-08-23 - docs(ops): cross-link the gap register to its GitHub tracking issues
- 2026-08-23 - docs(ops): correct the live-instance gap register (G3 trigger, G5 naming, G6 circular fix, G8 evidence)
- 2026-08-22 - fix(railway): compare-and-swap + auth-gated readiness for client ref updates (closes protocol gap G1)
- 2026-08-21 - chore(setup-applier): delete the unused destructive config-reset capability (closes #36, protocol gap G2)
- 2026-08-21 - fix(railway): add post-write verification to the allowedOrigins patch (closes protocol gap G5's first half)
- 2026-08-21 - fix(railway): make root the canonical Control UI URL, exempt passive-fetch paths, and revert the base-path auth exemption
- 2026-08-20 - docs(ops): add live-instance operations protocol, tier markers, and base-path mount analysis
- 2026-08-19 - fix(railway): exempt /openclaw base-path routes from wrapper basic auth
- 2026-08-18 - revert(source-control-connector): remove unused github installation token minting transport (PAT adopted instead — see ADR 0001 Status Updates)
- 2026-08-17 - fix(railway): exempt /avatar/<agentId> from wrapper Basic Auth (browser never attaches cached credentials to it)
- 2026-08-17 - fix(railway): exempt control-ui-config.json from wrapper Basic Auth (client-side token attachment is unreliable)
- 2026-08-17 - fix(railway): accept the app's own gateway Bearer token as valid dashboard auth
- 2026-08-17 - fix(railway): always forward the gateway Bearer token instead of a cached client Basic-Auth header
- 2026-08-17 - fix(railway): exempt browser-managed static paths from wrapper Basic Auth
- 2026-08-17 - feat(railway): add per-client OPENCLAW_GIT_REF update lever, bump default to v2026.7.1-2
- 2026-08-17 - docs(adr): extend ADR 0001 with a source-control connector example
- 2026-08-17 - docs(adr): add identity and communication boundary decision record
- 2026-08-17 - feat: onboarding regression pipeline + live-discovered provisioning fixes
- 2026-08-17 - test(railway): add real-spawn contract tests and dedupe fakes
- 2026-08-16 - feat(railway-installer): add importWorkspaceFiles transport for /setup/import
- 2026-08-16 - feat(railway): add per-client template-ref provisioning path
- 2026-08-15 - fix(setup-applier): send the real flat /setup/api/run payload shape
- 2026-08-15 - fix(setup-applier): add basic auth to setup api client
- 2026-08-15 - fix(railway): guard unscoped variable list/set from leaking secrets
- 2026-08-15 - feat(setup-applier): automate /setup configuration from a client profile
- 2026-08-14 - fix(repo): harden public readiness checks
- 2026-08-13 - fix(railway): make public repo govern OpenClaw runtime proof
- 2026-08-13 - fix(api): add workflow-neutral operator login gate
- 2026-08-13 - fix(api): serve a public root status response
- 2026-08-13 - feat(repo): prepare open source starter kit
- 2026-08-13 - feat(railway): add client-grade installer

### Added

- M1 TypeScript monorepo scaffold for the control-plane API, worker, contracts,
  DB package, OpenClaw adapter, vending worker, fixtures, and tests.
- OpenClaw Railway template installer documentation and script.
- Public repository preparation files: README, docs convention, contributing
  guide, security policy, changelog, and MIT license.
