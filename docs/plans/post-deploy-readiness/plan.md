# Post-Deploy Readiness Plan

## Cadence

Full cadence (docs convention only — this repo has not opted into the
hook-enforced `verification-status.json` state machine, so gates below are
run and recorded manually rather than blocked mechanically). Follows
`docs/plans/client-template-pinning/` as the structural precedent.

## Goal

Automate the three post-deploy finalization steps found during the
reference live onboarding exercise that a freshly-deployed OpenClaw
Railway instance needs to reach a genuinely working, paired dashboard, so a
real client onboarding doesn't require manual API calls after the shell
install succeeds. Resolves items 3, 4, 5 of GitHub issue #18.

## Scope note — what this plan does NOT cover

Issue #18 originally bundled 7 Part-1 items plus a Part-2 (agent
identity/soul seeding). Scope was split during planning (see #18 comments):

- **Items 1, 2, 7** (credential-write BOM safety, pre-deploy variable
  ordering, the `railway volume add` CLI panic workaround) are owned by
  **#16**, implemented on `feat/client-template-pinning`. That branch
  already modifies `packages/openclaw-railway-installer/src/index.ts` and
  adds `src/provision-client.ts` — **this plan will conflict with that
  branch on `index.ts`** when one of the two merges after the other. Not
  avoidable (both legitimately touch the same install flow); flagged so
  whoever merges second does the rebase deliberately rather than being
  surprised. `provision-client.ts` does not exist on `main` yet (this
  plan's base), so this plan cannot wire its new readiness/CORS/pairing
  steps into it — that's a follow-up once #16 lands (see Non-Goals).
- **Item 6** (wrapper's own readiness-timeout-vs-health-monitor-grace
  mismatch) is upstream openclaw-core/wrapper-template behavior, not a
  control-plane code fix. Doc note only (D7).
- **Part 2** (seed agent identity/soul from the client profile) is split
  out to **#20** — mechanism confirmed from docs but not live-tested, and
  half its content ownership sits in the private client-profile repo.

## Background (live-verified findings from #18, confirmed against wrapper source)

- **Item 3**: `GET /setup/healthz` is unauthenticated and can return `200`
  from a container mid-transition (before the *new*, rotated
  `SETUP_PASSWORD` is actually in effect), giving a false-ready signal.
  `GET /setup/api/status` is `requireSetupAuth`-gated — polling it with the
  new Basic Auth credentials is the correct readiness signal because it
  only succeeds once the new credentials are actually live.
- **Item 4**: `gateway.controlUi.allowedOrigins` has no environment-variable
  override and isn't auto-seeded for a Railway-style reverse-proxied
  deployment (the seeding migration only fires for non-loopback `--bind`;
  the wrapper always starts the gateway with `--bind loopback`). This is
  the confirmed root cause of the "origin not allowed" dashboard error —
  not `PORT`. Fixable via the wrapper's own `GET`/`POST
  /setup/api/config/raw` (confirmed live against
  `vignesh07/clawdbot-railway-template`'s `src/server.js:1082-1118`): GET
  returns `{ok, path, exists, content}` where `content` is the raw
  `openclaw.json` text; POST accepts `{content}` and writes it back
  (500KB cap, auto-backup, and restarts the gateway if `isConfigured()`).
  **POST always restarts the gateway when the config is already
  configured** — so this plan's patch must be idempotent (skip the POST
  entirely when the origin is already present) to avoid an unnecessary
  restart on every install/reinstall.
- **Item 5**: first-time device/browser connections require pairing
  approval even with a correct `OPENCLAW_GATEWAY_TOKEN`. Confirmed live
  against the same `server.js`: dedicated REST endpoints exist —
  `GET /setup/api/devices/pending` (`server.js:1131-1136`) returns
  `{ok, requestIds: string[], output}` — the wrapper already runs the CLI
  output through its own `extractDeviceRequestIds()` before responding, so
  no client-side text parsing is needed — and
  `POST /setup/api/devices/approve` (`server.js:1139-1145`) takes
  `{requestId}`, validated server-side against `^[A-Za-z0-9_-]+$`. (An
  earlier investigation pass in this session initially miscorrected this
  to the console-command form, `POST /setup/api/console/run
  {cmd:"openclaw.devices.approve"}` — that command also exists in
  `ALLOWED_CONSOLE_COMMANDS` and works, but the dedicated
  `/setup/api/devices/*` routes are the more direct, already-structured
  path and are what this plan uses.) This only covers pairing for whatever
  session the installer itself uses to verify — the client's own first
  real browser login will still trigger its own fresh pairing request,
  since pairing is per-device. Not eliminable for security reasons.

## Design

All three steps slot into `installOpenClawOnRailway` in
`packages/openclaw-railway-installer/src/index.ts`, after the existing
domain-fix step and in place of the current unauthenticated health check,
in this order: readiness (auth-gated) → allowedOrigins patch → device
pairing approve. Each step is its own module for testability and reuse (a
future integration into `provision-client.ts`, once #16 lands, only needs
to import these, not duplicate them).

1. **`checkSetupStatus`** (replaces the `healthCheck` call site in
   `installOpenClawOnRailway`; the existing `healthCheck` export and its
   `dependencies.healthCheck` injection point stay as-is for any other
   caller — this plan does not repurpose or remove them). New exported
   function: `checkSetupStatus(url, auth: {username, password},
   dependencies): Promise<number>`, with a `dependencies.checkSetupStatus?`
   override point mirroring the existing `healthCheck?` pattern for
   testability. Default implementation sends `GET ${url}` with an
   `Authorization: Basic ...` header built from `auth`, returns
   `response.status`. Poll loop reuses the existing poll/timeout shape
   already in `installOpenClawOnRailway`, targeting
   `${baseUrl}/setup/api/status` instead of `${baseUrl}/setup/healthz`.
2. **`patchAllowedOrigins(baseUrl, auth, domain, dependencies)`** — new
   module `src/patch-allowed-origins.ts`. GETs `/setup/api/config/raw`,
   parses `content` as JSON, reads `gateway.controlUi.allowedOrigins`
   (defaulting to `[]` if the path doesn't exist yet), and if
   `https://${domain}` is not already present: appends it, re-serializes,
   POSTs `{content}` back to the same path. If already present: no POST.
   Returns whether a write happened, for `InstallResult` reporting.
3. **`approveOwnDevicePairing(baseUrl, auth, dependencies)`** — new module
   `src/approve-own-device.ts`. GETs `/setup/api/devices/pending`. If
   `requestIds.length === 0`: no-op, returns `undefined`. If `=== 1`:
   POSTs `/setup/api/devices/approve` with that `requestId`, returns it.
   If `> 1`: throws (ambiguous — this installer only approves pairing for
   its own single verification session; guessing which of several pending
   requests is "ours" would risk approving someone else's).
4. Wire all three into `installOpenClawOnRailway`, extending
   `InstallResult` with `patchedAllowedOrigins: boolean` and
   `approvedDeviceRequestId?: string` so callers/handoff docs can report
   what happened.

## Deliverables

| ID | Deliverable | Kind | Owning role | Notes |
| --- | --- | --- | --- | --- |
| D1 | Plan and ACs docs | docs | project-manager | This document + `ACs.md`. |
| D2 | `checkSetupStatus` auth-gated readiness check | script | devops | Replaces the `/setup/healthz` poll in `installOpenClawOnRailway` with an authenticated `/setup/api/status` poll using the resolved setup credentials. |
| D3 | `patchAllowedOrigins` | script | devops | New module: read/patch/write `gateway.controlUi.allowedOrigins` via `/setup/api/config/raw`, idempotent. |
| D4 | `approveOwnDevicePairing` | script | devops | New module: list + approve the installer's own pending device pairing via `/setup/api/devices/pending`+`/approve`, with an explicit ambiguity guard. |
| D5 | Wire D2–D4 into `installOpenClawOnRailway` | script | devops | Integration in `index.ts`: call order, `InstallResult` extension, handoff-doc update in `buildHandoff`. |
| D6 | Mocked tests | tests | test-engineer | Cover D2 (auth header + endpoint, not `/healthz`), D3 (idempotency + preserves existing origins), D4 (zero/one/many pending). |
| D7 | Docs update | docs | project-manager | README/deploy docs: document the three new post-deploy steps and why; cross-reference #16 (items 1/2/7) and #20 (Part 2) so the issue-#18 scope split is recorded in-repo, not only in GitHub comments. |

## Commit Schedule

1. `docs: add plan and ACs for post-deploy-readiness`
2. `feat(railway-installer): poll auth-gated /setup/api/status for readiness`
3. `feat(railway-installer): auto-patch gateway.controlUi.allowedOrigins post-deploy`
4. `feat(railway-installer): auto-approve installer's own device pairing`
5. `test(railway-installer): cover readiness/CORS-patch/pairing-approve steps`
6. `docs: document post-deploy readiness automation and #18 scope split`

## Non-Goals

- No live Railway operations in this session — everything verified against
  injected fetch/dependency stubs, matching `client-template-pinning`'s own
  precedent. A live smoke test is a separate, explicitly-requested,
  billable step.
- No change to `provision-client.ts` — it doesn't exist on this branch's
  base (`main`); it lands via #16. Once #16 merges, wiring D2–D4 into
  `provision-client.ts`'s own flow (which currently has its own separate
  `/setup/healthz` call, per #16's plan) is a follow-up, not part of this
  plan.
- No fix for item 6 (wrapper readiness-timeout mismatch) beyond a doc note
  — it's upstream openclaw-core/wrapper-template behavior.
- No implementation of Part 2 (agent identity/soul seeding) — tracked in
  #20.
- No change to the wrapper template itself
  (`vignesh07/clawdbot-railway-template`) — this plan only calls its
  already-existing, already-deployed endpoints.
