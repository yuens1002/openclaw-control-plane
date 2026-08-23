# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/)
and uses semantic versioning once releases begin.

## [Unreleased]

- 2026-08-23 - docs(hygiene): drop private client-profile repo name from the ADR and four plan docs
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
