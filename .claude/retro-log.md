# Retro Log

Running audit trail of process lessons captured by `/retro`, and where each
was applied. Not a memory file — memory/preference content lives elsewhere;
this is "what was learned and when."

## 2026-08-15 — setup-profile-applier (issue #7, PR #11)

**Gap:** A subprocess wrapper (`packages/openclaw-setup-applier/src/cli.ts`)
copied a sibling CLI's stdout-echo pattern verbatim, which streamed raw
Railway CLI output — including secret values, since `railway variable
list`/`variable set --json` return them raw per Railway's own documented
warning — straight to the terminal. Would have reprinted every secret on
the target service on the CLI's first real use, dry-run included.

**Root cause:** The copied wrapper was safe for its original caller (the
installer CLI never runs a variable-listing command), but the new caller's
actual command set changed the safety property, and nothing re-checked that
before reuse. No test could catch it either — every test in the suite
injects a fake runner, so the real spawn-based implementation carrying the
leak had zero test coverage, structurally, under this plan's no-live-calls
constraint (itself a response to an earlier incident this same session,
where an unscoped local `railway variable list` run printed real production
secrets while confirming a CLI output shape).

**Role:** `/devops`, `/security`

**Fix applied to:**
- `packages/openclaw-setup-applier/src/cli.ts` — stdout no longer echoed;
  captured for parsing only.
- `~/.claude/commands/devops.md` — new Retro-Sourced Principle: re-examine
  a copied stdout-echoing subprocess wrapper's safety per new call site's
  actual command set, not by precedent.
- `~/.claude/commands/security.md` — new Retro-Sourced Principles section
  (first for this role): a generic subprocess-echo pattern is a leak vector
  independent of what the application code logs.

**Prevented by:** Sharpened role principles for the next feature either role
owns that wraps a secret-bearing CLI. No automated gate exists for this class
of defect in this repo yet (would need something like a lint rule flagging
raw subprocess stdout piped to `process.stdout` in files touching
secret-bearing commands) — flagged as a possible future validator, not built.

---

**Gap:** `docs/plans/setup-profile-applier/ACs.md`'s AC-FN-009 named its
verification method as "Code review: `cli.ts`" — accurate, but didn't
distinguish "chose code review over a test" from "code review is the *only*
verification method that could ever exist here" (the real subprocess runner
has no test double under the no-live-calls constraint). The defect above
lived exactly in that structurally-untestable path.

**Root cause:** The AC table has no convention for marking a code-review-only
row as *structurally* code-review-only (permanent, by design) versus
code-review-only by choice (a test could exist but wasn't written). Both
read identically, so nothing in Gate 3 or a `/review` spot-check signals
"this row's coverage is weaker than its neighbors" without re-deriving it.

**Role:** `/test-engineer`

**Fix applied to:**
- `~/.claude/commands/test-engineer.md` — new Rule 13: when a code-review-only
  verification method is structural (no test double possible), say so in the
  `How` cell at authoring time, not just discover it in the Pass cell later.

**Prevented by:** Sharpened AC-authoring convention for the next plan any
role writes ACs for. No validator enforces this yet (would need a Gate 1/2
extension checking `How` cells for a "structural" marker) — not built.

---

**Gap:** The plan's D12 design decision (Railway variable writes switched
from an inline `KEY=VALUE` argument to piping the value via `--stdin`) was
added to `plan.md` correctly between Session 1 and Session 2, but the plan's
"Files to Edit" table was never updated to name
`packages/openclaw-railway-installer/src/{index,cli}.ts` — the two files
that decision actually required touching, in a package outside this
feature's own `packages/openclaw-setup-applier`.

**Root cause:** No check existed for "does an amended Design Decision
prose section imply a file outside the plan's original Files-to-Edit
table." The decision was correct and necessary; only the plan's own record
of it was incomplete, which `/review`'s Step 1 (deliverables↔code mapping)
had to reconstruct after the fact instead of the plan documenting it.

**Role:** `/project-manager`

**Fix applied to:**
- `~/.claude/commands/project-manager.md` — new Retro-Sourced Rule: a
  design decision added mid-plan updates the Files-to-Edit table in the
  same edit, not just the prose.

**Prevented by:** Sharpened PM discipline for the next plan amended
mid-session. No validator enforces this yet — not built.

**Source:** `docs/plans/setup-profile-applier/review.md` (Phase 4.5 `/review`
report — Inputs for /retro section, pre-routed and pre-drafted per that
skill's Step 0).
