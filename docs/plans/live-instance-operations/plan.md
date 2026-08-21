# Live-Instance Operations Plan

**Branch:** `docs/live-instance-operations`
**Protocol artifact:** `docs/live-instance-operations.md`
**ACs:** `docs/plans/live-instance-operations/ACs.md`

## Summary

Establish a governing protocol for reading and writing state on an
already-provisioned ("live") Railway/OpenClaw instance, apply a tier-marker
convention to the modules that do so, and remediate the one live
misconfiguration that prompted this work.

The trigger was a pair of ungoverned live-instance operations during an
unrelated bug fix: a deploy command run straight from a local checkout to a
live service (bypassing the PR-merge flow entirely, since deploys here are
one-shot snapshots — see the module header above `provisionClientInstance` in `packages/openclaw-railway-installer/src/provision-client.ts`),
and an attempt to interpolate a live setup password into a `curl` argument
string against the instance's raw-config endpoint. The second was blocked by a
permission prompt; the first was not gated at all.

## Current State

A research pass cataloged every live-instance-touching path in this repo.
Good patterns already exist but are unevenly applied, undocumented as a
general rule, and entirely absent for ad hoc (human or agent) command use.

Existing patterns worth generalizing:

- `packages/openclaw-setup-applier/src/apply-profile.ts` — idempotent
  (skips the mutating call when the instance already reports configured) and
  the only path with **post-write verification**.
- `packages/openclaw-railway-installer/src/patch-allowed-origins.ts` —
  compare-then-write, avoiding an unnecessary live gateway restart, but with
  no post-write verification.
- `packages/openclaw-railway-installer/src/approve-own-device.ts` — refuses
  (throws) under ambiguity rather than guessing which pending request to act on.
- `packages/openclaw-railway-installer/src/railway-variables.ts` — pipes secret
  values via stdin, never as command arguments, so they never land in shell
  history or a process listing.
- `packages/openclaw-railway-installer/src/guard-cli.ts` — a guard for direct
  human CLI use, requiring explicit service scoping and an acknowledgement flag
  before any command that prints secrets. Exists because of a prior real
  secret-exposure incident.
- `docs/setup-profile-applier.md` already states a narrow version of the core
  rule: do not call the mutating setup endpoints outside the applier's tested
  path.

Gaps: no rule covers ad hoc CLI or HTTP use against a live instance; no marker
distinguishes read-only from idempotent-write from destructive code paths; a
destructive config-reset capability exists with zero callers and no gate; and
the live instance carries a base-path misconfiguration (below).

## Approach

Three work streams. Streams A and B are independent and run in parallel.
Stream C is split so that only its read-only half runs in parallel — its
live-touching half is deliberately gated behind Stream A, because the entire
point of this work is that live changes follow the protocol rather than
precede it.

Every deliverable is implemented by a role-persona worker and verified
independently — no worker certifies its own output. Final reconciliation is
owned by the orchestrating thread, not by any implementing worker.

## Deliverables (with spec-role assignment)

| ID | Deliverable | Kind | Owning role | Stream |
| --- | --- | --- | --- | --- |
| D1 | `docs/live-instance-operations.md` — the protocol: scope, two-axis classification table, credential-flow rule, pre-flight declaration, prod-state change procedure, incident annex, decision section | doc | security/ops | A |
| D2 | Tier-marker doc-comment header on every live-touching module (CORS-patch, profile-apply, device-pairing-approve, Railway-variables, client-provisioning, setup-API-client, workspace-import) | doc-comment | tooling/devops | B |
| D3 | GitHub issue proposing deletion of the unused destructive config-reset capability | issue | security/ops | A |
| D4 | Cross-reference pass so `docs/setup-profile-applier.md` and `deploy/openclaw-railway/README.md` link to/from D1 without duplicating or contradicting it. `docs/adr/0001-identity-and-communication-boundary.md` is referenced **one-way only** (protocol → ADR): per `docs/README.md`, an ADR records a point-in-time decision and is not updated to match later state, so adding a back-link would violate the repo's own convention | doc | security/ops | A |
| D5 | This plan | doc | coordination | — |
| D6 | `docs/plans/live-instance-operations/ACs.md` | doc | coordination | — |
| D7 | Base-path mount analysis: determine the intended end state (root-mount vs base-path mount), verify whether the wrapper's auth gate is independent of the gateway's base-path config, and recommend a target state. **Read-only — touches no live state.** | analysis doc | tooling/devops | C1 |
| D8 | Correct the documentation that claims the Control UI is served under a base path, and make the root URL the documented entry point: `deploy/openclaw-railway/README.md` and the `Dockerfile` comment block above the exemption patches. Repo-only; **no live write** | doc | tooling/devops | C2 |
| D8b | Patch the wrapper's setup-page link from the prefixed path to the root path, using the same `sed` + `grep -F` assertion technique the `Dockerfile` already applies four times. Without this the setup page keeps sending users to a non-canonical URL that works only via the SPA fallback — and in the no-trailing-slash form, the branch that happens to work, so the breakage stays latent | code | tooling/devops | C2 |
| D8c | Close the root-mount residual risk: add the two root-level paths the browser fetches passively but that are absent from the exempt list — the assistant-media route (rendered as an `<img src>`, so no auth header can be attached) and the provider-icon assets (fetched as CSS `url()` backgrounds). Both are the same class as the avatar path this repo already had to exempt for exactly this reason. Reverting D9 without this trades one popup for another | code | tooling/devops | C2 |
| D9 | Revert the merged base-path auth exemption — decided by D7, not re-litigated here. **Strictly sequenced after D8, D8b, D8c**: reverting first re-fires the popup the exemption was merged to stop | code | tooling/devops | C2 |
| D10 | Rebuild, deploy, and verify against the live target under D1's prod-state change procedure: no auth challenge at the canonical root URL, the setup route still gated, the previously-404ing asset paths resolved, and — checked explicitly — the persistent volume still attached with state intact after the gateway restart | verification | tooling/devops | C2 |

