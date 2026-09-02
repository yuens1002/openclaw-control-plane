# Product Separation (control-plane side) — Plan

Branch: `feat/product-separation`
Source: `docs/plans/product-separation/findings-and-decisions.md` (Part 3, D-1)
Cross-repo overview: `docs/appendix/cross-repo/product-separation.md` — read
that first. This file describes only `openclaw-control-plane`'s own work.

> **Status: approved 2026-09-02 (see Dependencies); D1 executed in Session 1,
> D2-D6 executed in Session 2.** The external state Session 2 was gated on —
> the `decision-runtime` repo existing with its services confirmed live — was
> satisfied before D2's deletions were made.

## Summary

Extract the Decision Runtime (`apps/{api,worker,mcp}` + nine packages) out of
this repo into a new `decision-runtime` repo, leaving `openclaw-control-plane`
holding only the vending/provisioning tooling and wrapper image it will be
named for at end state (findings-and-decisions.md 3.1). This repo does not
gain code — it loses it, and updates its own config/docs/CI to match.

## Current State

This repo currently contains three products with zero code coupling between
them (finding 1.1): the Decision Runtime, the vending/provisioning tooling
(`openclaw-railway-installer`, `openclaw-setup-applier`), and the wrapper
image (root `Dockerfile` + `scripts/*.mjs` + `railway.toml`). `docs/AGENTIC-
WORKFLOW.md`'s verification-tools table and several `docs/plans/decision-
runtime-*/` directories describe the Decision Runtime as if it's a permanent
part of this repo.

## Approach

Two sessions, hard-gated on external state between them:

- **Session 1 (this branch, now):** produce the extraction runbook — the
  exact `git filter-repo` command sequence that creates `decision-runtime`'s
  history-preserving clone. This session touches nothing else in this repo;
  it's pure preparation. The runbook is what a human runs (or explicitly
  directs an agent to run) against a throwaway clone, never against this
  working tree.
- **Session 2 (later, new branch, after decision-runtime is live):** delete
  the extracted paths from this repo, update `package.json`/CI/scripts to
  match the narrowed scope, update remaining docs, and confirm the slimmed
  repo is still green.

Session 2 cannot start until the cross-repo overview's dependency order
(step 2: Railway services reconnected to the new repo, confirmed live) is
satisfied — deleting the code here before the new repo's services are
actually serving traffic would leave the agency instance's runtime with no
source anywhere.

## Deliverables (with spec-role assignment)

| ID | Deliverable | Kind | Owning role | Execution class |
|----|-------------|------|-------------|------------------|
| D1 | `docs/runbooks/extract-decision-runtime.md` — the `git filter-repo` command sequence (run against a throwaway clone, not this tree) that produces `decision-runtime`'s history-preserving initial commit set | runbook | `/devops` | Sequential mechanical (drafted now; run once, later, outside this repo) |
| D2 | Remove `apps/{api,worker,mcp}` and `packages/{contracts,db,runtime-auth,mcp-service,decision-runtime-mcp,openclaw-adapter}` from this repo | repo-restructure | `/devops` | Human-gated — do not run until decision-runtime's services are confirmed live |
| D3 | Update `package.json` workspaces list, `.github/workflows/ci.yml`, and any script referencing the removed paths (`verify:decision-runtime`, etc.) | config | `/devops` | Sequential mechanical, depends on D2 |
| D4 | Update `docs/AGENTIC-WORKFLOW.md`'s verification-tools table and remove/redirect the `docs/plans/decision-runtime-*/` directories per the cross-repo overview's S-4 (they move with the engine) | docs | `/project-manager` | Sequential mechanical, depends on D2/D3 |
| D5 | Confirm `npm run precheck` (typecheck + test + build) green on the slimmed repo, zero references to removed packages | test/regression | `/test-engineer` | Sequential mechanical, depends on D2-D4 |
| D6 | Add a generic `attachments.mcpServers[]` entry to the client profile schema (`packages/openclaw-setup-applier/src/profile-schema.ts`), closing finding 1.7 — schema capability only, no consumer wired | feature | `/backend-architect` | Sequential mechanical, independent of D2-D5 |

Only D1 was in scope for Session 1. D2-D5 were listed there so Gate 1 had the
full deliverable set to check ACs against once Session 2 was authored. D6 was
folded into the same Session 2 later, from the cross-repo overview's Stage 4
(see `docs/appendix/cross-repo/product-separation.md`) — it is independent of
the extraction, so it carries no gating dependency. D2-D6 all executed in
Session 2.

(Deliverable ids `D1`-`D6` here are distinct from the `D-1`-`D-6` *decision*
ids in `findings-and-decisions.md`; the two sets are unrelated.)

### Files to Create

| File | Purpose |
|------|---------|
| `docs/runbooks/extract-decision-runtime.md` | Session 1's only deliverable — the filter-repo runbook |

### Files to Edit (Session 2 only)

| File | Change |
|------|--------|
| `package.json` | Remove extracted packages from `workspaces` |
| `.github/workflows/ci.yml` | Remove any step scoped to extracted paths |
| `docs/AGENTIC-WORKFLOW.md` | Narrow verification-tools table to vending/provisioning + wrapper scope |

### Files to Delete (Session 2 only)

| Path | Why |
|------|-----|
| `apps/{api,worker,mcp}` | Moved to decision-runtime (D-1) |
| `packages/{contracts,db,runtime-auth,mcp-service,decision-runtime-mcp,openclaw-adapter}` | Moved to decision-runtime (D-1) |
| `docs/plans/decision-runtime-*/` | Per cross-repo overview S-4 — docs follow the code |

## Sessions

| Session | Scope (deliverable IDs) | ACs |
|---------|--------------------------|-----|
| Session 1 | D1 | `docs/plans/product-separation/session-1/ACs.md` (next, after this plan is approved) |
| Session 2 | D2, D3, D4, D5 | Authored when Session 2 starts — depends on decision-runtime existing |

## Acceptance Criteria

Not yet authored — see Dependencies. Session 1's AC (once this plan is
approved) is a single AC-DOC-style row: the runbook exists, and its filter-
repo command has been dry-run (`--dry-run` flag, or against a scratch clone)
to confirm it actually isolates the intended paths with history intact,
without being run for real against this repo's origin.

## Commit Schedule

1. Plan commit: `docs: add product-separation plan (control-plane side)` (after this plan + the cross-repo overview are approved)
2. `docs: add decision-runtime extraction runbook` (Session 1, after D1's AC passes)
3. Session 2's commits are scoped and scheduled when that session starts

## Dependencies

- **This plan's own approval** — given 2026-09-02. Execution proceeds
  end-to-end per the consensus below without a review gate at each PR/session
  — only the final end state (decision-runtime live and hardened;
  control-plane slimmed, precheck green) is reviewed as one unit.
- **The agency-instance build-error incident referenced in earlier drafts of
  this plan is confirmed resolved** (2026-09-02) — Session 2 / cross-repo
  overview stage 2 (Railway reconnection) is no longer blocked on it.
- **Execution-class consensus (2026-09-02, supersedes the cross-repo
  overview's original "human-gated shared state" framing):** the three
  actions previously requiring a live human confirmation at the moment of
  execution — repo creation, Railway service-source reconnection, and the
  environment-variable/signing-key migration — proceed autonomously. This
  does not relax the *engineering* requirement to verify each one actually
  succeeded (services confirmed live via Railway status/logs/health check,
  not assumed from a config write) before the next dependent step starts.
- **Review cadence:** each PR gets at most 2 Copilot review rounds. Nitpick/
  style findings after round 2 do not block a merge. A genuine functional
  defect (would break the deliverable's intended behavior) surviving round 2
  gets one more direct fix pass and a merge — not a 3rd Copilot round, not an
  indefinite loop, and not merged broken.
- No Railway or GitHub-repo-creation action happens as part of this plan's
  Session 1. Session 1 is docs-only regardless of the autonomy above — there
  is nothing for those actions to do until `decision-runtime` exists.

## Out of Scope

- The independent-hardening stream (`ArtifactKindSchema` fix, MCP attachment
  type, `verify:decision-runtime` worker/MCP coverage, upgrade-path test) —
  all four live in the `decision-runtime` repo after extraction, per the
  cross-repo overview's execution-class table, and get their own plan there.
- The vending/provisioning tooling and wrapper image's own future feature
  work — unaffected by this extraction beyond D3/D4's config/doc updates.
