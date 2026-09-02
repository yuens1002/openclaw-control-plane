# /release (project override — openclaw-control-plane)

Codifies this repo's existing ad hoc release practice (see e.g. `e0e5be6`,
`39beb40`, `dbb4ba5` in git history) — it does not introduce a new process.
**This diverges from `/agentic-workflow`'s generic Phase 6**, which assumes
the release itself goes through a PR. Here it doesn't: the feature PR is
already merged (with Copilot review, per Phase 6's mandatory step) before
`/release` runs. `/release` is a small, direct-to-`main` follow-up commit.

## Why `npm version` is not used

It rewrites `package-lock.json`, which historically re-triggered the
per-release Railway redeploy removed by issue #86 for the (since-extracted)
Decision Runtime services. Post-separation, this repo's only Railway service
is the root OpenClaw wrapper, which declares no `watchPatterns` and already
redeploys on every commit — so a version-bump commit is not a special case
for it either way. `npm version` remains unused here on habit/consistency
grounds (hand-editing both files stays the simpler, more auditable path);
bump both files by hand.

## Protocol

1. Confirm the feature's PR is merged and local `main` is synced (`git pull --ff-only`).
2. Decide the version bump. No script decides this — patch for fixes/docs/internal changes, minor for new user-facing capability, following this repo's own history as precedent. Ask the human if genuinely ambiguous.
3. Hand-edit the `version` field in **both** `package.json` and `package-lock.json` (the root `""` package entry) to the new version. Do not run `npm version`.
4. Add a dated entry to `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD` heading, promoted from `[Unreleased]` if content is already staged there. Write it in this repo's existing style — a short paragraph of *why*, not a raw commit list (see recent entries for tone).
5. Commit directly to `main`: `docs(changelog): release version X.Y.Z`.
6. Push.
7. **Tagging is optional and occasional in this repo** (many versions, e.g. 0.6.3-0.6.11, were never tagged) — only tag (`git tag vX.Y.Z && git push origin vX.Y.Z`) when something concrete needs to pin the ref (a client instance, a rollback target). Don't tag by default.

## What this does NOT cover yet

- **Post-separation** (this landed per `findings-and-decisions.md` D-1/D-2),
  this repo's `version`/`CHANGELOG.md` cover only the vending/provisioning
  tooling and the wrapper image. Any externally attached MCP server versions
  independently, in its own repository; this protocol has no bearing on it.
- **PR #94** drafted a release-versioning scheme before the product
  boundary was understood and is marked superseded. Resolve it before
  treating it as this repo's forward plan.
- The `pre-pr-via-release-node.js` fingerprint-gate hook is not adopted —
  there's no release PR to fingerprint against.
