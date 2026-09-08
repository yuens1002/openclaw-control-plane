# Deployment-owner handoff — selected transport diagnostics

Status: prepared procedure, not executed or approved for live changes.
Candidate: the reviewed head of `codex/selected-transport-diagnostics`; the exact
implementation commit and final-image digest are recorded in `review.md` once
verification completes. Do not deploy a moving branch without resolving it.

## Preconditions and bounded authority

The deployment owner must copy the reviewed commit into the restricted incident
record and resolve exact project, environment, gateway service and any proof
service affected by the normal release flow. Read current source/deployment,
native watch inputs, active work, unrelated staged changes and the prior flag
state. Confirm the existing 11-input watch list against the current reference;
the patch/helper paths remain unchanged. Preserve unrelated staged settings.

Obtain fresh approval for that concrete rollout, any rebuild/restart, one trigger,
and the cleanup redeployment fallback. Approval of this repository iteration
does not execute that rollout. Keep deployment IDs, tenant identifiers and raw
provider/run evidence in the restricted record.

## Execution once approved

1. Deploy the exact reviewed revision with diagnostics disabled. Verify successful
   deployment, actual source/patch bytes, authenticated serving readiness and
   running-process flag state. Use an observed default-off attempt only if it is
   already authorized; this procedure does not authorize an extra model probe.
2. Enable only `OPENCLAW_STREAM_METADATA_DIAGNOSTICS=1` through the scoped change
   path. Establish whether that change triggers a rebuild or requires a deliberate
   redeployment. Read the flag from the running gateway process after readiness.
3. Preflight the single review target, current head, trusted mention and delivery
   routing. Send exactly one approved trigger. Capture delivery, selected stream
   strategy, response ID, diagnostic record and terminal run outcome. Never retry
   automatically, including when diagnostics are missing.
4. End the diagnostic window at terminal completion or **10 minutes after the
   trigger**, whichever occurs first. At timeout restore the flag immediately;
   do not infer that the run completed or send another trigger. If enabling the
   flag succeeds but the trigger cannot be sent, clean up without sending it.
5. Restore the exact previous flag state, preserving unset versus a value. Check
   whether the variable change created a deployment; otherwise explicitly invoke
   the approved redeployment fallback. Confirm successful deployment, flag state
   in the running process and authenticated readiness. A variable API response
   alone is not cleanup proof. Record terminal status or an explicitly unresolved
   run separately from cleanup.

The flag is process-wide: other OpenRouter completions may produce bounded
metadata during the window. Restoring the flag stops future logging after the
process replacement; it does not erase retained records. On a behavior regression,
use the recorded prior image/source and the approved rollback path.

## Decision from the captured evidence

- Small final outgoing budget: investigate its derivation before changing caps.
- Positive reasoning or tool counters with removed final blocks: distinguish
  intentional suppression/safety filtering from a normalization defect.
- Empty decoded response with plausible limits: scope provider/routing comparison
  separately; one result does not establish its cause.
- Missing selected-path diagnostics: stop and reopen reachability investigation.
- Model/tool execution succeeds: separately validate runtime recording and caller
  attestation before declaring review-dispatch recovered.

No policy changes, model/provider changes, additional comparisons, retries or tool
safety removal are included. Repository verification proves synthetic diagnostic
reachability and behavior equivalence within tested cases, not production recovery.
