# Client-Grade Railway Install Plan

## Goal

Make the OpenClaw Railway install repeatable enough for a client Chief of Staff
agent instance: safe reruns, fresh per-client secrets, local-only handoff
artifacts, verified health, and a public-repo-ready workflow.

## Deliverables

| ID | Deliverable | Kind | Owning role | Notes |
| --- | --- | --- | --- | --- |
| D1 | Workflow plan and ACs | docs | project-manager | Plan and AC tracking docs in `docs/plans/client-grade-railway-install/`. |
| D2 | Testable installer core | script | devops | TypeScript core that wraps Railway CLI operations behind an injectable runner. |
| D3 | Windows entrypoint | script | devops | PowerShell wrapper that invokes the testable installer. |
| D4 | Local handoff and env output | script | devops | Writes ignored `.env.local` keys and `*.local.md` handoff summary. |
| D5 | Mocked verification tests | tests | test-engineer | Unit tests for fresh install, idempotent rerun, failed deploy, domain correction, and local output. |
| D6 | Public docs update | docs | project-manager | README and deploy docs explain the client-grade flow and local-only outputs. |
| D7 | Public-release guardrails | docs/config | security | Ignore local handoff files and document secret/public release checks. |

## Session Breakdown

This is a single implementation session:

1. Commit current open-source prep baseline.
2. Add plan and ACs.
3. Implement installer and tests.
4. Run typecheck, tests, build, and static checks.
5. Produce a review summary for human approval.

## Commit Schedule

1. Baseline commit: `docs: prep repo for open source`
2. Feature implementation: `feat: add client-grade railway installer`
3. Verification/docs updates if needed: `test: verify client-grade railway installer`

## Non-Goals

- Making the GitHub repository public in this branch.
- Running a live Railway install for every test run.
- Configuring a specific client's model provider or messaging channels.
- Deleting any Railway volume or rotating live client secrets automatically.
