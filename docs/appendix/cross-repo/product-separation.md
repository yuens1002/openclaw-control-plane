# Product Separation — Cross-Repo Overview

Status: **executed**. This plan's six sequencing decisions were approved and
fully carried out (control-plane PR #97; decision-runtime PRs #1/#2). Kept as
a point-in-time record of the separation as planned and sequenced, per this
repo's own [plan-document convention](../../README.md#document-types) — the
living description of the resulting architecture lives in each repo's own
architecture doc, not here.

Architecture reference only. Per-repo implementation detail lives in each
repo's own feature plan; this document maps repos, streams, and dependency
order and does not restate either. Consistent with `findings-and-decisions.md`
D-7, this document never names a private repo, org, agency, or client —
generic role names only, matching how `findings-and-decisions.md` 1.3 already
refers to "the private policy repo."

Source of the target end state: `docs/plans/product-separation/findings-and-decisions.md`
(Part 3). That document decided *what* the end state is. This document decides
*in what order* to get there and *who does what*.

## Repos and streams

| Repo | Today | End state | This extraction's job |
| --- | --- | --- | --- |
| **openclaw-control-plane** (this repo) | Contains all three products (1.1) | Retains only vending/provisioning: `packages/{openclaw-railway-installer,openclaw-setup-applier}`, root `Dockerfile`, `scripts/*.mjs`, `railway.toml` | Extract the Decision Runtime out; the repo's *name* already matches its end-state scope — no rename needed |
| **decision-runtime** (new repo) | Does not exist | `apps/{api,worker,mcp}`, `packages/{contracts,db,runtime-auth,mcp-service,decision-runtime-mcp,openclaw-adapter}`; three container services, MCP endpoint as the only public surface | Created by this extraction — history-preserving split of the paths above out of this repo |
| **the private policy repo** (per company) | Already separate (1.3) | Unchanged | Out of scope — zero code coupling today, nothing to extract |

Only **one** new repo is created. The private policy repo already satisfies
D-1; this extraction is entirely about splitting `openclaw-control-plane` in
two.

## Dependency order

```text
1. decision-runtime repo created, history-preserving split, own CI green
   (independent — reads this repo, writes nothing back)
        │
        ▼
2. Railway service sources reconnected (api, worker, mcp → decision-runtime)
   (autonomous per 2026-09-02 consensus — see "Execution classes" below —
   but its success is verified, not assumed, before step 3 starts)
        │
        ▼
3. control-plane repo: extracted paths removed, remaining packages verified
   (depends on 1 and 2 — control-plane cannot lose the code until the new
   repo's services are live and reconnected, or the agency instance loses
   its runtime mid-step)
        │
        ▼
4. Independent hardening in each repo, in parallel, no further ordering
   (ArtifactKindSchema fix, MCP attachment type, verify:decision-runtime
   worker/MCP coverage, upgrade-path test)
```

Step 3 is the one irreversible-feeling step — once `apps/**` and the nine
runtime packages are deleted from `openclaw-control-plane`, this repo's own
git history is the only record of them prior to the split. Do not delete
until step 2 is confirmed live (the agency instance's three services are
actually running from the new repo's deploys, verified via Railway, not
assumed from a config change).

## Six sequencing decisions (recommended defaults — user approves or redirects)

`findings-and-decisions.md`'s "Open Items for the Implementation Plan"
section left these open deliberately. Recommending a default for each so
approval is a yes/no/redirect, not open-ended authoring:

| # | Decision | Recommended default | Why |
| --- | --- | --- | --- |
| S-1 | Extraction order: engine first, or control-plane tooling first? | **Engine (decision-runtime) first.** | It's the one with a live deployment to reconnect (the agency instance). The vending/provisioning tooling has no live coupling to it (1.1) and can stay untouched in this repo indefinitely if extraction stalls. |
| S-2 | History: preserve git history in the new repo, or fresh init? | **Preserve, via `git filter-repo` on a fresh clone.** | `apps/**` and the nine packages have real commit history (including the OIDC/attribution work in 1.4). A fresh init discards blame and makes `git log` on the extracted code start from nothing. `filter-repo` (not the deprecated `filter-branch` or a bare subtree split, which doesn't prune unrelated history) run against a throwaway clone — never this repo directly — is the standard tool for this. |
| S-3 | What duplicates across repos (tsconfig base, CI scaffolding, lint config)? | **Accept duplication.** Each repo gets its own copy, not a shared config package. | D-1's whole point is zero cross-repo coupling; a shared config package reintroduces exactly the coupling being removed, for a cost (two configs to keep in sync) that's smaller than the coupling it would cost to avoid. |
| S-4 | Which docs move with the engine? | **Everything under `docs/plans/decision-runtime-*/`, `deploy/decision-runtime/`, and any doc whose primary subject is `apps/**` or the nine extracted packages.** `docs/plans/product-separation/`, `docs/AGENTIC-WORKFLOW.md`, and anything about vending/provisioning stay here. | Docs follow the code they describe; a doc about a file that no longer exists in this repo is dead weight here and a gap there. |
| S-5 | Does `verify:decision-runtime` (+ an upgrade-path check) enter decision-runtime's CI at extraction time or after? | **At extraction time.** | 1.9 already flags this as the strongest verification the repo has and notes CI never runs it today — extracting without fixing that just relocates the gap. Doing it as part of extraction is cheaper than a follow-up PR against a repo nobody's touched since. |
| S-6 | `Railway Proof Verify` (1.9): configure against the canary, or delete? | **Delete.** | It watches nothing today (unconfigured secrets, three consecutive failed scheduled runs) and provides no coverage. Configuring it against the canary is a real but separate piece of work with its own scoping questions (which proof, what cadence) — don't bundle it into the extraction just because the workflow file is being touched anyway. |

One item from the same "Open Items" list is **not** listed above because it's
not a sequencing question — `ArtifactKindSchema` (1.5) fix-during-vs-after is
folded into the independent-hardening stream (step 4) since it has no
ordering dependency on the split itself.

## Execution classes

Tags every deliverable across both repos' plans by who can act on it and
whether it can run inside an unsupervised Workflow pipeline, or must pause
for a human:

- **Shared-state actions (previously human-gated, now autonomous by explicit
  consensus, 2026-09-02)** — creating the `decision-runtime` GitHub repo,
  reconnecting the three Railway service sources, migrating the nine
  hand-set `DECISION_RUNTIME_*` variables (1.6) including the signing key.
  These no longer stop for a live confirmation at the moment of execution —
  see `docs/plans/product-separation/plan.md`'s Dependencies section for the
  exact consensus. What doesn't change: each one is still verified to have
  actually succeeded (services confirmed live via Railway status/logs/health
  check, not assumed from a config write) before the next dependent step
  starts, and the credential migration still never puts the signing key's
  value in an argument string, a log, or a commit — set via the `railway`
  MCP's variable-set tool or piped through stdin, same convention as the
  rest of this ecosystem's credential handling.
- **Sequential mechanical** — the `filter-repo` history split, path fixups in
  the new repo (import paths, `package.json` workspace refs), lockfile
  regen, CI scaffold copy. Each step depends on the prior succeeding — one
  agent or a short `pipeline()`, not a fan-out.
- **Independent hardening, split across two repos (corrected 2026-09-02 —
  `profile-schema.ts` lives in `packages/openclaw-setup-applier`, which
  stays in control-plane, not decision-runtime):**
  - In `decision-runtime`: `ArtifactKindSchema` → registration (1.5),
    `verify:decision-runtime` worker/MCP image coverage, the upgrade-path
    test. No ordering dependency between these three once the repo exists
    with its own passing CI — fan-out-shaped, `parallel()`/`pipeline()`
    per `/agentic-orca`'s own template.
  - In `control-plane`: the MCP attachment type in `profile-schema.ts`
    (1.7) — folded into control-plane's own Stage 4 (Slim) session as an
    additional deliverable, since that's control-plane's own next piece of
    work anyway, rather than standing up a separate session for one item.

## What `/agentic-orca` (via Workflow) does here

A Workflow's `agent()` subagents get real Bash/Read/Write/MCP tool access —
not confined to the directory the workflow was launched from. Each agent's
prompt can name the local path of whichever repo it needs to operate in
(control-plane, or decision-runtime once it exists) and it works there
directly; `isolation: 'worktree'` is a *different*, same-repo-only mechanism
(concurrent agents editing the same repo's files without stepping on each
other) and is irrelevant to crossing repo boundaries. Verified empirically
before writing this: a throwaway probe agent successfully `cd`ed into a
sibling local repo and read its git log with no sandbox or hook interference.

What this means for the four-stage shape below: one Workflow script per
stage, run in sequence across turns. Per the 2026-09-02 consensus, stages
run straight through without a human confirmation between them — the human
review point is the final state, not each stage boundary:

1. **Extract** — `git filter-repo` on a throwaway local clone (touches
   nothing live), verified (paths correct, history actually preserved).
   Then creates the `decision-runtime` GitHub repo and pushes the filtered
   history.
2. **Bootstrap** — work directly in the new repo's local clone — CI
   scaffold, path fixups, lockfile regen, `verify:decision-runtime` wired
   into CI (S-5), tests green. Then reconnects the three Railway service
   sources and migrates the `DECISION_RUNTIME_*` variables, and verifies
   (not assumes) all three services are live and serving before continuing.
3. **Harden** — the independent-hardening `parallel()`/`pipeline()` stream
   *in the new repo* (three of the four deliverables — see the corrected
   execution-class list above), once its services are confirmed live. This
   is the deliverable set `/agentic-orca`'s own implement→verify template
   was built for. Each PR opened here gets at most 2 Copilot review rounds
   (nitpicks don't block past round 2; a genuine functional defect gets one
   more direct fix pass, then merges).
4. **Slim** — back in `openclaw-control-plane`: this repo's own Session 2
   (D2-D5, plus the fourth hardening deliverable — the MCP attachment type
   in `profile-schema.ts`, folded in as D6) — delete the extracted paths,
   update config/CI/docs, confirm
   precheck green. Sequential mechanical, independent of stage 3 once
   stage 2's services are confirmed live. Same 2-round Copilot cadence.

Stages 3 and 4 have no ordering dependency on each other once stage 2 is
done — they can run as two arms of one `parallel()` call or as two separate
workflow invocations.

**Flagged, not fixed here:** the `/agentic-orca` skill file's own "Worktree
isolation" section conflates same-repo concurrency with cross-repo scope.
That's a skill-file edit for a separate session, not part of this plan.

## Dependencies / blockers

- This plan and `docs/plans/product-separation/plan.md` were approved
  2026-09-02, together with the execution-autonomy and Copilot-cadence
  consensus recorded in that file's Dependencies section — read it before
  running any stage.
- The agency-instance build-error incident that previously blocked stage 2
  is confirmed resolved as of the same date.
