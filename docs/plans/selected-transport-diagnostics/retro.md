# Retrospective — PR #124 follow-up

Date: 2026-09-08. Inputs: prior diagnostic review, post-merge issue #123 evidence,
and independent source-path assessment. Historical plan/AC evidence stays intact;
this document records what subsequent deployment verification disproved.

## Findings and applied lessons

1. Adapter tests, source hash and compiled markers proved the SDK adapter was
   packaged; they did not prove the application selected it. The observed strategy
   selected an application-owned transport. The verification contract omitted
   reachability, so multiple reviewers inherited the same assumption.
2. Missing usage was conflated easily with initialized zero fields. Empty final
   output cannot identify upstream contents after suppression/filtering. Preserve
   before/after evidence and label unknowns; do not treat hypothetical mechanisms
   as a root-cause finding.
3. Flag deletion succeeded without an automatic deployment. Cleanup was completed
   only after an explicit redeploy and process/readiness readback. Build and flag
   changes also have material latency that the rollout must budget for.

Canonical devops/test-engineer changes and global retro log were already shipped
in skills commit `1aa8813`. This explicit re-run verified those files against
origin/main and strengthened Rule 7: keep the real resolver/factory/processor and
mock only the network, with independent inspection of mock boundaries.
No duplicate OCR rule: these are verification/operations process gaps.

Validation by scenario: the previous direct SDK invocation and marker-only check
now fail the stated acceptance contract; a resolver test returning a fake factory
also fails it. Variable deletion without process readback cannot close cleanup.
The next plan's D1-D5 and ACs carry these checks, rather than relying on prose alone.

## Outcome

PR #124 merged and its bounded rollout completed with diagnostics disabled again.
The empty model turn remains unresolved. The next iteration is full-cadence
selected-transport evidence collection, beginning with existing evidence and an
offline reproduction. No application code or production configuration changes
were made during this retrospective/planning pass.
