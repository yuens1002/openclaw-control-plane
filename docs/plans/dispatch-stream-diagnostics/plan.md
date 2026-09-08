# Dispatch stream diagnostics

Issue: #123. Branch: `codex/dispatch-stream-diagnostics`.
Status: implementation authorized in conversation; no live deployment authorized.
Base: `63c5350e3501f69d0454086e2210d82d54d49321`; base precheck passed 394 tests.

## Problem and decision

The approved canary in the profile repository's issue #26 reproduced empty normalized output with length before tools executed. The completions adapter can discard tool blocks on length; persisted output does not identify what arrived. Add metadata collection around the existing adapter, not a speculative provider fix. Read-only inspection found running checkout revision 0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c; the package/version alone had not proved that revision. The root Dockerfile owns the pinned source build.

## Deliverables

| ID | Deliverable | Role |
| --- | --- | --- |
| D1 | Dependency-free, opt-in metadata collector and fail-closed build patch for the completions adapter | /backend-architect |
| D2 | Docker build/watch integration and operator enable/rollback instructions | /devops |
| D3 | Adversarial collector and patch integration tests | /test-engineer |

## Design and boundaries

Observe SDK-decoded chunks before normalization, final request scalar limits/counts after onPayload, pre-filter block counts, and final output metadata. Emit one bounded JSON record per attempt only with OPENCLAW_STREAM_METADATA_DIAGNOSTICS=1 and provider openrouter. No second stream reader, network call, retry, asynchronous logger or altered request. Never log arbitrary request/chunk/error objects, headers, prompt/generated/reasoning text or tool names/arguments. Missing usage differs from explicitly reported zero. Logging failures are isolated.

Use this repository's build-time patch convention. Exact source-hash guard fails on upstream changes; review/update the pin deliberately. Add the copied patch/helper paths to the existing Docker-derived watch inventory. No production mutation or second tag; prepare exact rollout proposal after verification. Runtime recording repair remains separately owned by profile #61.

## Cadence

User authorized continued scoped implementation in the actual owner repository; this overrides the engineering-base default cross-repo stop rule. Issue #123 created before code changes. Apply engineering-base, backend/devops/test roles; plan/AC gate before code, tests, independent read-only verification, QC, code review and holistic review. Human approves exact production action at the end. No UI checks apply. Codex tools replace unavailable Claude adapters while preserving independent review. Local hooks are not assumed active.

## Commit schedule

Plan/AC contract, implementation/tests/operator documentation, then verification record. The contract was authored and Gate 1 passed before code, but its commit was delayed until after the initial implementation; record this sequencing deviation rather than claiming contract-first commits.
