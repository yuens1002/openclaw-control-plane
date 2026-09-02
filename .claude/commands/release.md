# /release (project override — openclaw-control-plane)

Codifies this repo's existing ad hoc release practice (see e.g. `e0e5be6`,
`39beb40`, `dbb4ba5` in git history) — it does not introduce a new process.
**This diverges from `/agentic-workflow`'s generic Phase 6**, which assumes
the release itself goes through a PR. Here it doesn't: the feature PR is
already merged (with Copilot review, per Phase 6's mandatory step) before
`/release` runs. `/release` is a small, direct-to-`main` follow-up commit.

## Why `npm version` is not used

It rewrites `package-lock.json` in a way that re-triggers the per-release
Railway redeploy removed by issue #86 (`decision-runtime-watch-patterns` /
`tests/decision-runtime-watch-patterns.test.ts` guards against exactly
this). Bump both files by hand instead.

## Protocol

1. Confirm the feature's PR is merged and local `main` is synced (`git pull --ff-only`).
2. Decide the version bump. No script decides this — patch for fixes/docs/internal changes, minor for new user-facing capability, following this repo's own history as precedent. Ask the human if genuinely ambiguous.
3. Hand-edit the `version` field in **both** `package.json` and `package-lock.json` (the root `""` package entry) to the new version. Do not run `npm version`.
4. Add a dated entry to `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD` heading, promoted from `[Unreleased]` if content is already staged there. Write it in this repo's existing style — a short paragraph of *why*, not a raw commit list (see recent entries for tone).
5. Commit directly to `main`: `docs(changelog): release version X.Y.Z`.
6. Push.
7. **Tagging is optional and occasional in this repo** (many versions, e.g. 0.6.3-0.6.11, were never tagged) — only tag (`git tag vX.Y.Z && git push origin vX.Y.Z`) when something concrete needs to pin the ref (a client instance, a rollback target). Don't tag by default.

## What this does NOT cover yet

- **Post-separation, this changes.** `findings-and-decisions.md` D-2 makes
  the Decision Runtime one product/one version, separate from this repo's
  own version once the split happens. Rewrite this file when that lands —
  don't assume it still applies unmodified.
- **PR #94** drafted a release-versioning scheme before the product
  boundary was understood and is marked superseded by PR #95's description.
  Resolve it before treating it as this repo's forward plan.
- The `pre-pr-via-release-node.js` fingerprint-gate hook is not adopted —
  there's no release PR to fingerprint against.
