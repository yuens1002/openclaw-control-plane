# Client Template Pinning Plan

## Cadence

Full cadence (docs convention only — this repo has not opted into the
hook-enforced `verification-status.json` state machine, so gates below are
run and recorded manually rather than blocked mechanically). Follows
`docs/plans/client-grade-railway-install/` as the structural precedent.

## Goal

Give the agency independent, per-client control over which OpenClaw wrapper
commit a client's Railway instance runs, without a marketplace-template
dependency and without coupling client redeploy timing to control-plane's
own `main`. Resolves GitHub issue #16.

## Background (from issue #16, live-verified)

- `install-template.ps1` deploys `vignesh07/clawdbot-railway-template`
  directly (`railway deploy -t ...`) — the agency has no control over
  wrapper-version timing.
- This repo's own `Dockerfile` already declares
  `ARG OPENCLAW_TEMPLATE_REF=<pinned-commit>`. A Railway service variable of
  the same name overrides that ARG at build time — confirmed live by
  observing the fetched tarball URL change in build logs.
- `railway up` deploys the current local directory as a one-shot snapshot,
  not continuously tracked (confirmed: switching a locally-uploaded service
  into GitHub autodeploy requires a separate explicit
  `railway service source connect`).
- `railway redeploy` "creates a new deployment from the same source, which
  includes a build" (docs.railway.com/cli/redeploy) — so setting a new
  `OPENCLAW_TEMPLATE_REF` service variable and then redeploying triggers a
  real rebuild against the new ref, on the previously-uploaded snapshot
  source. This is what the update path uses; it does not need a second
  `railway up` re-upload.
- Two gaps the marketplace template covered for free that this path must
  automate explicitly: the `/data` volume (`railway.toml`'s
  `requiredMountPath` fails the deploy otherwise) and
  `SETUP_PASSWORD`/`OPENCLAW_GATEWAY_TOKEN` generation.
- Two more gaps found in a full live run (issue comment): `PORT=8080` must
  be set as an explicit service variable (silently-inconsistent gateway
  reachability if missing, no deploy-time error), and
  `OPENCLAW_STATE_DIR`/`OPENCLAW_WORKSPACE_DIR` must also be set explicitly
  — `railway.toml`'s `[variables]` block is **not** applied by `railway up`
  (a local snapshot build), confirmed by the wrapper's boot log falling
  back to `/root/.openclaw` until these were set by hand.
- CLI quirk: `railway volume add --mount-path /data --service <name>`
  panics (`Option::unwrap() on a None value`). Workaround: `railway service
  <name>` to link the service first, then `railway volume add --mount-path
  /data` with no `-s/--service` flag.
- Windows/Git-Bash note: `KEY=/data/...`-shaped values get mangled by the
  MSYS path layer. The existing `writeRailwayVariable` helper (see D3)
  already sidesteps this by piping values via `--stdin` instead of putting
  them in argv, so this plan reuses it rather than re-deriving the fix.
