# /review report — docs-hygiene-audit

**Branch:** `fix/docs-hygiene-private-repo-refs`
**Generated:** 2026-08-23
**Type:** Ad-hoc run (no in-repo plan/ACs — `/review`'s "no in-repo plan" edge case). Triggered by dogfooding the new Step 3.5 (Docs hygiene audit) added to the global `/review` skill this session, against this repo's full doc tree rather than a single feature's diff.

**De-facto owning roles** (Step 0 edge case): `/project-manager` (documentation conventions) and cross-cutting (the `/review` skill's own Step 3.5, since this is exactly the dimension it was built to catch).

## Verdict

**Minor** — no *newly introduced* leak; every finding is a pre-existing Kind A hit that predates this session's Step 3.5 addition. All are fixed on this branch. Proceed to human review.

## Docs drift

None found in this pass (scope was hygiene, not staleness; Step 3 was not run exhaustively this round).

## Docs hygiene / public-voice audit

Ran Step 3.5 against every tracked doc in the repo (`README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/**`, `deploy/**/README.md`, `.github/ISSUE_TEMPLATE/**`). This repo already declares its own convention (`docs/README.md`'s "Public-Repo Rule" — no private repo/agency/client name, even in passing) plus a "Document Types" section, so that convention governed the check per Step 3.5's defer-to-project-first rule.

| Finding | Kind | Location | Introduced or pre-existing |
|---------|------|----------|------------------------------|
| Full org/repo slug + live issue link naming the private client-profile repo | A | `docs/adr/0001-identity-and-communication-boundary.md:173` (pre-fix) | pre-existing |
| Repo named (no org) in a "not yet wired in" transport note, inconsistent with the generic phrasing one paragraph above it in the same file | A | `deploy/openclaw-railway/README.md:59` (pre-fix) | pre-existing |
| Repo named in session-origin framing | A | `docs/plans/onboarding-regression-pipeline/plan.md:16` (pre-fix) | pre-existing |
| Repo named describing Part 2's content ownership | A | `docs/plans/post-deploy-readiness/plan.md:40` (pre-fix) | pre-existing |
| Repo named twice (Summary + Out of Scope) describing where a sibling e2e is being built | A | `docs/plans/railway-cli-spawn-contract/plan.md:8,214` (pre-fix) | pre-existing |
| Repo + issue number named twice (header note + AC-DOCS-001 row) | A | `docs/plans/workspace-identity-transport/ACs.md:5,20` (pre-fix) | pre-existing |
| Repo named twice (Scope note + Non-Goals) describing content ownership | A | `docs/plans/workspace-identity-transport/plan.md:22,152` (pre-fix) | pre-existing |

No Kind B (wrong-altitude) findings beyond the ADR's already-merged 2026-08-22 self-correction (PR #49) — re-read in full during this pass, confirmed clean. No Kind C (personalized voice) findings; one borderline "What am I targeting?" decision-procedure phrasing in `docs/live-instance-operations.md:56` was considered and **not** flagged — it's a generic reader-facing rhetorical device in a checklist, not the maintainer's individual workflow written as the project's shape, so it doesn't match Kind C's actual failure mode.

**Transitive check:** the ADR's removed link pointed at a private repo's issue #6 — not followed (private, inaccessible, and the point of the fix is to stop naming it, not to audit its contents). No other touched doc referenced an issue/PR by number that itself needed a transitive check.

## Recommendations

1. All seven Kind A findings fixed on this branch — private repo name replaced with the same generic phrasing this repo already uses elsewhere ("a private client-profile repo"), issue-number cross-references preserved without the repo name attached.
2. Consider a periodic (not per-PR) sweep of `docs/plans/**` specifically — these are the highest-density source of this leak because plan/ACs docs get written fast, mid-session, before the generic-phrasing habit is front of mind; the top-level docs (`README.md`, `CONTRIBUTING.md`, `docs/architecture.md`) were already clean, suggesting the habit holds for docs written *as* public-facing but lapses for docs written as internal working artifacts that happen to live in the same public repo.

## Inputs for /retro

- **Route:** cross-cutting → `commands/review.md` (already applied this session, prior to this run)
  **Draft principle:** *(already shipped as Step 3.5 — this run is the dogfood/verification pass, not a new lesson)*
  **Triggered by:** this audit finding 7 real, previously-uncaught Kind A instances on the first real run, confirming Step 3.5 has actual signal rather than being a no-op addition.

- **Route:** `/project-manager` → `.claude/commands/project-manager.md` (global, not yet applied — flagging, not fixing, this session)
  **Draft principle:** *When a plan/ACs doc needs to reference a sibling private repo's work-in-progress (cross-repo framing, split ownership, "being built separately in..."), default to the repo's own established generic phrasing (e.g. "a private client-profile repo") at authoring time, not just at review time — the pattern in this audit was never a one-off slip, it recurred across 5 separate plan docs written in different sessions.*
  **Triggered by:** all 7 findings above.

## Note on scope

This pass covered files inside the repo (docs, plans, ADRs, READMEs). It did not cover GitHub issue/PR bodies (CONTRIBUTING.md's Public-Repo Rule extends there too, per the 2026-08-15 retro entry on issues #8-10) — that would need a separate `gh` API sweep and was out of scope for this run.

Unrelated to this audit: `docs/live-instance-operations.md` and two files under `packages/openclaw-railway-installer/src/` show uncommitted changes in the working tree from a concurrent, unrelated workstream (closing gap G4) — not touched by this branch.
