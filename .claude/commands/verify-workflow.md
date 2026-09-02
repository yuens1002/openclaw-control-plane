# /verify-workflow (project override — openclaw-control-plane)

Full orchestration of Phases 2-4 **without** a verification sub-agent — the
main thread does Implement and Verify itself in the same context. Use this
for small Full-cadence features (few deliverables, no benefit from
`/agentic-orca`'s parallelism, but still warranting Gate 1 + Gate 3
discipline) rather than spawning a sub-agent for a one-or-two-AC change.

## When to use vs. the alternatives

| Situation | Use |
| --- | --- |
| 3+ largely independent deliverables | `/agentic-orca` |
| Several deliverables, sequential/coupled, worth a fresh disposable context for verification | Classic Phase 3 sub-agent (`Agent(...)` per `/agentic-workflow`) |
| Small feature, verification doesn't need a separate context | This — `/verify-workflow`, main thread does both |

## Protocol

1. Implement per the plan + ACs (Phase 2, unchanged).
2. Run `npm run precheck` (typecheck + test + build). Fix immediately on failure.
3. Re-run Gate 1 (`node scripts/check-acs-coverage.mjs <plan> <ACs>`).
4. Walk every AC row yourself, in the main thread, using the same protocol as `/ac-verify` (adversarial direct-calls for predicates, live-artifact fetch for anything posted outside the tree, DEFERRED for anything needing live Railway credentials).
5. Write the **Agent** column yourself (there is no separate sub-agent report to transcribe) and immediately follow with your own **QC** column per Phase 4's mandatory protocol — don't skip QC just because one thread did both.
6. Update `.claude/verification-status.json` to `"verified"` once every AC passes.

The state machine, hooks, and Phase 4.4/4.5 (`/ocr-review`, `/review`) that follow are unchanged from `/agentic-workflow`.
