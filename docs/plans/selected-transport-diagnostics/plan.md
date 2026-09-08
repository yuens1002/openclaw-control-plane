# Selected transport diagnostics — plan

Date: 2026-09-08. Issue: [#123](https://github.com/yuens1002/openclaw-control-plane/issues/123).
Branch: `codex/selected-transport-diagnostics`.
Base: `4ef71175caf9366ef3b8dd74f93b51be370a2e1e` (fresh origin/main).
Status: implementation prepared; final-artifact and independent verification underway.
Cadence: full. Planning was approved before implementation. No UI/login preflight
applies to this build integration. No deployment or model call is part of this iteration.

## Problem and evidence boundary

PR #124 successfully built and packaged diagnostics in the SDK completions
adapter. The deployment owner's bounded canary selected
`boundary-aware:openai-completions`, which bypassed that adapter. No diagnostic
record was produced; the run still ended empty with length and no tools.
The owner retains identifiers, private configuration and raw incident evidence.

At pinned upstream revision `0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c`,
`src/agents/embedded-agent-runner/stream-resolution.ts` selects
`createBoundaryAwareStreamFnForModel`; `src/agents/provider-transport-stream.ts`
routes the completions API to `createOpenAICompletionsTransportStreamFn` in
`src/agents/openai-transport-stream.ts`. Revalidate this chain against the exact
source used for implementation; do not rely on these names alone.

The selected transport initializes usage to zero, can suppress reasoning, and
removes non-executable tool blocks. Therefore recorded zero usage does not prove
reported zero usage, and empty final content does not establish empty upstream
output. Do not remove tool safety filtering or change token caps on this evidence.

## Deliverables

| ID | Deliverable | Kind | Owning role |
| --- | --- | --- | --- |
| D1 | `evidence.md`: selected call chain, available historical metadata, effective token-budget inputs and explicit unknowns | evidence | /backend-architect |
| D2 | Resolver-to-network synthetic-stream test harness against pinned real upstream selection and transport | test | /test-engineer |
| D3 | Reuse the bounded collector in a source-hash-gated patch of the selected transport | build integration | /backend-architect |
| D4 | Docker/watch integration, full final-image verification and updated `docs/openai-stream-diagnostics.md` | operations | /devops |
| D5 | `review.md` and a deployment-owner handoff defining one bounded canary, cleanup and evidence-based next decision | operations | /devops |

## Sequence and decision gates

1. D1: inspect retained evidence first. The owner may attempt a read-only lookup
   of the already captured provider response ID. Record unavailable/404 results
   honestly. Inspect model/options and payload hooks to derive token-budget
   inputs; label reconstructed values and missing/redacted inputs. Do not publish
   private payloads or claim a reconstruction is the original wire request.
2. D2: create a failing diagnostic-reachability test using the real resolver,
   selected factory and stream processor. Mock only the network boundary, with
   synthetic non-sensitive streams. Existing tests that replace the factory do
   not satisfy this deliverable. If the environment cannot execute this path,
   document the blocker and do not substitute a direct adapter test.
3. D3: add observation immediately before the actual SDK request after all payload
   transformations, on decoded chunks before filtering, before tool-block removal,
   and at finalization. Reuse the collector rather than duplicate its sanitizers.
   Include safe scalar reasoning-emission/budget metadata where needed to
   distinguish suppression from absence. Avoid a second stream reader.
4. Decide explicitly whether to remove the bypassed SDK patch or retain it for a
   documented caller. Default proposal: relocate the integration to the required
   transport and keep one collector. Do not instrument unrelated providers.
5. D2/D4: prove the test fails when selected-path instrumentation is removed;
   compare enabled/disabled request and output behavior; run regression checks
   and build the final image. Execute the synthetic selected-path smoke against
   that artifact. Marker presence alone is insufficient.
6. Independent AC verification must challenge path selection and mock boundaries;
   then QC, OCR code review, holistic review, human review and commit/release
   cadence. Record exact commits and verification limits. No planning-only PR.
7. D5: hand off the exact release candidate to the deployment owner. A fresh,
   explicitly bounded rollout is required before another live trigger. Observe
   the selected-path diagnostic and the run's terminal outcome, then restore the
   flag's prior state and verify the process and authenticated readiness.

## Required synthetic cases

Visible text success; genuinely empty length; reasoning-only output with emission
disabled; partial tool calls ending length; absent versus explicitly zero usage;
EOF without a finish event; pre-stream/mid-stream failure and abort. Include
adversarial metadata, throwing log sink, disabled flag and non-target provider.
Assertions distinguish decoded input, pre-filter blocks and final output without
storing content. Scenarios show mechanisms, not which occurred in production.

## Rollout contract to prepare, not execute under this plan

Name exact targets/revisions, active sessions, staged configuration and prior flag
state. Deploy default-off and verify readiness/selected-path artifact. Enable
only the diagnostic flag with a deliberate deployment strategy; configuration
changes may rebuild the image. Send one fresh preflighted trigger, with no
automatic retries. Remove the flag after terminal completion or the bounded
timeout. Check whether deletion actually creates a deployment; if not, apply the
approved redeployment explicitly. Verify running-process absence and authenticated
readiness. Preserve unrelated staged changes throughout.

## Next decision after evidence

- Unexpectedly small outgoing budget: trace its derivation and scope a budget fix.
- Reasoning/tool content received but removed: distinguish intentional safety
  behavior from a normalization defect before changing behavior.
- Empty decoded response with a sensible request: pursue provider/model routing
  evidence and a separately scoped comparison; do not infer causality from one run.
- Missing diagnostics again: stop; the reachability gate failed. Do not send retries.

This iteration supplies trustworthy evidence, not a promised production repair.
Runtime recording/attestation remains a deployment-owner dependency to validate
separately once model execution reaches tools. No policy grants, model/provider
changes, retries, extra canaries or removal of tool safety gates are bundled here.

## Workflow adaptation

Codex agents may fill the role responsibilities; model choice may vary while
verification independence and phase order remain fixed. There is no local gate
adapter assumed active: check Plan-ref coverage mechanically, inspect invariant
wording, and require the independent verifier to check each implemented AC.
The acceptance criteria began as a proposed contract; current results are tracked
in [ACs.md](ACs.md). The bypassed SDK integration was removed as proposed. A
structured-content-array case and scalar entry counters were added because zero
string counts cannot establish absence of decoded structured content.