## Design Decisions

**Two-axis classification, not one.** A single read/write/destructive scale
would misclassify the incident's blocked command: it was a read (GET), benign
on the mutation axis, and dangerous purely because a secret entered the
command line. The protocol therefore classifies independently on:

- *Mutation*: read → idempotent-write → unconditional-write →
  restart/redeploy-triggering → destructive → deploy.
- *Credential*: does the operation return a secret in its output, or require
  one supplied as input?

"Deploy" is its own mutation tier because a raw deploy command bypasses the
PR-merge flow by design, and nothing currently governs it.

**Pre-flight declaration.** Before any ad hoc command against a live instance,
the operator (human or agent) states, before running it: the target and
whether it is live/shared, the tier, what will be read first, whether a secret
enters the command and how argument-line exposure is avoided, reversibility
and redeploy risk, and whether tested library code already covers the
operation — if it does, ad hoc use is not permitted. This is additive to a
run-command permission prompt, not redundant with one: that prompt is a yes/no
gate with no structured content, and in the triggering incident it did not
fire at all on the deploy command.

**Operations doc, not an ADR.** Per `docs/README.md`, an ADR records a
point-in-time decision and is superseded rather than updated; this protocol
will accrue rows and rules over time, which is what an operations doc is for.

## Files to Create/Edit

- Create: `docs/live-instance-operations.md`
- Create: `docs/plans/live-instance-operations/plan.md`, `ACs.md`
- Edit (cross-reference only): `docs/setup-profile-applier.md`,
  `deploy/openclaw-railway/README.md`
- Edit (doc-comment headers only): the modules named in D2, plus any further
  live-touching module found during implementation (the initial list of seven
  grew to twelve once unlisted live-touching paths were found)

## Acceptance Criteria

See `docs/plans/live-instance-operations/ACs.md`. The pass bar is the
counterfactual test and Public-Repo Rule compliance, not readability.

## Gate 1/2 Pre-Check

Manual check required in this repo — no coverage or anti-drift validator
scripts exist yet. Coverage of every deliverable by at least one AC, and of
every AC by a valid plan reference, is confirmed by read-through.

## Execution Model

- **Stream A** (security/ops): D1 → D3 → D4, sequenced internally since D3 and
  D4 both depend on D1's finished content.
- **Stream B** (tooling/devops): D2 alone. Independent of D1's prose because
  the tier vocabulary is fixed by this plan.
- **Stream C1** (tooling/devops): D7. Read-only, parallel with A and B.
- **Stream C2** (tooling/devops): D8, D8b, D8c, D9, D10. Started only after D1
  landed and a human approved D7's root-mount recommendation. Unlike A/B/C1
  these are a strict dependency chain, not parallel work, so C2 is implemented
  directly rather than through multi-stream orchestration — the ordering *is*
  the safety property, and D9 before D8/D8b/D8c reproduces the original bug.

  Root-mount was chosen partly on a security ground surfaced by D7: under
  base-path mount the exemption would have to widen over a real mount, pulling
  genuinely auth-gated endpoints under a blanket bypass — and because the
  merged exemption also made the gateway Bearer token inject unconditionally,
  those requests would arrive at the gateway already authenticated. That
  exposure would be created by the remediation. Root-mount avoids it.
- **Wrap-up** (orchestrating thread, after all streams): runs the acceptance
  checks across all deliverables together — no implementing worker verifies
  its own output, and the final verdict is not delegated.

## Commit Schedule

1. `docs: add plan and ACs for live-instance operations` (D5, D6)
2. `docs: add live-instance operations protocol` (D1)
3. `chore: add live-instance tier markers to railway and setup-applier modules` (D2)
4. `docs: cross-reference live-instance operations protocol` (D4)
5. `docs: record base-path mount analysis` (D7)
6. (gated, likely separate branch) prod remediation and exemption re-decision (D8, D9)

## Dependencies

- D3, D4 depend on D1.
- D8, D9 depend on D1 **and** on human approval of D7 — this gate is the
  point of the whole plan and must not be collapsed for convenience.
- The base-path analysis (D7) must establish, with evidence rather than
  inference, whether the wrapper's auth gate can see the gateway's base-path
  configuration at all. The working hypothesis — that it cannot, because the
  wrapper's gate runs before proxying — determines whether the merged
  exemption is still required after remediation, and must be confirmed
  against the code and a live check rather than assumed.

## Out of Scope

Named, with the recommended fix stated, but not built here:

- The client-ref update functions perform an unconditional variable write and
  an unconfirmed redeploy. Recommend adding the compare-then-write the
  CORS-patch function already has, plus confirmation naming the target service.
- The workspace-file-import function performs an unconditional POST with no
  pre-read comparison. Recommend a compare step before it is ever wired into a
  provisioning path; low urgency while it has no callers.
- Programmatic Railway variable calls bypass the human-CLI guard's scoping
  checks. Moving the check to the process-spawn boundary is a real refactor,
  not a doc change.
- The CORS-patch function lacks the post-write verification the profile-apply
  function has. **This is the first recommended follow-up** — the protocol's
  own idempotent-write rule requires both halves, and this path currently has
  only one.
- The "never touches another service" invariant is prose, not code-enforced;
  a runtime assertion is future work.

Excluded with no follow-up: a duplicated Railway-CLI test fixture. Test
hygiene, unrelated to live-instance safety.
