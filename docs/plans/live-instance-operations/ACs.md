# Live-Instance Operations Acceptance Criteria

**Branch:** `docs/live-instance-operations`
**Plan:** `docs/plans/live-instance-operations/plan.md`

## Context

This protocol governs how anyone — this repo's library code, a human at a
terminal, or an agent mid-session — may read or write state on an
already-provisioned live instance. It exists because two ungoverned live
operations occurred during an unrelated fix. The pass bar is therefore not
"the document reads well" but "would this have stopped what actually
happened," plus strict Public-Repo Rule compliance, since this repo is public
and the incident involved a private service and a live credential.

## Column Definitions

| Column | Filled by | When |
| --- | --- | --- |
| Plan ref | Author | At AC authoring; links each row to a plan deliverable ID. |
| Role | Author | At AC authoring; names the role that owns the deliverable. |
| Agent | Verification worker | During verification; PASS/FAIL with evidence. Never filled by the worker that implemented the row's deliverable. |
| QC | Orchestrating thread | After reading verification evidence; confirms or overrides. |
| Reviewer | Human reviewer | During manual review; final sign-off per AC. |

## Coverage Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-COV-001 | D5 | coordination | Plan exists and names the gated execution model | Read `docs/plans/live-instance-operations/plan.md` | Plan names branch, deliverables with owning role and stream, design decisions, execution model, commit schedule, dependencies, and out-of-scope items; the Dependencies section records the D7-approval gate on D8/D9 as a hard gate, not a suggestion | | | PENDING |
| AC-COV-002 | D6 | coordination | AC table exists with traceable workflow columns | Read `docs/plans/live-instance-operations/ACs.md` | Every AC row carries a valid Plan ref (D1–D9) and Role, plus Agent, QC, and Reviewer columns; no deliverable D1–D9 lacks at least one AC | | | PENDING |

## Functional Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-001 | D1 | security/ops | Classification is two-axis | Read the classification section of `docs/live-instance-operations.md` | Mutation tier and credential exposure are separate, independently-assigned axes; an operation can be benign on one and gated on the other, and the document states why a single axis is insufficient | | | PENDING |
| AC-FN-002 | D1 | security/ops | Deploy is its own mutation tier | Read the classification table | A raw deploy/redeploy command is classified distinctly from ordinary writes, and the rule for it reflects that it bypasses the PR-merge flow rather than treating it as a normal code change | | | PENDING |
| AC-FN-003 | D1 | security/ops | Credential-flow rule forbids argument-line secrets | Read the credential-flow section | The rule requires secrets to reach a command via stdin or environment and never via an argument string, and cites the existing in-repo pattern that already does this rather than inventing a new mechanism | | | PENDING |
| AC-FN-004 | D1 | security/ops | Pre-flight declaration is specified and justified as additive | Read the pre-flight section | The declaration enumerates target, tier, prior read, credential path, reversibility, and whether tested library code already covers the operation; and the document explains why it is not redundant with a run-command permission prompt, referencing that such a prompt did not fire on the incident's deploy step | | | PENDING |
| AC-FN-005 | D1 | security/ops | Existing library paths take precedence over ad hoc use | Read the protocol against `docs/setup-profile-applier.md` | The protocol generalizes the existing "do not call the mutating endpoints outside the tested path" rule to the whole live surface, and does not narrow or weaken it | | | PENDING |
| AC-FN-006 | D1 | security/ops | Prod-state change procedure exists | Read the prod-state procedure section | The procedure states how a live configuration or deploy change is proposed, reviewed, applied, verified after the fact, and rolled back; verification-after-write is required, not optional | | | PENDING |
| AC-FN-007 | D1 | security/ops | Every researched gap is dispositioned exactly once | Cross-check the protocol and plan against the research findings | Each identified gap appears exactly once as in-scope, named-follow-up-with-recommended-fix, or explicitly-excluded; none is silently dropped, and none appears in two categories | | | PENDING |
| AC-FN-008 | D2 | tooling/devops | Tier markers present and accurate | Read each of the seven named modules | Every named module carries a tier-marker header referencing the protocol, and the tier assigned matches that module's actual behavior when read — not the tier that would be most convenient | | | PENDING |
| AC-FN-009 | D3 | security/ops | Destructive unused capability is escalated | Read the filed issue and the protocol's classification table | The capability is classified Forbidden in the table, and an issue proposes deletion on the grounds that it has no callers, rather than proposing a gate around unused code | | | PENDING |
| AC-FN-010 | D4 | security/ops | Cross-references resolve without contradiction | Read all four documents together | Each cross-referenced document points to the protocol for the general rule and retains its own specific rule; no rule is restated in two places with different wording | | | PENDING |
| AC-FN-011 | D7 | tooling/devops | Mount analysis is evidence-based | Read the analysis against the wrapper and gateway routing code | The analysis states, with file-level evidence rather than inference, whether the wrapper's auth gate can observe the gateway's base-path configuration; and recommends a single target end state rather than leaving both open | | | PENDING |
| AC-FN-012 | D7 | tooling/devops | Analysis touches no live state | Review the analysis method | The analysis is produced from code reading and already-public unauthenticated responses only; no authenticated live call and no write of any kind is made to produce it | | | PENDING |
| AC-FN-013 | D8 | tooling/devops | Prod remediation follows the protocol it is governed by | Compare the executed change against D1's procedure | The change was proposed, approved, applied, and verified per the documented procedure, with the post-change verification recorded; no step was skipped for expediency | | | PENDING |
| AC-FN-014 | D9 | tooling/devops | Exemption re-decision is recorded with rationale | Read the recorded decision | The decision states whether the merged exemption is kept, derived from configuration, or reverted, and justifies it against what the mount analysis actually established rather than against the original assumption | | | PENDING |

## Counterfactual Acceptance Criteria

These are the sharpest test: the protocol must demonstrably catch what already
happened.

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-CF-001 | D1 | security/ops | The deploy step would have been gated | Classify the incident's deploy command using only the protocol's table | It lands in the deploy tier and is forbidden ad hoc, requiring an explicit confirmation naming the target before it could proceed | | | PENDING |
| AC-CF-002 | D1 | security/ops | The credential step is caught on the credential axis alone | Classify the incident's read command using only the protocol's table, ignoring the mutation axis | It is forbidden by the credential-flow rule purely because a secret entered the argument string, independent of being a read. If the protocol only stops it via the mutation axis, this AC FAILS and the classification design needs rework | | | PENDING |
| AC-CF-003 | D1 | security/ops | Protocol is usable by someone without incident context | Have a reader with no background classify three commands not named anywhere in the document | All three are classified correctly using only the table and rules, demonstrating a general protocol rather than a narrative of one incident | | | PENDING |

## Compliance Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-SEC-001 | D1, D5, D6, D7 | security/ops | Public-Repo Rule compliance | Search every artifact for the live service name, its domain, the private profile repo name, client names, and internal tooling or workflow names | None appears in any committed artifact; the incident is described generically throughout. This is the most likely way this work ships broken, so it is checked by search, not by recollection | | | PENDING |
| AC-SEC-002 | D1 | security/ops | No credential value is reproduced | Search the protocol for any real secret, token, or password value | The document names credentials only by variable name and never reproduces a value, including in the incident annex's example commands | | | PENDING |
| AC-DOC-001 | D1 | security/ops | Citations are verified, not remembered | Re-read every cited file and line reference at verification time | Every file-and-line citation in the protocol resolves to code that actually supports the claim made about it. A prior plan in this repo recorded an AC built from prose that proved wrong once checked against reality; this AC exists because of that | | | PENDING |
