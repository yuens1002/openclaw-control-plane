# /review report — client-template-pinning

**Branch:** `feat/client-template-pinning`
**Generated:** 2026-08-16
**Iterations to reach verified:** 2 (Phase 3 sub-agent pass, then this Phase 4.5 pass, which found and fixed one real bug Phase 3 missed)

## Verdict

**Minor, all fixed.** One real security bug (secret-bearing stdout echo, caught only by loading `/devops`'s own retro history before scanning — see below) and one plan/AC documentation drift (a command-shape detail that didn't match the implementation) were both found and fixed during this pass. No open issues remain; ready for human review.

## Deliverables ↔ Code

| Deliverable | Implementation | Status |
|-------------|----------------|--------|
| D1 (plan+ACs docs) | `docs/plans/client-template-pinning/plan.md`, `ACs.md` | ✓ shipped |
| D2 (shared helpers) | `packages/openclaw-railway-installer/src/index.ts:266,295,300,330,362` | ✓ shipped |
| D3 (relocate railway-variables) | `packages/openclaw-railway-installer/src/railway-variables.ts` (new), `packages/openclaw-setup-applier/src/railway-variables.ts` (re-export) | ✓ shipped |
| D4 (provisionClientInstance) | `packages/openclaw-railway-installer/src/provision-client.ts:88-179` | ✓ shipped |
| D5 (updateClientTemplateRef) | `packages/openclaw-railway-installer/src/provision-client.ts:200-215` | ✓ shipped |
| D6 (CLI entrypoints) | `packages/openclaw-railway-installer/src/client-cli.ts` | ✓ shipped (one bug found+fixed mid-review, see below) |
| D7 (PowerShell wrappers) | `deploy/openclaw-railway/provision-client.ps1`, `update-client-template-ref.ps1` | ✓ shipped |
| D8 (mocked tests) | `tests/openclaw-railway-provision-client.test.ts`, `-update-client-ref.test.ts`, `-client-cli.test.ts` | ✓ shipped, 21 new tests, all pass |
| D9 (docs) | `deploy/openclaw-railway/README.md` §"Agency-Controlled Client Provisioning" | ✓ shipped |

### Code changes not tied to any deliverable

One: `README.md:54` (root, not the deploy README) — a one-line directory-listing description that was accurate before this feature and became slightly stale by omission once `deploy/openclaw-railway` grew a second purpose. Fixed in this pass (Step 3, docs drift scan) as a trivial, in-scope correction rather than a separate deliverable — it's a single description line, not new documentation content.

## ACs ↔ Tests (Gate 3 spot-check)

Spot-checked (not exhaustive — the Phase 3 sub-agent already read every test body against every AC; this re-samples the highest-risk rows):

| AC | Test file | Asserts invariant? | Notes |
|----|-----------|---------------------|-------|
| AC-PROV-001 | `openclaw-railway-provision-client.test.ts:94-125` | ✓ (after AC text correction) | Test always matched the implementation; the AC's prose was stale (`--new`), not the test. Fixed in Phase 4. |
| AC-PROV-006 | `openclaw-railway-provision-client.test.ts` "reuses the service's actual SETUP_PASSWORD..." | ✓ | Asserts the *value flows from the mocked variable-list response*, not a literal — correctly avoids the brittle-literal trap. |
| AC-PROV-008 | `openclaw-railway-provision-client.test.ts` "passes SETUP_PASSWORD ... byte-identical..." | ✓ | Asserts absence of BOM/CRLF via regex against the captured `stdin`, not a hardcoded golden string — correctly scoped as an invariant. |
| AC-UPD-001 | `openclaw-railway-update-client-ref.test.ts` | ✓ | Asserts exact call count (2) and exact arg arrays, plus a loop over *every* call's `--service` value — stronger than the AC's own minimum bar. |
| AC-CLI-003 (added this pass) | `openclaw-railway-client-cli.test.ts` "never writes the spawned process's stdout..." | ✓ | Exercises the real `spawn`-based `runCommand` directly, no fake runner — closes exactly the coverage gap that let the bug ship in the first place. |

No weak/vacuous tests found among the sampled rows.

## Docs drift

- `README.md:54` (root) — fixed in this pass, see above.
- No other stale claims found. Grepped `README.md` and `deploy/openclaw-railway/README.md` for `clawdbot-railway-template`, `install-template`, `railway.toml`, and `template-lock.json` mentions — all still accurate against the current code.

## Recommendations

1. Before this path is used for a real client (not a mocked test), run one live smoke test in an explicitly throwaway Railway project and confirm the full sequence (link/init → up → volume → variables → redeploy → domain → health) against the real CLI, then delete the throwaway project — per `/devops`'s own existing retro principle ("Before promoting a client-facing PaaS installer from mocked tests to standard onboarding..."). This plan's Non-Goals already flag this as explicitly out of scope for this session; repeating it here as a pre-production gate, not a blocker for this PR.
2. `tsconfig.base.json` has path entries for `/provision-client` and `/railway-variables` but not `/client-cli` (Phase 3 finding). Harmless — `cli.ts`/`guard-cli.ts` also lack entries, and `tsc -b`/tests both resolve fine via `package.json` exports — but worth a follow-up pass if this repo ever tightens that convention. Not fixed here to avoid scope creep on a non-functional inconsistency.

## Inputs for /retro

- **Route:** `/devops` → `~/.claude/commands/devops.md`
  **Draft principle:** *"When copying a subprocess wrapper's `runCommand`-style stdout-echo behavior into a new CLI entrypoint, the check has to happen at review time even when the copy is deliberate and commented as such — a comment that says 'duplicated from X, X doesn't echo/does echo for reason Y' does not itself re-verify that reason Y still holds for the new file's actual command set. This branch's `client-cli.ts` carried exactly the comment pattern the existing retro principle warns about, copied from the safe `cli.ts`, and still shipped the leak until a `/review` pass (which loads role principles before scanning, per its own Step 0) caught it — the existing principle didn't self-apply just by existing in the role file; it had to be actively loaded and checked against."*
  **Triggered by:** AC-CLI-003 — this is not a new lesson, it's evidence that the existing lesson (already in `/devops`'s retro-sourced principles, "A subprocess wrapper that echoes a spawned CLI's raw stdout...") needs the `/review` Step 0 load-before-scan step to actually catch a repeat, since a plain code read without that context wouldn't flag a "looks like a normal echo-for-UX pattern" line as suspicious. No new principle text needed — recommend `/retro` cross-link this incident under the existing principle as a second confirmed occurrence, strengthening its "why" section rather than adding a duplicate entry.

- **Route:** `/project-manager` → `~/.claude/commands/project-manager.md`
  **Draft principle:** *(Already covered by existing principle "A plan naming a specific new function by identifier gets that name re-checked against the shipped code before Phase 3 verification, not left to drift" — AC-PROV-001's `--new` drift is the same failure mode one level up: a plan naming a specific *command shape*, not just a function identifier. Recommend broadening that existing principle's wording from "function by identifier" to "function, CLI flag, or command shape" rather than adding a new entry.)*
  **Triggered by:** AC-PROV-001 — plan.md described `railway up --new --name <client>`; implementation correctly used `init`/`link` + `up --detach` instead, but the plan was never updated to match.
