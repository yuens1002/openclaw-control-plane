# Open Source Readiness Review

## Summary

This review tracks the final machine gate for making OpenClaw Control Plane
public as a workflow-neutral Chief of Staff control-plane foundation.

## Workflow Notes

- Branch created for this workflow: `feat/open-source-readiness`.
- Phase 0 dev-server and admin-login checks are not applicable in this repo:
  there is no project `CLAUDE.md` defining `DEV_SERVER_URL` or
  `ADMIN_LOGIN_PATH`, and the readiness gate is docs/config/security oriented.
- Project-specific agentic-workflow hooks and `.claude/verification-status.json`
  are not present in this repo. The plan records manual Gate 1/2 checks until a
  project-specific validator exists.

## Findings

No blocking findings remain.

The first verification pass found two workflow-neutrality failures:

- Core DB migration seeded the `vending` domain, pipeline, and worker.
- Core contracts exported vending-specific schemas and hard-coded vending event
  variants.

Both were fixed before the final pass: core contracts are generic, the baseline
DB migration/schema have no vending seeds or tables, and vending schemas now live
inside the example worker package.

## Verification

- Gate 1 coverage check: PASS - D1-D10 all have AC coverage.
- Gate 2 anti-drift check: PASS - AC Pass cells are invariant-style checks.
- `npm.cmd run typecheck`: PASS
- `npm.cmd run test`: PASS, 12 tests across 5 files
- `npm.cmd run build`: PASS
- `npm.cmd run railway-template:check`: PASS - pinned and latest upstream commit
  both `b9e2467189d02dfe51a80173c40bad650a58eaf2`
- `git diff --check`: PASS
- Focused installer/shell tests: PASS, 7 tests across 2 files
- Template-lock tests: PASS, 4 tests across 1 file
- Tracked-file public-release scan: PASS - no private Railway dashboard IDs,
  private operational URLs, obvious token patterns, provider keys, private keys,
  or tracked handoff artifacts found.
- Git-history secret scan: PASS - no obvious live token/private-key/dashboard-ID
  patterns or committed `.env.local`/handoff files found.
- `git check-ignore -v .env.local openclaw-railway-handoff.local.md`: PASS

## AC Coverage

All AC rows have Agent and QC evidence in
`docs/plans/open-source-readiness/ACs.md`. Reviewer column remains pending human
review.

## Residual Risk

- Repository visibility must not be changed until human approval is recorded.
- A git-history scan can reduce obvious exposure risk, but it cannot prove the
  absence of every possible private value.
- This repo does not yet have automated Gate 1/2 validators, so coverage and
  anti-drift checks are manual for this readiness workflow.
- Git history still contains older commits where vending was positioned and
  registered more centrally. This is not a credential leak, but a squash/rewrite
  before public visibility would produce a cleaner public narrative.
- Local `.env.local` exists and is ignored. Confirm it is never force-added
  before public release.
- The lock pins the public upstream `main` ref because the Railway dashboard's
  displayed `production` source label did not resolve to a public Git branch.
- The mirror repo/approved branch is documented and planned, but the GitHub
  mirror itself has not been created in this repo change.

## Recommendation

Approved for human review. Do not flip repository visibility until the human
Reviewer column is filled and the owner explicitly approves the public switch.
