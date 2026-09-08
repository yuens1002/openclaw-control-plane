# Selected transport diagnostics — review

Candidate implementation: `c1a180d2d955a2e5e38dfb41980fe1ba81bc64fd`.
Base: `4ef71175caf9366ef3b8dd74f93b51be370a2e1e` (fetched and ancestry checked).
Date: 2026-09-08. Release version: 0.7.5.

Status: independent AC verification, main-thread QC, OCR and holistic review passed.
Ready for human review; merge and live rollout are pending. One implementation
iteration with a coverage correction and log-capture/setup-cleanup corrections
in the test harness; no production runtime correction was needed.

## Artifact binding

The candidate's full Docker build passed. Final-image checks passed independently
against `sha256:9bc2bdb21a4ff0a01c7206f4e999cc99544bd4d7fe46915d2487a159e58a3748`.
See [verification.md](verification.md) for the runtime manifest, exact scope,
test counts, mutation evidence and limitations. [handoff.md](handoff.md) defines
the bounded owner procedure. No live rollout or recovery is claimed.

## Deliverables and invariant checks

| Deliverable | Implementation / evidence | Docs updated | Result |
| --- | --- | --- | --- |
| D1 | evidence.md: selected resolver chain, lookup 404, unknown historic budget | yes | PASS |
| D2 | test-selected-transport and mutation scripts; focused collector/patch tests | yes | PASS |
| D3 | patch-openai-stream-metadata.mjs and shared openai-stream-metadata.ts | yes | PASS |
| D4 | existing Docker COPY/watch paths inspected; full runtime image executed | yes | PASS |
| D5 | handoff.md, verification.md and this review | yes | PASS |

No code changes fall outside the deliverables. The version bump is release
bookkeeping: manifest and lockfile both move 0.7.4 to 0.7.5 without dependency drift.
The current deployment watch reference excludes both root version files.

AC-TST-1 asserts real resolver reachability and requires the targeted mutation to
fail. AC-TST-2 asserts decoded counters, pre-filter/final blocks, usage presence
and EOF distinctions. AC-FN-1 compares 12 pairs of request payloads, event-type
ordering and final results, and observes the post-hook token limit on both sides
of the network boundary. These assert behavior rather than compiled marker text.
The comparator does not claim every intermediate event payload is identical.

## Independent verification, QC and OCR

Independent verifier `transport_ac_verify` reviewed implementation SHA `c1a180d`
and independently ran the precheck and both final-image scripts. Main-thread QC
checked its evidence against the actual assertions and artifact digest. Its
remaining handoff-binding condition is fulfilled by this report's explicit
candidate/artifact binding. All eight Agent/QC ACs pass; human Reviewer cells remain pending.

OCR v1.11.6 resolved base `4ef7117`. Review scope was `4ef7117..b352db4`;
subsequent runtime code is unchanged. Four fresh read-only reviewers covered:

- `ocr_lock`: package-lock.json, complete group 1 rules — no findings.
- `ocr_manifest`: package.json, complete group 2 rules — no findings.
- `ocr_transport`: four metadata/patch/harness scripts, complete group 3 rules — no findings.
- `ocr_transport_tests`: default-path-excluded unit test, global historical rules
  including test completeness and public-repo hygiene — one medium finding.

The medium finding was lost choice-level usage coverage after replacing the old
adapter suite. Restored a direct collector test asserting `choiceUsageSeen` and
input/output/total counters while top-level usage stays absent. The final full
precheck passes 403 tests in 29 files, including nine focused tests. This correction
does not change deployed code; the final-image 14 cases and mutation remain valid.
One whitespace-only harness cleanup removes blank lines at EOF.
The supplemental reviewer inspected fix SHA `91ef8cdbbc5c9d0e7b6f07405bbcc9c9dcac2b18`
and independently ran all nine focused tests, closing the finding. Runtime bytes
remain those of `c1a180d`; final test and documentation changes are included in
`91ef8cd`. The external-review correction below changes only the test harness.