- **Correction from issue #18** (raised after this plan was first drafted):
  issue #16's own comment misattributed a BOM-corrupted
  `SETUP_PASSWORD`/`OPENCLAW_GATEWAY_TOKEN` to Railway's dashboard "reveal
  variable" UI. #18 found the real, byte-level-confirmed cause: **PowerShell's
  own `|` pipe operator** injects a UTF-8 BOM + trailing CRLF when piping a
  string to a native executable's stdin (`"abc" | node ...` → `ef bb bf 61
  62 63 0d 0a`). This plan's provisioner never does that: `writeRailwayVariable`
  (D3) writes secrets via Node's `child_process.spawn(..., {shell: false})`
  + `child.stdin.end(value)`, called from inside the `tsx`/Node process
  itself — the `.ps1` wrappers (D7) only pass plain CLI flags as an
  argument array to `npm exec`, never a secret through a PowerShell `|`
  pipe. Confirmed locally, byte-level, as part of this session: the same
  `spawn` + `.end(string)` pattern this code already uses produces the raw
  bytes with no BOM and no CRLF. See AC-PROV-008.

## Command sequence (the actual design)

Bootstrapping order matters and is not obvious from the issue text alone.
Variables must land **before** the first build that is allowed to succeed,
because `OPENCLAW_TEMPLATE_REF` is consumed as a build arg and the missing
volume hard-fails any deploy via `requiredMountPath`:

1. Get a project linked: `railway link --project <projectId> --json` if
   the caller already has one, else `railway init --name <client> --json`
   (creates + links a new one). Then `railway up --detach --json` — no
   `--new` — to create the service and queue the first build. **This
   first deploy is expected to fail** (no volume yet) and that's fine:
   `--detach` returns once the build is queued, so the CLI call itself
   still exits 0. Its only job is to make the service object exist so
   later commands have something to target. (Implementation note: an
   earlier draft of this plan called for `railway up --new --name
   <client>` to do project-creation and service-creation in one call, but
   `--new` gives no way to know or control the resulting service's name in
   advance — the code instead separates "get a project" from "create the
   service", then discovers the created service's actual name via
   `service list --json` immediately after `up`.)
2. `railway service <name>` — link the created service (ambient state for
   the next two steps; also works around the volume-add panic).
3. `railway volume add --mount-path /data` — no `-s/--service` flag (the
   panic workaround from the issue).
4. `railway variable set <KEY> --service <name> --skip-deploys --stdin
   --json`, once per variable, for `OPENCLAW_TEMPLATE_REF` (default: this
   repo's `deploy/openclaw-railway/template-lock.json` → `pinnedCommit`),
   `PORT=8080`, `OPENCLAW_STATE_DIR=/data/.openclaw`,
   `OPENCLAW_WORKSPACE_DIR=/data/workspace`, `SETUP_PASSWORD`,
   `OPENCLAW_GATEWAY_TOKEN`. `--skip-deploys` on every one — a real deploy
   is triggered once, explicitly, in the next step.
5. `railway redeploy --service <name> --yes --json` — the real build, now
   with the volume mounted and all variables in place.
6. Poll `service list --json` until the service's latest deployment is
   `SUCCESS` (reuses the existing poll loop).
7. `ensureDomainPort` (existing helper) — fix the generated domain to
   target port 8080 if needed.
8. Health check `GET /setup/healthz` (existing helper).
9. Write local-only `.env.local` / handoff files (existing helpers,
   extended with the resolved `templateRef`).

**Update path** (given an already-provisioned client service): steps 4
(only `OPENCLAW_TEMPLATE_REF`, `--skip-deploys`) → 5 → 6. Never touches any
other client's service or control-plane's own `main`.

**Idempotent rerun of provisioning**: if `service list` already has a
service with the target name, skip steps 1–5 entirely. Read back the
existing `SETUP_PASSWORD` via `readRailwayVariable` rather than generating
a fresh one — regenerating and overwriting an already-handed-off client
credential is a real footgun the existing marketplace-path installer has
(`index.ts` always generates a fresh password in `resolveOptions`, then
writes whatever was generated to local files on the reuse branch too,
whether or not it matches what's actually on the service). This plan does
not fix that pre-existing installer, but the new provisioner must not
repeat the bug.

## Deliverables

| ID | Deliverable | Kind | Owning role | Notes |
| --- | --- | --- | --- | --- |
| D1 | Plan and ACs docs | docs | project-manager | This document + `ACs.md`. |
| D2 | Shared Railway service helpers | script | devops | Extract a generic `pollServiceUntilSuccess` out of `index.ts`'s template-deploy-specific `waitForSuccessfulService`; export it plus the existing `ensureDomainPort`/`healthCheck`/`listServices` for reuse by the new provisioner. No behavior change to the existing marketplace install path. |
| D3 | Relocate `railway-variables.ts` into `openclaw-railway-installer` | refactor | devops | Currently lives in `openclaw-setup-applier`, which already depends on the installer package — moving it removes the only blocker to the new provisioner reusing the same secret-safe (`--stdin`, never-argv) read/write helpers instead of re-implementing them. `openclaw-setup-applier`'s `./railway-variables` export becomes a one-line re-export so `apply-profile.ts`'s import path is unchanged. |
| D4 | `provisionClientInstance` | script | devops | New module implementing the 9-step sequence above: bootstrap project/service, volume attach with panic workaround, batched variable set, redeploy-to-build, poll, domain fix, health check, local handoff output. Idempotent on rerun (see above). |
| D5 | `updateClientTemplateRef` | script | devops | Sets a new `OPENCLAW_TEMPLATE_REF` on one named service and redeploys only that service. |
| D6 | CLI entrypoints | script | devops | `provision-client-cli.ts` / an `update-ref` mode wired to D4/D5, following the existing `cli.ts` arg-parsing + stdin/stdout conventions. |
| D7 | PowerShell wrappers | script | devops | `provision-client.ps1`, `update-client-template-ref.ps1` — thin pass-throughs to the CLI entrypoints, matching `install-template.ps1`'s existing shape. |
| D8 | Mocked tests | tests | test-engineer | Fake-`RailwayRunner` tests asserting emitted command **order and flags** (link → volume add with no `-s` → all variable sets with `--skip-deploys` before the one `redeploy` → poll → domain → health), the idempotent-rerun skip, the credential-reuse-on-rerun behavior, and the update path touching only the named service. |
| D9 | Docs update | docs | project-manager | README / deploy docs: what this path is for vs. `install-template.ps1` (still correct for quick/marketplace-direct trials and the public proof instance's own `main`-tracked source), and why variables are set explicitly despite `railway.toml`'s `[variables]` block existing. |

## Session Breakdown

Single session:

1. Plan + ACs (this commit).
2. D2 + D3 (shared-helper extraction and relocation — mechanical, no new
   behavior).
3. D4 + D5 + D6 + D7 (new provisioning/update code + CLI + PowerShell).
4. D8 (tests).
5. D9 (docs).
6. Verification sub-agent + `/review` + present to human.

## Commit Schedule

1. `docs: add plan and ACs for client-template-pinning`
2. `refactor: extract shared railway service helpers and relocate railway-variables`
3. `feat: add client instance provisioning and template-ref update path`
4. `test: cover client provisioning and update-ref command sequences`
5. `docs: document client template pinning path`

## Non-Goals

- No live Railway operations in this session (no project creation, no
  `railway up`, no volume add against a real account) — everything is
  verified against a fake `RailwayRunner`. A live smoke test is a separate,
  explicitly-requested, billable step.
- No change to `railway.toml` — its `[variables]` block stays correct for
  the GitHub-source-tracked public proof instance; the new provisioner sets
  the same keys explicitly *because* `railway up` doesn't apply that block,
  not because the block is wrong.
- No change to `install-template.ps1` or its underlying marketplace-deploy
  path — this is a complementary path, not a replacement, per the issue's
  own scope note.
- No automated Railway workspace/account setup, no automated project
  deletion/teardown, no secret rotation.
- No fix to the pre-existing "reuse branch always generates a fresh
  password" behavior in the marketplace installer (`index.ts`) beyond not
  repeating it in the new code.
