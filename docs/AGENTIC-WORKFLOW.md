# Agentic Workflow — this repo's adapter

This repo follows `/agentic-workflow` — the generic, cross-project protocol
invoked as a Claude Code skill (locally: `~/.claude/skills/agentic-workflow/`;
not a repo-relative path, so it won't resolve as a link from GitHub). This
file states only what's specific to `openclaw-control-plane` — read the
generic skill first for phases, gates, and cadences.

Every feature already used the artifact shape below (see the dozens of
directories under `docs/plans/`); what this adoption adds is the mechanical
enforcement — `.claude/verification-status.json`, the coverage gate script,
and the two project-specific hooks — that were consistently skipped as
"structural exception, out of scope for this issue" (see e.g.
`docs/plans/wrapper-scoped-export-and-import-restart/plan.md`, "Current
State").

## This repo has no browser UI

`openclaw-control-plane` is a backend/infra monorepo: Railway installer
CLI, an HTTP+worker+MCP runtime, and build-time wrapper patches. There is no
frontend to screenshot.

- **`/ui-verify` does not apply here.** Do not stub it — UI ACs simply don't
  occur in this repo's plans.
- **Roles in use:** `/project-manager`, `/backend-architect`, `/devops`,
  `/test-engineer`. `/frontend-dev` and `/ux-architect` are not assigned
  deliverables in this repo.

## Phase 0 preflight (adapted)

No dev server, no admin login. Instead:

1. `npm run typecheck && npm test && npm run build` green on the branch's
   base commit.
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
| Decision Runtime container verify | `npm run verify:decision-runtime` — builds `deploy/decision-runtime/Dockerfile`, API image only (see findings-and-decisions.md 1.9 for the coverage gap) |
| Railway proof verify | `npm run railway-proof:verify` — requires `RAILWAY_*` secrets; currently unconfigured on this repo (see findings-and-decisions.md 1.9) |
| Railway template lock check | `npm run railway-template:check` |
| Dependency audit | `npm audit --omit=dev` |

## Gate 1 — coverage validator

`scripts/check-acs-coverage.mjs <plan.md> <ACs.md>` (also runnable as
`npm run check:acs-coverage -- <plan.md> <ACs.md>`). Hard-fails on:

- A deliverable ID (`D1`, `D2`, …, or letter-suffixed like `D8b`/`D8c` — see
  `docs/plans/live-instance-operations/plan.md` for real examples) in the
  plan's `## Deliverables` table with no AC row citing it in `Plan ref`.
- An AC row's `Plan ref` that doesn't match any deliverable ID (a bare `—`
  is allowed — regression-style ACs, e.g. `AC-REG-*`, don't trace to a
  deliverable). AC IDs may also carry a letter suffix (`AC-FN-008a`/`008b` —
  see `docs/plans/setup-profile-applier/ACs.md`); the coverage script
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

## Release

See [`.claude/commands/release.md`](../.claude/commands/release.md).

> **Note:** PR #94 ("draft Decision Runtime release versioning plan") predates
> the product-separation decision record and is called out there as
> superseded — its premises assumed release coordination across things that,
> per `findings-and-decisions.md` 1.1, have zero code coupling. Resolve or
> close #94 before treating its plan as authoritative for this repo's
> release process.
