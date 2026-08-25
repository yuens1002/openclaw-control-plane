# Runtime Registry Version Compatibility Plan

Issue: https://github.com/yuens1002/openclaw-control-plane/issues/57
Branch: `fix/runtime-registry-version-57`
Status: implemented and locally verified; pending external PR review

## Outcome

Restore startup compatibility when an operation gains an expanded output
contract. Existing operation versions remain immutable, while the expanded
contract is published as a new version and used by mixed-output examples.

## Deliverables

| ID | Deliverable | Evidence |
| --- | --- | --- |
| D1 | Immutable versioned registry definition | Version 1 retains its original allowed result types and version 2 declares the expanded set. |
| D2 | Version-aware conformance fixtures | Mixed result-and-artifact commands target version 2 while version 1 callers remain valid. |
| D3 | Persisted-registry upgrade regression | PostgreSQL synchronization proves an existing version 1 row is preserved while version 2 is added. |
| D4 | Release verification | Focused and full tests, typecheck, build, diff checks, deployment readiness, and authenticated tool calls pass. |

## Implementation

1. Restore the original version 1 operation registration without changing its
   schema, handler, authorization, or approval contract.
2. Register version 2 with the expanded allowed result types.
3. Move mixed-output conformance fixtures and lifecycle assertions to version
   2 while preserving explicit version 1 coverage.
4. Reproduce an existing-version upgrade against disposable PostgreSQL.
5. Complete exact-head review, merge through pull request, deploy, and verify
   authenticated write/read/provenance calls.

## Release Gates

- No migration rewrites or deletes an existing persisted registration.
- Startup synchronization accepts a database containing the original version
  1 contract and inserts version 2.
- Version 1 allows only its original result type; version 2 allows the expanded
  result and artifact types.
- The full repository gate and live readiness/tool-call checks pass.

## Non-Goals

- Changing runtime authorization or approval policy.
- Editing persisted registry definitions in place.
- Adding consumer-specific operation types or deployment configuration.
