# Selected transport diagnostics — acceptance criteria

Plan: [plan.md](plan.md). All implementation evidence is pending.
Planning approval does not establish these criteria have passed.

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-EV-1 | D1 | /backend-architect | Evidence supports the selected path | Source trace plus retained metadata inspection | Exact revision and concrete resolver-to-transport chain recorded; observed, reconstructed and unknown values distinguished; lookup failure is a valid recorded result | pending | pending | pending |
| AC-TST-1 | D2 | /test-engineer | Real path reaches diagnostics | Resolver-to-network synthetic invocation | Real resolver, factory and processor emit one diagnostic per attempt; only network is mocked; removing selected-path instrumentation causes failure | pending | pending | pending |
| AC-TST-2 | D2 | /test-engineer | Discriminate loss mechanisms | Execute every synthetic case listed in plan | Input counters, pre-filter blocks and final blocks reflect supplied stream; absent usage differs from zero; suppression, truncated tools and EOF are distinguishable | pending | pending | pending |
| AC-FN-1 | D3 | /backend-architect | Accurate observations without behavior changes | Enabled/disabled comparisons at real path | Capture final request scalars after hooks; request, stream ordering, retries and final output remain equivalent with flag on/off | pending | pending | pending |
| AC-SEC-1 | D3 | /backend-architect | Bounded and isolated diagnostics | Adversarial values, disabled/provider gate, throwing sink tests | Allowlisted bounded metadata only; no text, arguments, headers, secrets or arbitrary errors; logging failure cannot change completion | pending | pending | pending |
| AC-OPS-1 | D4 | /devops | Final artifact includes reachable integration | Hash-drift/reapply tests, full image build and synthetic smoke in final artifact | Drift fails closed; chosen old-patch disposition documented; real selected path emits metadata in final image; watch inputs match copies | pending | pending | pending |
| AC-REG-1 | D2 | /test-engineer | Repository regressions | Full precheck plus independent test-evidence audit | Existing tests/typecheck/build pass; no skipped applicable failures; mutation and mock-boundary evidence independently checked | pending | pending | pending |
| AC-OPS-2 | D5 | /devops | Review and bounded handoff | Cross-artifact review of release candidate and owner rollout contract | Exact revision and gates recorded; one-trigger/no-retry limit, timeout, explicit cleanup deployment fallback and process readiness proof required; no live success claim before execution | pending | pending | pending |
