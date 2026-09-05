# /review report — canary-scoped-watch-deploy

**Branch:** `feat/canary-scoped-watch-deploy`
**Reviewed SHA:** `69f7a10b88a724d685609f72658522b2df8ae0b8`
**Generated:** 2026-09-04
**Iterations to reach verified:** 3 (initial D1–D5 implementation → mid-stream Public-Repo Rule self-leak fixup at `3f23d72` → full Config-as-Code framing pivot at `69f7a10`, with every previously-passed AC explicitly re-verified after the pivot, not silently carried forward)

## Verdict

**Minor** — clean on the two things it was most at risk for (surviving old Config-as-Code framing anywhere in the diff, and a repeat of the hygiene leak already fixed once this session), and every AC/test/precheck claim in `ACs.md` reproduces exactly against live commands. The findings below (present-tense overclaim of a Session-2 state, one date-bound fact in a durable doc) were fixed directly after this report was generated, rather than left for the human to flag. No loop back to Phase 3 needed.

## Step 0 — Roles loaded

Read `~/.claude/commands/devops.md`, `test-engineer.md`, `project-manager.md` (no project-local overrides exist for these three roles in this repo).

## Deliverables ↔ Code

| Deliverable | Implementation | Docs touched? | Status |
|-------------|----------------|----------------|--------|
| D1 | `deploy/openclaw-railway/canary.railway.toml` | N/A (is the artifact) | ✓ shipped |
| D2 | `tests/canary-watch-patterns.test.ts` (11 tests) | N/A | ✓ shipped |
| D3 | `docs/architecture.md` "Deployment Topology" | Y | ✓ shipped |
| D4 | `deploy/openclaw-railway/README.md` "The Canary" | Y | ✓ shipped |
| D5 | `CHANGELOG.md` `[Unreleased]` entry | Y | ✓ shipped |
| D6 | Live Railway reconnect | — | **DEFERRED** — Session 2, gated on this PR merging. Not a gap. |
| D7 | Empirical push-test | — | **DEFERRED** — same gate. Not a gap. |

### Code changes not tied to any deliverable
None. `git diff --stat main..HEAD` touches exactly 7 files, matching the plan's "Files to Create"/"Files to Edit" lists. Gate 1: "7 deliverable(s), 10 AC row(s), 0 orphans."

## ACs ↔ Tests (Gate 3 spot-check)

| AC | Test file / method | Asserts invariant? | Notes |
|----|-----------|---------------------|-------|
| AC-TST-1 | `tests/canary-watch-patterns.test.ts` | ✓ | 11/11 pass. Not vacuous — `deriveExpectedPatterns` walks the real Dockerfile via regex + `fs.stat`, independent of the hand-written `.toml`; the exact-sync test and the synthetic drift-detection test together prove the guard reacts to a real Dockerfile change, not just to itself. |
| AC-FN-1 | Code review: `canary.railway.toml` | ✓ | `dockerfilePath`, `[deploy]` block, `watchPatterns` (7 entries), `[variables]` absence, and header comment all verified directly against the file. |
| AC-FN-2/3/4 | Code review: architecture.md, README, CHANGELOG | ✓ (tense caveat fixed post-report) | Content accurate; present-tense overclaim of Session-2 state corrected below. |
| AC-REG-1 | `npm test` | ✓ | 298/298 passed. |
| AC-REG-2 | `npm run precheck` | ✓ | Typecheck + tests + build clean; stamp matched HEAD exactly. |

## Docs drift

### Stale claims (contradiction)
None — no surviving "Railway reads this file" / "config-as-code path" phrasing anywhere in the diff.

### New-claim accuracy scan (overclaim) — fixed
`docs/architecture.md`, `deploy/openclaw-railway/README.md`, and `CHANGELOG.md` originally stated the canary's live reconnect (git-connected, settings applied) in present tense, when it is Session-2 work explicitly deferred and gated on this PR merging. `docs/architecture.md` is a declared-durable doc, so this would have read as false indefinitely if Session 2 slipped. **Fixed**: all three now hedge with "once reconnected (see plan.md's Session 2)" framing.

