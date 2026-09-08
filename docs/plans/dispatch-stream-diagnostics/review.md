# Review — dispatch stream diagnostics

Date: 2026-09-08. Base: `63c5350e3501f69d0454086e2210d82d54d49321`, freshly fetched and confirmed ancestor of HEAD. Implementation: `8fecff9`; review corrections: `8c79dc6`.

## Verdict and scope

Repository verification passed; no outstanding code-review findings. Docker build validation is still pending at this report revision. This change supplies opt-in diagnostics, not a production repair. No deployment, new live trigger or flag change was performed during implementation.

## Deliverables and tests

| Deliverable | Implementation | Documentation |
| --- | --- | --- |
| D1 | scripts/openai-stream-metadata.ts; scripts/patch-openai-stream-metadata.mjs | docs/openai-stream-diagnostics.md |
| D2 | Dockerfile; canary watch reference | same operator guide; docs/README.md index |
| D3 | tests/openai-stream-metadata.test.ts; exact upstream fixture with license | fixture README |

No unrelated application code changed. The upstream fixture is 1,446 lines of unmodified test input, not a second maintained adapter implementation.

Independent verifier `diagnostic_review` reviewed all five criteria at the implementation working tree before commit `8fecff9`, and independently ran Gate 1, focused tests and precheck. Result: 3 deliverables, 5 criteria, 17 new focused tests; full suite 29 files/411 tests, none skipped. Typecheck/build passed. QC accepted the evidence with the explicit limit that mocked adapter dependencies do not validate the whole SDK/runtime. Tests execute the real pinned stream function, asserting pre-filter versus post-filter block counts rather than reproducing the normalization branch.

## Separate line-level review

OCR v1.11.6 resolved the base and rule groups. Four production files were reviewable; eight were excluded by extension/default path. The test file was explicitly added back with its resolved rules. Three fresh read-only Codex reviewers covered the Dockerfile, watch reference, and collector/patch/tests groups at `8fecff9`. The user authorized model substitution; the skill's named model was unavailable. Fixture licensing and provenance were inspected separately; documentation receives this holistic pass rather than being represented as OCR-reviewed code.

No functional/security findings. Two low rule-compliance findings were corrected in `8c79dc6`: replace Function constructors in tests with compiled CommonJS modules, and use strict null/undefined presence checks plus flat finish-reason handling. These routine corrections were completed under the user's instruction to continue the scoped work, rather than asking separately about each low finding. The code reviewer rechecked both changes and confirmed resolution with no new findings. The 17 focused tests passed after the corrections.

## Cross-artifact review

- Request capture follows onPayload; observation precedes the chunk guard; normalization snapshot precedes tool removal; finalization is in finally. No second stream reader, retry or request modification was added.
- Usage absence and zero differ. Character counts are documented as string lengths, tool entries as deltas, reasoning totals as possibly mirrored, and routing IDs as unverified provider metadata. Adapter completion is not described as agent-run success.
- Source hash is checked before writes; companion overwrite is refused. The exact fixture matches the upstream source hash. Relative helper imports enter the upstream AI bundle per its tsdown configuration; Docker build completion remains a separate requirement.
- Docker COPY inputs and watch reference agree with the existing mechanical guard. The operator guide explicitly says the native live watch list is not changed by editing that reference file.
- The guide includes default-off behavior, shared-process scope, exact-state rollback requirements, serving readiness and byte readback. It does not present a generic procedure as live approval.
- Local documentation links resolve; counts, headings and intra-document claims checked after the final code fix. No previous product behavior was removed. The new operator guide is indexed in docs/README.md.
- Applied docs/README.md's public-repo rule. Deployment-specific identities, source incident URLs and generated run identifiers are kept in the deployment owner's record. An initial issue-body link to that record was removed during hygiene review; public artifacts now describe the problem generically. No payload/credential data is included in fixtures; upstream MIT attribution accompanies the retained source.

## Base-layer confirmation

Discovery/read-before-write: existing wrapper patch scripts, sibling tests, Dockerfile, watch guard, upstream adapter and AI bundler were inspected. References: engineering-base, backend/devops/test roles, workflow/review adapters and live operations procedure. Layer: build-time integration owns instrumentation; no workflow policy is moved into the generic control plane. DRY: one collector, one patch, one watch derivation; fixture is immutable upstream test input. Variants: extend no provider registry; exact opt-in provider gate is deliberate. Values: runtime observations remain data; source hash is an intentional compatibility guard. Names identify request/chunk/normalization stages. No shared abstraction introduced beyond local sanitizers/counters. Duplication grep found only the intended collector export, patch insertion and tests. Claims derive from source/test output; full runtime and production claims remain excluded.

## Remaining gates and retro input

Docker build evidence, human review, release/deployment and post-release retro remain pending. Plan/AC gate ran before code, but the contract commit followed initial implementation; that deviation is recorded in the plan.

For the devops/test-engineer baseline (canonical skills in the user's dotfiles command collection): preserve both sides of lossy normalization in diagnostics; validate build-time patches against immutable upstream fixtures and exercise the real loop with mocked external dependencies. Existing base principles already cover measured claims and boundary tests; evaluate whether a new rule is necessary during retro instead of duplicating them.
