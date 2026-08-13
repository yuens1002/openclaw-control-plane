# Open Source Readiness Plan

Branch: `feat/open-source-readiness`
Source: User request on 2026-08-13 to prepare the repo for public visibility as
a workflow-neutral OpenClaw control-plane foundation, plus follow-up context
that the existing Railway OpenClaw template deployment is a proof instance whose
source strategy should point back to public reusable template code, not a client
workflow repository.

## Summary

Prepare OpenClaw Control Plane to be made public as a reusable Chief of Staff
control-plane foundation. The public repo should not imply, install, enable, or
depend on any specific client pipeline, service, connector, or private workflow.

## Current State

The repo already has public-facing baseline docs, a license, contributing and
security docs, a Railway shell installer, and tests. It also contains an early
vending vertical used as the first fake/manual slice, so the readiness pass must
make the generic shell boundary unmistakable before repository visibility
changes.

## Approach

Use the agentic-workflow cadence as a release gate. First, document the plan and
AC contract on `feat/open-source-readiness`. Then implement only public-readiness
changes: positioning, workflow-neutrality, install-boundary clarity, metadata
review, and secret/client-data audits. The actual GitHub visibility switch stays
outside automation and requires explicit human approval.

## Deliverables (with spec-role assignment)

| ID | Deliverable | Kind | Owning role |
| --- | --- | --- | --- |
| D1 | `docs/plans/open-source-readiness/plan.md` - readiness plan with deliverables, branch, and scope boundary | doc | `/project-manager` |
| D2 | `docs/plans/open-source-readiness/ACs.md` - structured AC table with Plan-ref and Role columns | doc | `/project-manager` |
| D3 | `README.md` and `docs/` - public positioning describes a reusable OpenClaw Chief of Staff control-plane foundation | doc | `/project-manager` |
| D4 | Repo domain docs/code boundary - any vending/location-specific material is framed as fake/manual example or moved behind an example/plugin boundary | doc/code | `/backend-architect` |
| D5 | `deploy/openclaw-railway/` and installer handoff - Railway install remains shell-only and workflow-neutral | script/doc | `/devops` |
| D6 | Current tree and git history - scanned for secrets, handoff files, private URLs, client data, and client-specific assumptions | security-audit | `/security` |
| D7 | Package metadata and public project files - license, contributing guide, security policy, package names, repository URLs, and visibility flags are intentional | config/doc | `/project-manager` |
| D8 | Verification suite - typecheck, tests, build, static whitespace check, and release review evidence | test | `/test-engineer` |
| D9 | `docs/plans/open-source-readiness/review.md` - final machine review with findings, evidence, residual risk, and human approval status | doc | `/project-manager` |
| D10 | Railway proof-instance source stance - document that the shell template source can be updated from public reusable template code while client workflows remain separate | doc/config | `/devops` |
| D11 | `deploy/openclaw-railway/template-lock.json` - pinned upstream Railway template ref and approved commit | config | `/devops` |
| D12 | Template update detection - testable checker plus weekly GitHub Action detects upstream movement without auto-applying it | job/test | `/devops` |
| D13 | Mirror policy docs - document approved-branch mirror/eject flow for immutable Railway proof-instance source control | doc | `/devops` |

### Files to Create

| File | Purpose |
| --- | --- |
| `docs/plans/open-source-readiness/plan.md` | Feature plan and deliverable contract for the readiness gate. |
| `docs/plans/open-source-readiness/ACs.md` | Acceptance criteria with Plan-ref, Role, Agent, QC, and Reviewer columns. |
| `docs/plans/open-source-readiness/review.md` | Final review scaffold and later verification record. |

### Files to Edit

| File | Change |
| --- | --- |
| `README.md` | Clarify public positioning and shell-only Railway install boundary. |
| `deploy/openclaw-railway/README.md` | Clarify that the installer does not attach client workflows or connectors. |
| `packages/openclaw-railway-installer/src/index.ts` | Keep generated handoff next steps workflow-neutral. |
| `tests/openclaw-railway-installer.test.ts` | Assert the generated handoff preserves the shell-only boundary. |
| `package.json` | Add a script for checking the pinned Railway template ref. |
| `.github/workflows/railway-template-update.yml` | Run the template update detector weekly and manually. |
| `packages/openclaw-railway-installer/src/template-lock.ts` | Implement testable lock parsing and upstream comparison. |
| `packages/openclaw-railway-installer/src/check-template-lock.ts` | CLI entrypoint for the weekly checker. |
| `tests/openclaw-railway-template-lock.test.ts` | Unit tests for current, moved, and malformed lock/update states. |
| Other docs/config files identified during readiness audit | Update only if required to satisfy ACs without adding client-specific assumptions. |

## Sessions

| Session | Scope (deliverable IDs) | ACs |
| --- | --- | --- |
| Session 1 | D1-D13 | `docs/plans/open-source-readiness/ACs.md` |

## Acceptance Criteria

See `docs/plans/open-source-readiness/ACs.md`. Every AC row carries a Plan ref
and owning Role so coverage can be checked against this deliverables table.

## Gate 1/2 Pre-Check

- Gate 1 coverage: Manual check required in this repo because no project-specific
  AC coverage script exists yet. Every deliverable D1-D13 must have at least one
  AC row before implementation proceeds.
- Gate 2 anti-drift: Manual check required in this repo because no
  project-specific anti-drift lint exists yet. AC Pass cells must state
  invariants rather than pinning copied fixture strings.

## Commit Schedule

1. Plan commit: `docs: add open source readiness plan`
2. Readiness implementation: `docs: clarify public control-plane boundary`
3. Verification: `test: verify open source readiness`

## Dependencies

- Human approval of the plan before implementation continues.
- Human approval before changing GitHub repository visibility.
- Optional GitHub tooling for the final visibility switch; the switch is not part
  of this automation.
- Railway source settings access if the proof instance is later reconnected from
  the current template source to a public reusable source repo.
- A GitHub mirror repository and approved branch when we decide to make the
  Railway proof instance immutable at the source-control level.

## Out of Scope

- Changing the GitHub repository from private to public without explicit human
  approval.
- Installing or configuring a client-specific workflow.
- Connecting Railway to a client private repository.
- Removing useful fake/manual examples solely because they mention a domain.
- Publishing packages to npm.
- Storing Railway dashboard URLs, project IDs, service IDs, or environment IDs in
  public docs.
