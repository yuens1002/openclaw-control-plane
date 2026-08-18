# /review report — github-installation-connector

**Branch:** `feat/github-installation-connector`
**Generated:** 2026-08-18
**Iterations to reach verified:** 1 (no Phase 3 → Phase 4 fix loop needed; sub-agent found no gaps on first pass)

## Verdict

**Minor** — one real docs-drift gap (README.md's own Architecture list wasn't updated alongside `docs/architecture.md`'s), fixed in this pass; everything else is clean. Safe to proceed to `/commit` after the fix below lands.

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|-------------|----------------|--------|
| D1 | `docs/plans/github-installation-connector/plan.md`, `ACs.md` | ✓ shipped |
| D2 | `packages/openclaw-source-control-connector/{package.json,tsconfig.json,src/github-installation-provisioning.ts}`; `tsconfig.json`, `tsconfig.base.json`, `tests/tsconfig.json` resolution wiring | ✓ shipped |
| D3 | `tests/openclaw-source-control-connector-github-installation-provisioning.test.ts` | ✓ shipped |
| D4 | `docs/architecture.md` Packages entry | ✓ shipped |

### Code changes not tied to any deliverable

None. `git diff main..HEAD --stat` shows 10 files, all mapping cleanly to D1–D4.

## ACs ↔ Tests (Gate 3 spot-check, holistic re-derivation)

Re-derived independently (not trusting the Phase 3 sub-agent's report or this doc's own Pass-cell prose), applying `/test-engineer`'s Rules 6–8 and 14–15 by name:

| AC | Test file | Asserts invariant? | Notes |
|----|-----------|---------------------|-------|
| AC-GHCONN-001 | `...provisioning.test.ts:24-45` | ✓ | Rule 6/8 check: the AC names `buildAppJwt` and `crypto.verify("RSA-SHA256", ...)` — test calls exactly those, no mismatch. |
| AC-GHCONN-002 | `...provisioning.test.ts:48-83` | ✓ | Rule 14 check: AC claims "exactly once" + 4 specific header values — test asserts `toHaveLength(1)` plus all 4 headers individually (url, method, authorization, accept, x-github-api-version). Count and header set both match literally, no undercounting. |
| AC-GHCONN-003 | `...provisioning.test.ts:91-101` | ✓ | Asserts `GitHubProvisioningError` instance, `.status === 403`, and message excludes a body string that was actually present in the mocked response — a real negative assertion, not vacuous. |
| AC-GHCONN-004 | `...provisioning.test.ts:103-136` | ✓ | Three separate tests, one per missing field (`token`, `expires_at`, `permissions`), each asserting the error message names that specific field — matches the AC's "naming the specific missing field" wording exactly, not just "throws." |
| AC-GHCONN-005 | `...provisioning.test.ts:84-88` | ✓ | `toEqual` on the full mapped object — would fail on a dropped/renamed field, not just a missing one. |
| AC-COV-001 | `package.json`, `tsconfig.json` | ✓ (code review — structurally the only method; static config has no runtime behavior to unit-test beyond what AC-TEST-001 already proves by successfully resolving the import) | Rule 13 check: this is legitimately code-review-only, not a downgrade from an available test. |
| AC-TEST-001 | `...provisioning.test.ts:5-9` (import line) | ✓ | Imports via `@openclaw-control-plane/openclaw-source-control-connector/github-installation-provisioning`, not a relative `src/` path — and `npm run test` actually resolved and ran it (6/6), proving the `exports`/`paths` wiring live, not just that the file parses. |
| AC-DOCS-001 | `docs/architecture.md:22-30` | ✓ | States "not yet wired," cross-references both `openClaw-CoT-agency-profile#4` and the plan. See Docs Drift below for a gap this AC's own wording ("or a dedicated doc") didn't force a check of. |
| AC-REG-1 | full suite | ✓ | 179/179, independently re-run this pass. |
| AC-REG-2 | typecheck/build | ✓ | Both `tsc -b` invocations independently re-run this pass, zero output. |

No `WEAK`/vacuous-pass findings. No brittle-literal traps (no test pins a value that also lives in the module's own default/seed data).

## Docs drift

**Finding (Minor, fixed in this pass):** `README.md`'s own "Architecture" section (lines 44–56) maintains a second, separate packages list — it does **not** mention `packages/openclaw-source-control-connector`. This is the exact class of gap `/devops`'s own retro-sourced rule names: *"Grep the rest of the repo for a stale claim's language before considering a doc-correction deliverable done... a specific claim being corrected in one named file tends to be restated verbatim or near-verbatim in sibling docs... that weren't named in the deliverable."* D4 named only `docs/architecture.md`; `README.md` carries a sibling restatement of the same "here are the packages" claim and was missed.

**Scoping note:** README.md's list was *already* incomplete before this branch — it also omits `packages/openclaw-railway-installer` and `packages/openclaw-setup-applier`, both pre-existing and unrelated to this PR. Fixing those two is out of scope here (not this PR's deliverable, would be unrelated scope creep per `/project-manager`'s own "no scope creep" rule) — flagged as a separate, optional follow-up, not fixed. Only the line this PR's own new package needs is added.

**Not flagged as drift (deliberate, both this repo's own precedent and this plan's Background support it):** `README.md:40-41` ("Production connectors and client-specific assumptions are intentionally out of scope") and `docs/architecture.md:48` ("External connectors are intentionally out of scope") both predate this change and are left as-is. `openrouter-provisioning.ts` already establishes the precedent that an unwired, standalone provisioning primitive is compatible with this stated M1 boundary — the boundary reads as "production, client-wired connectors," not "any connector-shaped module can never exist." Revisiting that boundary statement's wording is a bigger, separate documentation decision this plan didn't scope in and shouldn't absorb silently.

## Recommendations

1. **Fixed in this pass:** add `packages/openclaw-source-control-connector` to `README.md`'s Architecture list, matching `docs/architecture.md`'s entry.
2. **Optional follow-up, not fixed here:** `README.md`'s Architecture list is missing two pre-existing packages (`openclaw-railway-installer`, `openclaw-setup-applier`) unrelated to this PR — worth a small standalone docs PR at some point, not blocking this one.
3. No other action needed before `/commit`.

## Inputs for /retro

- **Route:** `/project-manager` → `~/.claude/commands/project-manager.md`
  **Draft principle:** *"When a plan's docs deliverable names one doc file to update (e.g. `docs/architecture.md`'s Packages list), check whether the repo's own top-level `README.md` maintains a second, separate restatement of the same list — a common pattern in monorepos with both a detailed `docs/architecture.md` and a lighter README overview — and name both in the deliverable if so. This is the same class of gap `/devops`'s retro rules already document for sibling-doc drift generally; the specific new instance here is that a repo's README and its architecture doc can each independently list 'the packages,' and updating only one is easy to miss because both docs look authoritative."*
  **Triggered by:** AC-DOCS-001's `docs/architecture.md`-only scope missed README.md's sibling packages list.

- **Route:** cross-cutting → no template/pattern-catalog change needed
  **Note:** the existing `/devops` retro rule ("Grep the rest of the repo for a stale claim's language...") already covers this class of gap in principle; this instance is additional evidence for that rule, not a new pattern — no separate addition needed there.