### Missing updates (omission)
None found with an existing doc home. Checked `deploy/openclaw-railway/README.md`'s pre-existing sections, root `README.md`'s Architecture section, and `docs/README.md`'s doc index — none needed an additional update beyond D3/D4/D5.

### Kind B — wrong altitude — fixed
`docs/architecture.md` recorded a literal "2026-12-01" cutoff date inside a doc this repo's convention declares durable — it would read as false the day after that date with nothing marking it as time-bound. **Fixed**: the literal date is dropped in favor of "existing adopters keep working until a published sunset date... see Railway's docs for current status and the cutoff," and the underlying migration is already flagged in `plan.md`'s Out of Scope as a separate follow-up.

## Docs hygiene / public-voice audit

| Finding | Kind | Location | Introduced or pre-existing |
|---------|------|----------|------------------------------|
| Test asserted a negative-presence check by embedding the actual forbidden identifiers in a committed test file | A | `tests/canary-watch-patterns.test.ts` (pre-`3f23d72`) | Fixed within this branch at `3f23d72`, confirmed absent at HEAD by full-diff grep. |
| Full `git diff main..HEAD` grepped for known-sensitive patterns (identifiers, emails, credentials, URLs beyond the one legitimate Railway docs link) | — | — | No hits. |
| `.claude/oss-hygiene-rules.json`'s denylist doesn't literally list the two `3f23d72`-removed strings | — | local, untracked | Checked: an existing denylist entry is already a superset substring match covering the actual sensitive identifier (the live project name contains it verbatim) — no gap to close. |

## Recommendations

1. ~~Add a tense hedge to the canary-git-connected claims in architecture.md/README.md/CHANGELOG~~ — **done**.
2. ~~Drop the literal "2026-12-01" date from architecture.md~~ — **done**. Filing the public-proof service's own Config-as-Code→Infrastructure-as-Code migration as a tracked follow-up issue is still recommended but deliberately not done as part of this branch (outside "update docs and test" scope) — flagged to the human instead.
3. Denylist already covers the removed identifiers — no action needed.
4. No blocking action needed for D6/D7 — correctly deferred, not incomplete.

## Inputs for /retro

- **Route:** `/test-engineer` → `.claude/commands/test-engineer.md`
  **Draft principle:** *"A negative-presence test that guards a forbidden-identifier rule (a Public-Repo Rule check, a secrets check, etc.) must not embed the actual forbidden literal in the committed test file to prove its own absence — that satisfies the test's own assertion while violating the exact rule the test exists to enforce. Assert the structural property instead, or omit the case entirely when an equivalent code-review AC already covers it."*
  **Triggered by:** commit `3f23d72`.

- **Route:** `/devops` → `.claude/commands/devops.md`
  **Draft principle:** *"Before a plan or reference-spec file commits its architecture to a specific platform mechanism (Config as Code, a particular API capability, a CLI flag's documented behavior), verify that mechanism is currently available to the specific target service — not deprecated, and not gated on the target having adopted it previously — directly against the platform's own docs or API, before writing any file that assumes it. A sibling service's historical configuration is not evidence the same mechanism is still open to a new adopter."*
  **Triggered by:** this session's mid-stream pivot — the plan initially assumed Railway's Config as Code would read `canary.railway.toml` directly, discovered during `/ocr-review` that the mechanism is deprecated and blocked for first-time adopters, and had to revise the `.toml`'s own content, the test, and four docs.

- **Route:** cross-cutting → durable-docs authoring convention
  **Draft principle:** *"A durable doc (architecture.md, an ADR) describing a feature whose live-infra rollout is still pending should state the target state with an explicit 'once connected/reconnected' hedge pointing at the tracking plan, not present tense — otherwise the doc silently becomes false if the rollout slips, with no signal that it was ever aspirational."*
  **Triggered by:** the new-claim-accuracy finding on `docs/architecture.md`/README/CHANGELOG.
