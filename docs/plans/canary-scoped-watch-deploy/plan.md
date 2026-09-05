# Canary-Scoped Watch Deploy — Plan

Branch: `feat/canary-scoped-watch-deploy`
Source: live investigation of a stalled canary deploy this session

## Summary

The canary's OpenClaw wrapper is deployed by hand today (CLI, pinned-client shape), while its attached engine services already deploy automatically on relevant commits. This gives the wrapper the same git-connected, `watchPatterns`-scoped deploy trigger, so build-relevant changes redeploy it automatically while unrelated churn (docs, plans, CHANGELOG) does not.

## Current State

- The public-proof Railway service (root `railway.toml`, no `watchPatterns`) deploys on every commit to `main` — confirmed live and healthy, unaffected by this plan.
- Pinned client instances deploy via CLI (`railway up`) through `deploy/openclaw-railway/provision-client.ps1`/`update-client-openclaw-ref.ps1`, version-pinned, deliberately not git-connected — unaffected by this plan.
- The canary — the operator's own live instance — is not git-connected today; its wrapper is deployed via the same CLI/pinned model as a one-off client, even though it's actually the sole instance in continuous, heavy use. Its attached engine services in the same Railway project are already git-connected with scoped `watchPatterns` and healthy.
- Root `Dockerfile`'s only `COPY`/`ADD` instructions with a real source path in this repo (everything else uses `--from=<stage>`, which has no repo path). Confirmed current as of this branch's rebase onto `main` after `#109` merged, which added two of these seven:
  ```
  scripts/patch-wrapper-restart-gateway.mjs
  scripts/wrapper-state-export.mjs
  scripts/patch-wrapper-scoped-export.mjs
  scripts/wrapper-github-webhook-verify.mjs
  scripts/patch-wrapper-github-webhook.mjs
  scripts/relax-openclaw-extension-versions.mjs
  deploy/openclaw-railway/openclaw.pnpm-lock.yaml
  ```
  All seven are files, not directories, so each becomes an exact-path watch pattern. Plus `/Dockerfile` and `/.dockerignore` themselves, that's 9 total `watchPatterns` entries. Root `package.json`/`package-lock.json` are never copied into the wrapper image, so they need no watch entry.
