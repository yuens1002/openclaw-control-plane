# Acceptance criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-1 | D1 | /backend-architect | Distinguish input from normalized output | Feed empty length, partial tool length and successful chunks through collector and patched fixture | Separate upstream delta counters, pre-filter and final block counts; missing usage remains null while reported zero remains zero | | | |
| AC-SEC-1 | D1 | /backend-architect | Bounded, private, opt-in diagnostics | Disabled mode, adversarial values, huge/many chunks and throwing sink tests | Disabled returns no collector; only allowlisted bounded metadata emitted once; no raw text/arguments/headers/errors; logger cannot throw into adapter | | | |
| AC-OPS-1 | D2 | /devops | Reproducible build and operational boundary | Patch CLI, upstream hash, Dockerfile/watch guard, runbook inspection | Patch rejects drift/reapplication before writes; Docker copies collector before build; enable/deploy/rollback explicitly separated from implementation | | | |
| AC-TST-1 | D3 | /test-engineer | Meaningful behavioral coverage | Run tests against collector and patched executable adapter fixture | Success, empty length, filtered tools, missing/zero usage, pre-stream and mid-stream errors/abort covered; upstream source application/transpile checked independently | | | |
| AC-REG-1 | — | /test-engineer | Repository regression | Full precheck and coverage gate | Typecheck/build and existing tests pass; any limits stated without claiming live recovery | | | |
