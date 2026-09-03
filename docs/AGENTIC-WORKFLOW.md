# Agentic Workflow — this repo's adapter

This repo follows `/agentic-workflow` — the generic, cross-project protocol
invoked as a Claude Code skill (locally: `~/.claude/skills/agentic-workflow/`;
not a repo-relative path, so it won't resolve as a link from GitHub). This
file states only what's specific to `openclaw-control-plane` — read the
generic skill first for phases, gates, and cadences.

Most recent features already used the artifact shape below (see the dozens
of directories under `docs/plans/`); what this adoption adds is the
mechanical enforcement — `.claude/verification-status.json`, the coverage
gate script, and the two project-specific hooks — that were consistently
skipped as "structural exception, out of scope for this issue" (see e.g.
`docs/plans/wrapper-scoped-export-and-import-restart/plan.md`, "Current
State").

**Not every plan directory qualifies, though.** Older plans predate the
Plan ref/Role column convention entirely — `docs/plans/runtime-registry-
version-compatibility/ACs.md`, the one such file left in this repo, uses an
`AC | Deliverable | What | Test | Pass condition | ...` shape with no Plan
ref column at all. Gate 1 detects this and fails with a clear message rather
than mis-parsing; it does not retroactively apply to those older
directories.

**`.claude/` is local, untracked tooling, not part of this repo's tracked
tree** (see issue #102 — it's process tooling specific to how this repo's
maintainer works with Claude Code, not something a public contributor needs
or receives on clone). Every `.claude/hooks/`, `.claude/settings.json`,
`.claude/verification-status.json`, and `.claude/commands/release.md`
reference below describes files that exist only on the maintainer's own
machine. The generic `/agentic-workflow` skill and this doc's phases/gates
still apply to anyone working in this repo; the mechanical enforcement
(hooks, the precheck stamp file) is the maintainer's own local setup, not
something to replicate to follow this doc.

## This repo has no browser UI

`openclaw-control-plane` is a backend/infra monorepo: a Railway installer
CLI, a setup-profile applier, and build-time wrapper patches. There is no
frontend to screenshot.

- **`/ui-verify` does not apply here.** Do not stub it — UI ACs simply don't
  occur in this repo's plans.
- **Roles in use:** `/project-manager`, `/backend-architect`, `/devops`,
  `/test-engineer`. `/frontend-dev` and `/ux-architect` are not assigned
  deliverables in this repo.

## Phase 0 preflight (adapted)

No dev server, no admin login. Instead:

1. `npm run precheck` (typecheck + test + build) green on the branch's base
   commit.
2. If the feature touches Railway deploy/provisioning: `railway whoami`
   succeeds (confirms the CLI session used by `railway-vars:guard` and
   `railway-proof:verify` is authenticated).
3. Register `"planning"` in `.claude/verification-status.json` as the
   generic doc describes.

## Verification tools (this repo's mapping)

| Generic tool | This repo's command |
| --- | --- |
| Unit/integration tests | `npm test` (vitest) |
| Type check | `npm run typecheck` |
| Build | `npm run build` |
| Playwright (UI/E2E) | N/A — no UI |
| Railway proof verify | `npm run railway-proof:verify` — manual command only; the scheduled/dispatchable `Railway Proof Verify` CI workflow was deleted (see product-separation findings-and-decisions.md S-6 — it watched nothing and provided no coverage). Requires `RAILWAY_*` secrets when run against a live proof deployment. |
| Railway template lock check | `npm run railway-template:check` |
| Railway deploy status check | `npm run railway-deploy:verify` — confirms the most recent Railway deployment reached `SUCCESS`; runs on a 15-minute schedule + `workflow_dispatch` in CI (`.github/workflows/railway-deploy-verify.yml`), deliberately not push-triggered (see that script's header for why). Requires `RAILWAY_*` secrets; skips gracefully when unconfigured. |
| Dependency audit | `npm audit --omit=dev` |

## Gate 1 — coverage validator

`scripts/check-acs-coverage.mjs <plan.md> <ACs.md>` (also runnable as
`npm run check:acs-coverage -- <plan.md> <ACs.md>`). Hard-fails on:

- A deliverable ID (`D1`, `D2`, …, or letter-suffixed like `D8b`/`D8c` — see
  `docs/plans/live-instance-operations/plan.md` for real examples) in the
  plan's `## Deliverables` table with no AC row citing it in `Plan ref`.
- An AC row's `Plan ref` that doesn't match any deliverable ID. A bare `—`
  is allowed **only for `AC-REG-*`/`AC-REGRESSION-*` rows** — whole-suite
  regression checks (all tests pass, typecheck/build clean) with no single
  owning deliverable; both spellings are real, current-convention usage
  (`AC-REGRESSION-001` in `docs/plans/mcp-workload-jwt-auth/ACs.md`,
  `AC-REG-001` elsewhere). A different, narrower pattern exists in a couple
  of older plans (`AC-TST-002` "full project verification" in
  `setup-run-payload-contract`/`setup-api-basic-auth`) that blanks a
  non-regression AC ID for a whole-suite check — those plans predate this
  gate and are not guaranteed Gate-1-clean, same as the pre-adoption
  exception above; do not widen the allowed-prefix set to match them, since
  that would let a genuinely mis-scoped `AC-TST-*`/`AC-FN-*` row hide behind
  the same exception. Any prefix outside `AC-REG(RESSION)?-*` with a blank
  `Plan ref` is a real traceability gap and fails Gate 1. AC IDs may also
  carry a letter suffix (`AC-FN-008a`/`008b` — see
  `docs/plans/setup-profile-applier/ACs.md`); the coverage script
  recognizes both forms.

Run it locally before Implement, and again in Phase 3/`/agentic-orca`
Verify.

## Gate 2 — anti-drift lint: documented no-op

This repo has no seed-data or SDK-scaffold fixtures for a config-literal
pin to leak from — the failure mode Gate 2 exists to catch in a frontend
app with mocked API responses doesn't have a direct analogue here. Anti-drift
is instead enforced by:

- The Pass-condition rule in `ac-verify` (invariant, not literal — see
  `~/.claude/templates/acs-template.md`).
- `/ocr-review`'s retro-sourced defect patterns at Phase 4.4.
- The three `agentic-orca` retro rules on adversarial direct-calls,
  sibling-parity gaps, and external-artifact verification (see
  `agentic-orca.md`) — these are this repo's real equivalent of "don't trust
  a green test that doesn't verify the intent."

If a genuine config-literal drift pattern shows up in this repo, add a real
Gate 2 script here and remove this section — don't let this stay a
permanent excuse.

## Artifact placement

Unchanged from existing practice — see `docs/plans/README.md`:

```text
docs/plans/<feature-slug>/
  plan.md
  ACs.md
  review.md
```

## Enforcement hooks

| Hook | Scope | Source |
| --- | --- | --- |
| `session-start-loop-node.js`, `verify-before-stop-node.js`, `verify-before-commit-node.js`, `enforce-workflow-start.js` | Generic — already wired in `~/.claude/settings.json` | `~/.claude/skills/agentic-workflow/hooks/` |
| `pre-pr-precheck-node.js` | Project — gates `gh pr create` on a fresh `npm run precheck` stamp matching `HEAD` | `.claude/hooks/` |
| `review-before-merge-node.js` | Project — gates `gh pr merge` on a Copilot review attached to the current head SHA with all review threads resolved | `.claude/hooks/` |

`pre-pr-via-release-node.js` (release-fingerprint gate) is intentionally
**not** adopted yet — `/release` here is a thin codification of existing ad
hoc practice (version bump + CHANGELOG entry), not a fingerprinted release
pipeline. Add that hook if/when `/release` grows one.

### Scope — these are guardrails, not a security boundary

Both project hooks parse the Bash tool's `command` string with a hand-rolled,
quote-aware tokenizer (`.claude/hooks/lib/gh-pr-command-detect.mjs`). That
tokenizer is a best-effort guardrail against the agent forgetting the
procedure, not a boundary against a deliberately adversarial command — see
its module header for the specific parsing gaps (subshells, command
substitution, wrapper commands, background `&`, backslash-newline
continuation).

More importantly, **both hooks are wired only to the `Bash` tool matcher**
(`.claude/settings.json`). On this repo's primary development machine, the
`PowerShell` tool and the GitHub MCP tools (`merge_pull_request`,
`create_pull_request`) are both available and both bypass these hooks
entirely — nothing here gates them. Broadening coverage to those surfaces is
a real follow-up, not done in this adoption: PowerShell needs its own
grammar-aware tokenizer (not a shared one — PowerShell's quoting and
statement-separator rules differ from POSIX shells), and the MCP tools would
need either equivalent gating logic run from a different hook point or a
`permissions.deny` rule blocking them outright in favor of the CLI path.

## Release

See `.claude/commands/release.md` (local-only, not a repo-relative link —
see the note on `.claude/` above) for the maintainer's own release protocol,
or `docs/README.md`'s Document Types section for the general convention.

> **Note:** PR #94 ("draft Decision Runtime release versioning plan") predates
> the product-separation decision record and is called out there as
> superseded — its premises assumed release coordination across things that,
> per `findings-and-decisions.md` 1.1, have zero code coupling. Resolve or
> close #94 before treating its plan as authoritative for this repo's
> release process.