- This repo already built and later removed an equivalent single-service scoped-watch-trigger feature for a service that has since moved to its own repo (`e5995b7`, "build(railway): scope the ... service's deploy trigger (#91)", closing #89; removed by `04d15dc`, #97, when that code was extracted). Both commits are in this repo's own public history and are the structural template this plan reuses.
- **Revised during `/ocr-review`**: Railway's Config as Code (`railway.toml`/`railway.json` wired via a service's Config File setting) is deprecated — existing adopters (including the public-proof service, root `railway.toml`) keep working until 2026-12-01, but a service cannot newly opt in, and the canary has never used one. `watchPatterns` and the rest of a service's build/deploy settings are also plain native per-service fields, independent of Config as Code — so the canary's live settings are applied directly (via Railway's API) rather than through a config file. `deploy/openclaw-railway/canary.railway.toml` is kept as a committed, drift-guarded reference spec, not something Railway reads.

## Approach

1. Recover `e5995b7`'s scoped `railway.toml` and `04d15dc^`'s drift-guard test from this repo's own git history as the structural template.
2. Add `deploy/openclaw-railway/canary.railway.toml` as a reference spec (Railway does not read it) — `dockerfilePath = "Dockerfile"`, `watchPatterns` derived from the seven `COPY`/`ADD` sources above plus `/Dockerfile` and `/.dockerignore` (9 entries total; the reference file itself is deliberately excluded — it has zero effect on the built image). `[deploy]` mirrors root `railway.toml` (healthcheck/restart/volume) — a real, intentional improvement, since the canary has none of that configured today. `[variables]` is omitted: the relevant variables are already set directly on the live service.
3. Add `tests/canary-watch-patterns.test.ts` (ported from control-plane's own recovered history, not the private engine repo's copy): non-empty assertion, exact-sync-with-Dockerfile drift guard, positive matches (the seven sources + Dockerfile + `.dockerignore`), negative matches (the reference spec file itself, root `railway.toml`, docs/README/CHANGELOG, root package manifests, unrelated `scripts/*`, pinned-client `.ps1` scripts, `tests/**`, `.github/**`), plus synthetic drift-detection, `--from=`/flag-stripping, lowercase/continued-line, and commented-out-entry cases.
4. Correct `docs/architecture.md`'s "Deployment Topology" section (currently asserts one Railway service, no watchPatterns — now only true of the public-proof half) to describe two independently git-connected wrapper deployments.
5. Add a short "the canary" subsection to `deploy/openclaw-railway/README.md` near "Agency-Controlled Client Provisioning," naming it as the deliberate, explained exception to that section's own reasoning against pointing a client service at `main`.
6. `CHANGELOG.md` `[Unreleased]` entry.
7. **Session 2, gated on Session 1's PR merging to `main`**: human-confirmed live reconnect of the canary's Railway service — connect its source to `main` with "Wait for CI" enabled (matching the public-proof service), then apply D1's reference spec values (`dockerfilePath`, `watchPatterns`, healthcheck/restart settings) directly as native per-service settings — never via a config-as-code file path — then read back and confirm the change landed as intended (recorded as a pass/fail outcome, not raw config output — see Acceptance Criteria). Accept the connect-triggered bootstrap deploy from current `main` HEAD as unavoidable platform behavior, distinct from the one-time catch-up redeploy the user ruled out.
8. Empirical push-test against the live reconnected service: merge a docs-only PR and confirm the canary gets no new deployment while the public-proof service does (a positive control proving the push was actually seen); merge a PR touching one watched path and confirm the canary does deploy and reaches success. Record only pass/fail outcomes as evidence — no deployment IDs, timestamps, service names, or raw config dumps (Public-Repo Rule, `docs/README.md`).

## Deliverables (with spec-role assignment)

| ID | Deliverable | Kind | Owning role |
|----|-------------|------|--------------|
| D1 | `deploy/openclaw-railway/canary.railway.toml` — canary-scoped build/deploy reference spec (not read by Railway) | build-config | `/devops` |
| D2 | `tests/canary-watch-patterns.test.ts` — drift-guard + match/no-match test | test | `/test-engineer` |
| D3 | `docs/architecture.md` — correct "Deployment Topology" for two wrapper deploy models | docs | `/project-manager` |
| D4 | `deploy/openclaw-railway/README.md` — canary exception subsection | docs | `/project-manager` |
| D5 | `CHANGELOG.md` — `[Unreleased]` entry | docs | `/project-manager` |
| D6 | Live Railway reconnect of the canary service (git source + "Wait for CI" + native per-service settings matching D1), human-confirmed | verification | `/devops` |
| D7 | Empirical push-test (docs-only → no deploy + public-proof positive control; watched-path → deploy reaches success) | verification | `/devops` |

### Files to Create

| File | Purpose |
|------|---------|
| `deploy/openclaw-railway/canary.railway.toml` | D1 |
| `tests/canary-watch-patterns.test.ts` | D2 |
| `docs/plans/canary-scoped-watch-deploy/plan.md` | This plan |
| `docs/plans/canary-scoped-watch-deploy/ACs.md` | Acceptance criteria |

### Files to Edit

| File | Change |
|------|--------|
| `docs/architecture.md` | D3 — "Deployment Topology" section |
| `deploy/openclaw-railway/README.md` | D4 — canary subsection near "Agency-Controlled Client Provisioning" |
| `CHANGELOG.md` | D5 |

## Sessions

| Session | Scope | Live-infra? |
|---------|-------|--------------|
| Session 1 | D1–D5 (files only, fully verifiable via `npm run precheck`) | No |
| Session 2 | D6–D7, after Session 1's PR merges to `main` | Yes — human-confirmed gate before D6's first mutating Railway call |

## Acceptance Criteria

→ See `docs/plans/canary-scoped-watch-deploy/ACs.md`.

- **Session 1**: `npm run precheck` green including D2; D2 proves the declared `watchPatterns` exactly matches what's mechanically derivable from the Dockerfile's `COPY` sources, and correctly discriminates canary-relevant vs. irrelevant paths.
- **Session 2**: the canary service's live config shows the expected git source, "Wait for CI" setting, and native per-service settings matching D1's reference spec after reconnect (recorded as pass/fail, no raw config or IDs); a docs-only merge produces zero canary deployments and one public-proof deployment; a watched-path merge produces exactly one canary deployment that reaches success.

## Commit Schedule

**Session 1:**
1. `docs: add plan for canary-scoped-watch-deploy` (after plan approval)
2. `docs: add ACs for canary-scoped-watch-deploy`
3. `build(railway): scope the canary OpenClaw wrapper's deploy trigger` (D1)
4. `test: guard the canary watch patterns against Dockerfile drift` (D2)
5. `docs: document the canary as a second git-connected wrapper deployment` (D3, D4, D5)
6. Verification: `chore: update verification status` (after Session 1 ACs pass)

**Session 2** (after Session 1's PR merges; human confirms before commit 7):
7. No repo commit for D6 — a live Railway reconnect, not a file change; recorded as a pass/fail outcome in `ACs.md`.
8. `docs: record canary reconnect and watch-pattern verification results` (after D7's two push-tests complete, outcomes only)

## Dependencies

- Session 2 cannot start until Session 1's PR is merged to `main` — the reference spec (D1) and its drift guard (D2) must exist on the branch the canary's service connects to before the human confirms its settings match.
- D6's every mutating Railway call is individually human-confirmed — this is a live, actively-used production service, not batched into one approval.

## Out of Scope

- The one-time catch-up redeploy of the current CLI-pinned build (explicitly ruled out by the user) — distinct from D6's unavoidable connect-triggered bootstrap deploy, which is noted, not silently treated as the same thing.
- Bumping the wrapper's pinned upstream version references themselves, or changing how they're pinned.
- A second, canary-scoped scheduled deploy-status check — a real, low-priority follow-up, not built here.
- Any change to the public-proof service's Railway config or behavior. Its root `railway.toml` is on the same deprecated Config as Code mechanism, grandfathered until 2026-12-01 — a pre-existing, separate migration this investigation surfaced but does not address here; worth its own follow-up issue before that date.
- Any change to the pinned-client CLI scripts or their documented behavior.
- Regenerating the committed OpenClaw lockfile — a pre-existing, separate concern, unrelated to this deploy-trigger scoping.