Coverage: six regular OCR files plus one supplemental test file reviewed. Thirteen
unsupported-extension files (prose and upstream fixture add/delete) were excluded
by OCR and inspected in the holistic pass. No unresolved critical/high/medium or
low findings remain. ReportFindings is not available in this runtime; findings
and disposition are preserved here instead.

## Holistic documentation and scope audit

Copilot round 1 reviewed `6481fed` and reported one in-scope medium test issue:
the harness parsed unrelated JSON-looking stderr without a guard. Its complete
review body had no suppressed findings. Capture now guards only parsing and
forwards unrelated logs to the original sink; the intentional diagnostic sink
exception remains outside that catch. The visible scenario exercises malformed
and valid unrelated JSON. Both final-image scripts were rerun: 14 scenarios and
the targeted mutation pass. The production image inputs did not change.
GitHub CI passed `6481fed`; the corrected head requires its own CI result.
Internal fix review covered `6481fed..e02e7ae`: the OCR transport reviewer found
no actionable issue and confirmed the intentional sink exception remains outside
the parsing catch. Main-thread holistic recheck found the AC counts, scope and
evidence unchanged. Full precheck passed at `e02e7ae`: 403 tests, 29 files.

Copilot round 2 reviewed `a3c592f` and reported one in-scope medium harness setup
cleanup gap, with no suppressed findings. The try/finally now covers stderr
replacement, server creation/listen and model setup; listen errors reject the
setup promise. Cleanup restores stderr and closes any listening server. A forced
post-listen setup failure asserts rejection and stderr restoration; the script
exits cleanly. Final suite: **15 cases** (the original 14 plus setup cleanup) and
the targeted mutation pass against the same production image. No third Copilot
round is requested; the workflow closes round-2 findings with local verification.

- Current operations guide names the selected application-owned transport and
  removed SDK integration. README → docs index → diagnostics guide is reachable.
- Plan status reflects implementation; the added structured-content case explains
  its evidence-driven departure from the initial list. Historical plans remain
  point-in-time records, per this repository's documentation convention.
- Changelog, ACs, evidence and handoff agree that synthetic diagnostic reachability
  is verified and production recovery is not. The final 403 count is distinguished
  from the earlier independent 402-test run and the separate 14-case suite.
- Local references, section anchors, counts, deictic references, correction
  propagation and procedure consistency were inspected. No dangling reference or
  copyable example contradicts the contract. The Docker example was executed in
  its equivalent PowerShell form; the mounted scripts used only loopback traffic.
- Public issue #123 and merged PR #124 were inspected as linked background.
  New artifacts contain no private tenant/service/deployment IDs, operational
  domains, raw trace/payloads or credentials. No introduced or pre-existing
  private-entity/voice issue was found in the touched public files.

## Engineering-base confirmation and adaptations

Discovery followed retained traces through pinned resolver/factory/processor and
read existing collector, tests, build inputs and operating docs before editing.
Backend, test-engineer and devops role guidance and engineering-base were applied.
The build owner is the correct layer; no runtime policy or model settings moved
into this repository. One shared collector keeps sanitizers and counters in one
place. Scenario data drives one harness; no new production abstraction or registry
was needed. Patch anchors and fixture hash are intentionally explicit and fail
closed. Naming remains searchable. Final duplication audit found no second
collector or copied resolver implementation.

Gate 1 passed five deliverables/eight ACs/zero orphans. Gate 2 used this backend
adapter's documented invariant inspection, not a fabricated lint command. No UI
verification applies. Available Codex agents replaced the skill's named model;
verification independence, review scopes and phase order were preserved.

## Lessons and next step

The previous retrospective's selected-path rule worked: baseline red, corrected
path green, removal mutation red, and independent final-image execution all ran
before spending another canary. The excluded-test review also caught a regression
that a green replacement suite could miss. This is already covered by the OCR
test-completeness rule; no duplicate global rule is needed.

Next: human review, then the approved PR close-out cadence. A separate concrete
deployment-owner approval must cover the handoff's one-trigger window and cleanup.
The actual empty-turn mechanism and downstream recording/attestation outcome remain
unresolved until that evidence is obtained.
