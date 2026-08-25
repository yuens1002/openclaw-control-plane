# Runtime Registry Version Compatibility Acceptance Criteria

Plan: `docs/plans/runtime-registry-version-compatibility/plan.md`

Status: all local acceptance criteria pass; external PR review is pending.

| AC | Deliverable | What | Test | Pass condition | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AC-REG-001 | D1 | Preserve version 1 | Inspect registry and query synchronized rows. | Version 1 has only `example.reconciliation.delta`; version 2 has delta and report. | PASS - exact row values asserted in PostgreSQL. | PASS - source and persisted definitions agree. | Authorized for production recovery. |
| AC-REG-002 | D2 | Route expanded output to version 2 | Execute the mixed-output PostgreSQL lifecycle fixture. | The command, records, replay, approval, and projection complete under version 2. | PASS - lifecycle, retirement, replay, and attribution assertions pass. | PASS - command and every generated record use the same operation version. | Authorized for production recovery. |
| AC-REG-003 | D3 | Upgrade an existing registry | Delete only version 2 from a synchronized disposable database, then synchronize again. | Version 1 is unchanged and version 2 is inserted without conflict. | PASS - regression reproduces and verifies the additive upgrade. | PASS - no migration or persisted-row mutation is introduced. | Authorized for production recovery. |
| AC-REL-001 | D4 | Verify and release | Run focused/full tests, typecheck, build, diff check, live readiness, and authenticated adapter calls. | Every gate exits zero and the deployed service persists and reads an attributed runtime graph. | PARTIAL - 365 tests, typecheck, build, diff check, and production audit pass; live checks await merge. | PASS for local gates; live evidence remains a release gate. | Authorized for production recovery. |
