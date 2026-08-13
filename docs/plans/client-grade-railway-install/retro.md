# Client-Grade Railway Install Retro

## 2026-08-13 - Railway installer release

**Gap:** Mocked installer tests proved command intent, but the workflow still
needed a real provider smoke before treating the Railway installer as a client
onboarding path.

**Root cause:** The plan correctly marked live Railway testing as optional, but
the implementation role did not yet carry a durable rule for how to do that
smoke safely: throwaway project, no local secret output, terminal deployment
success, real health probe, cleanup, and local context restoration.

**Role:** `/devops`

**Fix applied to:**

- Out-of-repo canonical `/devops` command - added rules for live
  throwaway PaaS installer smokes, numeric CLI flag validation, and package
  metadata/build-output alignment.
- Out-of-repo canonical `/commit` command - added squash-merge local sync
  guidance for the case where GitHub merges successfully but local `main`
  diverges from `origin/main`.
- `docs/plans/client-grade-railway-install/review.md` - updated verification
  and recommendation status after the live smoke test.

**Prevented by:** Future `/devops` runs should treat mocked CLI tests and live
provider smoke tests as separate gates for client-facing installers, and future
`/commit` runs should verify remote PR merge state before resolving local
post-squash divergence.

**Source:** ad-hoc `/retro` after PR #1 merge.
