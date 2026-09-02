# /ac-verify (project override — openclaw-control-plane)

Sub-agent verification protocol for this repo. Inherits Phase 3's boundaries
from `/agentic-workflow` (`CAN`: read files, run tests, produce reports;
`CANNOT`: edit files, write code, commit, push). This override replaces the
generic doc's Playwright/screenshot instructions, which don't apply — see
`docs/AGENTIC-WORKFLOW.md` ("This repo has no browser UI").

## Inputs the sub-agent receives

- `BRANCH`, `ACS_DOC` (path to `docs/plans/{feature}/ACs.md`)
- Any deliverable-specific context the main thread includes

## Protocol

1. **Re-run Gate 1** — `node scripts/check-acs-coverage.mjs docs/plans/{feature}/plan.md {ACS_DOC}`. A failure here is a hard FAIL for every AC in the doc, not just the affected row — the ACs are not a valid contract.
2. **Functional ACs (`AC-FN-*`)** — code review per the row's `How` column: read the cited file(s), trace the behavior against the `Pass` cell.
3. **Test coverage ACs (`AC-TST-*`)** —
   - Run `npm test` and record pass/fail counts.
   - **Gate 3 per row:** does the named test actually assert the `Pass` invariant, or does it pin a literal that would pass vacuously? A green test that doesn't verify the stated intent is a FAIL.
   - **Adversarial direct-call check** (retro-sourced, from `/agentic-orca`): for any deliverable whose "what" is a pure function/predicate (filter, validator, parser), import the module yourself and call the exported function with at least one input you construct — not one copied from the test file — that probes the boundary between two plausible readings of its stated rule. Do not limit verification to inputs the test suite already covers.
4. **Regression ACs (`AC-REG-*`)** — `npm run precheck` (typecheck + test + build) all clean.
5. **Ops/deploy-adjacent ACs** — if the deliverable touches Railway config, prefer `npm run railway-template:check` / reading the Dockerfile diff over asserting against a live instance; live-instance verification is out of scope for a sub-agent (no credentials, no live writes) and should be recorded as DEFERRED with a note for the human reviewer, not PASS.
6. **External-artifact ACs** (retro-sourced): if a deliverable's action posts something outside the tracked tree (a GitHub issue, an upstream issue draft filed by the operator), fetch the *live* artifact (`gh issue view --json body`, not the drafted file) before marking PASS — a clean `git diff` proves nothing about what actually got posted.

## Returns

Structured PASS/FAIL per AC with evidence, same shape as generic Phase 3.
The main thread writes these into the `Agent` column of `{ACS_DOC}` — this
sub-agent does not edit files.
