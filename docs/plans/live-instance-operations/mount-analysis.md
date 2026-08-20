# Control UI Mount Analysis (D7)

**Plan:** `docs/plans/live-instance-operations/plan.md` (deliverable D7, stream C1)
**ACs:** `docs/plans/live-instance-operations/ACs.md` (AC-FN-011, AC-FN-012, AC-DOC-001, AC-SEC-001)
**Status:** analysis only. Recommends one target end state. Applying it is D8; the
exemption re-decision is D9. Neither is done here.

## Scope and method

This document answers five questions about how the Control UI is mounted on an
already-provisioned live instance, and what a remediation would touch.

**How it was produced — read this first, it is the AC-FN-012 evidence.** Every
claim below comes from reading source. Specifically:

- This repository's working tree at the current branch.
- The vendored Railway wrapper's `src/server.js`, fetched unauthenticated from
  its public origin at the exact commit pinned by `Dockerfile`
  `ARG OPENCLAW_TEMPLATE_REF` (`Dockerfile:9`) — the same tarball the build
  itself fetches at `Dockerfile:20-21`.
- The upstream OpenClaw application tree, fetched unauthenticated from its
  public origin at the exact tag pinned by `Dockerfile` `ARG OPENCLAW_GIT_REF`
  (`Dockerfile:139`) — the same ref the build clones at `Dockerfile:140`.

**Not done, deliberately:** no authenticated request to any live instance, no
request of any kind to a live instance, no write of any kind, no deploy, no
Railway CLI invocation, no read or use of any credential. Where an answer needs
live evidence, it is recorded in [What could not be determined](#what-could-not-be-determined-without-live-access)
as an open question rather than guessed at or gathered.

### Citation convention

Third-party line numbers are unstable across refs, so every upstream citation
names the pin rather than a local path:

- **`[wrapper]`** = the vendored Railway wrapper at the commit pinned by
  `Dockerfile` `ARG OPENCLAW_TEMPLATE_REF`. Line numbers are **upstream source,
  before this repo's build-time `sed` patches** (`Dockerfile:55-115`). Runtime
  line numbers inside a built container differ; that is expected, not a
  discrepancy.
- **`[app]`** = upstream OpenClaw at the tag pinned by `Dockerfile`
  `ARG OPENCLAW_GIT_REF`.

## The two layers, and where the seam is

Requests hit two independent path-routing layers in series.

1. **Wrapper (Express).** Serves `/healthz`, `/setup*`, `/hooks*` itself, then a
   single catch-all — `app.use(requireDashboardAuth, …)` at
   `[wrapper] src/server.js:1368-1392` — which runs the Basic-Auth gate and, if
   it calls `next()`, proxies the request verbatim to the gateway on loopback
   (`proxy.web(req, res, { target: GATEWAY_TARGET })`, `[wrapper]
   src/server.js:1391`). **No path rewriting happens at the proxy hop.** The
   path the browser sent is the path the gateway receives.
2. **Gateway (the application).** Classifies the incoming path against its own
   `gateway.controlUi.basePath` and serves, redirects, 404s, or declines
   (`[app] src/gateway/control-ui-routing.ts:13-53`).

The base path is a **layer-2 concept only**. Layer 1 has never heard of it.

## Q1 — Can the wrapper's auth gate observe the application's base-path config?

**Confirmed: the gate does not observe it, and nothing wires it to.** Refuting
the stronger claim that it *could not*: it could, at a cost. Both halves matter,
because Q4's middle option depends on the difference.

`requireDashboardAuth` is `[wrapper] src/server.js:1334-1352`. Its complete
input set is:

- `req.path` (compared against literal strings and prefixes),
- the module-level `SETUP_PASSWORD` constant,
- the request's `Authorization` header.

It reads no file, makes no call, and consults no gateway state. It is registered
as the first handler of the catch-all at `[wrapper] src/server.js:1368`, and the
proxy call that would hand the request to the application is the *last* line of
that same handler (`[wrapper] src/server.js:1391`). So the gate provably runs
before anything reaches the application, which is where base-path knowledge
lives (`[app] src/gateway/server-runtime-config.ts:110` reads
`cfg.gateway?.controlUi?.basePath`; `[app] src/gateway/server-http.ts:720,735,749`
is the only place it is passed to a handler).

The wrapper is, however, in the same container as the config file and already
reads it for other purposes: `configPath()` at `[wrapper] src/server.js:93-104`,
`isConfigured()` at `[wrapper] src/server.js:106-112`, and a `GET
/setup/api/config/raw` handler at `[wrapper] src/server.js:1082-1091` that reads
and returns the whole file. It also shells out `openclaw config set …` at boot
(`[wrapper] src/server.js:1438-1443`). So a derived exemption is buildable. It is
not *free* — see Q4.

One near-miss worth naming so a future reader does not mistake it for base-path
awareness: `waitForGatewayReady` probes `["/openclaw", "/"]` at `[wrapper]
src/server.js:156` with a comment calling `/openclaw` "the default Control UI
base path." That is a readiness probe with a hardcoded guess and a root
fallback, not configuration observation, and it is not on the auth path.

**Consequence for the merged exemption.** Because the gate is base-path-blind,
the exemption's correctness is entirely independent of what the application is
configured to do. It matches a hardcoded literal against `req.path` and will keep
matching that literal, and only that literal, whatever the base path becomes.

## Q2 — If the base path were configured, what changes?

**All four reported 404 classes are fixed by configuring the base path.** Trace,
against `[app] src/gateway/control-ui.ts:961-1190`.

### Current state (base path empty — root-mounted)

`classifyControlUiRequest` with `basePath: ""` (`[app]
src/gateway/control-ui-routing.ts:20-41`) returns `serve` for any read-method
path that is not `/ui*`, a core probe path, `/plugins*`, or `/api*`. `/openclaw`
is none of those, so the gateway *serves* it. What it serves is decided by the
`rel` computation at `[app] src/gateway/control-ui.ts:1096-1113`:

| Requested path | `rel` resolves to | On-disk hit? | Result |
| --- | --- | --- | --- |
| `/openclaw` | `openclaw` | no | no known extension → **SPA fallback, index.html, 200** (`control-ui.ts:1163-1186`) |
| `/openclaw/assets/<hash>.js` | `assets/<hash>.js` | yes | **200** — `uiPath.indexOf("/assets/")` at `control-ui.ts:1108-1111` finds the substring and slices *from there*, discarding the `/openclaw` prefix |
| `/openclaw/manifest.webmanifest` | `openclaw/manifest.webmanifest` | no | `.webmanifest` is in `STATIC_ASSET_EXTENSIONS` (`control-ui.ts:150-164`) → **404** (`control-ui.ts:1163-1166`) |
| `/openclaw/favicon.svg`, `/openclaw/sw.js`, `/openclaw/favicon-32.png` | same shape | no | **404**, same rule |
| `/openclaw/control-ui-config.json` | `openclaw/control-ui-config.json` | no | `matchesControlUiBootstrapConfigPath` (`control-ui.ts:943-959`) matches none of its three accepted forms when `basePath` is `""` → falls through → `.json` → **404** |

That is precisely the reported symptom, and it confirms both coincidences named
in the brief: a generic SPA fallback for the shell, and an `/assets/` substring
search that ignores any prefix in front of it.

### With `gateway.controlUi.basePath` set to the prefix

`normalizeControlUiBasePath` (`[app] src/gateway/control-ui-shared.ts:12-29`)
canonicalises the value to a leading-slash, no-trailing-slash string. Then:

- `/openclaw` **302-redirects** to `/openclaw/`
  (`control-ui-routing.ts:49-51`; upstream test
  `[app] src/gateway/control-ui-routing.test.ts:70-115`). This alone removes the
  trailing-slash
  ambiguity that currently governs live behaviour (see Q3).
- `uiPath` becomes `pathname.slice(basePath.length)`
  (`control-ui.ts:1096-1097`), so `/openclaw/manifest.webmanifest` →
  `manifest.webmanifest`, which **exists** in the built UI root
  (`ui/public/` is Vite's `publicDir`, `[app] ui/vite.config.ts:260`) → **200**.
  Same for `favicon.svg`, `favicon-32.png`, `favicon.ico`,
  `apple-touch-icon.png`, `sw.js`.
- `matchesControlUiBootstrapConfigPath` accepts
  `` `${basePath}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}` `` — and
  `CONTROL_UI_BOOTSTRAP_CONFIG_PATH` is `"/control-ui-config.json"`
  (`[app] src/gateway/control-ui-contract.ts:4`) — so
  `/openclaw/control-ui-config.json` → **200**.
- The served `index.html` is rewritten on the way out:
  `rewriteControlUiIndexHtmlPublicAssetHrefs` (`control-ui.ts:176-189`) turns
  `href="/manifest.webmanifest"` into `href="/openclaw/manifest.webmanifest"`
  for every member of `CONTROL_UI_ROOT_PUBLIC_ASSETS` (`control-ui.ts:167-174`),
  and `serveResolvedIndexHtml` (`control-ui.ts:795-822`) stamps
  `data-openclaw-control-ui-base-path="/openclaw"` onto `<html>`. Upstream test
  `[app] src/gateway/control-ui.http.test.ts:909-931` asserts exactly this.
- The browser app reads that attribute first
  (`[app] ui/src/app/browser.ts:10-26`) and derives every root public asset URL
  and the bootstrap config URL from it
  (`ui/src/app/public-assets.ts:14-31`, `ui/src/app/config.ts:167-170`).

No rebuild is required for this. Vite's `base` defaults to `"./"` — relative —
unless `OPENCLAW_CONTROL_UI_BASE_PATH` is set at build time
(`[app] ui/vite.config.ts:250-251`), and this repo's build does not set it
(`Dockerfile:151`). Relative asset URLs resolve correctly under either mount.

### The trailing-slash fork — why today's state is worse than "cosmetically wrong"

With the base path empty there is **no redirect**, so the URL keeps whatever
shape the user arrived with, and the browser app infers its base path from that
shape (`[app] ui/src/app/browser.ts:10-26` → `inferBasePathFromPathname`,
`ui/src/app-route-paths.ts:77-109`). The attribute is only stamped when a base
path is configured (`control-ui.ts:803-805`), so with an empty base path it is
absent and inference always runs.

- Arriving at `/openclaw` (no trailing slash): `isMountRoot` is false, no route
  segment matches, the final expression returns `""`. The app treats itself as
  root-mounted and requests `/control-ui-config.json`, `/manifest.webmanifest`,
  `/sw.js` — all root paths, all **exempted** by the pre-existing patch
  (`Dockerfile:55-57`) and all served. This branch works.
- Arriving at `/openclaw/` (trailing slash): `isMountRoot` is true and
  `segments` is `["openclaw"]`, so the same function returns `"/openclaw"`. The
  app now requests `/openclaw/control-ui-config.json`,
  `/openclaw/manifest.webmanifest`, `/openclaw/sw.js`,
  `/openclaw/provider-icons/*.svg` — **every one a 404** per the table above —
  while `/openclaw/assets/*` still 200s through the substring coincidence. A
  half-loaded app with no bootstrap config.

`inferBasePathFromPathname` calls `normalizePath` from an external package
(`@openclaw/uirouter`, `[app] ui/package.json:17`) that is not in the
application's own tree. That does not change the conclusion: both `/openclaw`
and `/openclaw/` split-and-filter to `segments = ["openclaw"]` regardless of how
the normaliser treats the trailing slash, and the divergence is driven by
`isMountRoot`, which is computed from the raw pathname before normalisation
(`ui/src/app-route-paths.ts:78`).

So the current configuration is not merely "working by coincidence" — it is
**working or half-broken depending on a trailing slash**, with nothing in the
system pinning which. That is the strongest argument for picking a definite
target state rather than leaving it.

## Q3 — Which end state should this deployment target?

**Recommendation: root-mount. Leave `gateway.controlUi.basePath` unset, and make
the root URL the documented and linked entry point.**

### First: how the current value came to be

`basePath` is set **nowhere in this repository**. A repo-wide search across
`packages/`, `deploy/`, `apps/`, `workers/`, `tests/`, `fixtures/`,
`Dockerfile`, and `railway.toml` returns no match. Nor is there an
environment-variable override to accidentally inherit: the value is read only
from the config file (`[app] src/gateway/server-runtime-config.ts:110`), and a
search of the application source for an env-based override of it finds none.
The only env var with a similar name, `OPENCLAW_CONTROL_UI_BASE_PATH`, is a
**Vite build-time** setting for asset URL base (`[app] ui/vite.config.ts:250`),
unrelated to runtime routing and unset by this build.

The live value is therefore empty because nothing ever set it — not because
something unset it, and not because a provisioning step regressed. There is no
drift to explain and no code path to repair. This matters: it means "make the
prefix real" is a *new* capability to build and maintain, not a repair.

### The documentation contradiction, stated plainly

`deploy/openclaw-railway/README.md` claims the prefixed URL as the Control UI's
address in at least four places — the wrapper "proxies the Control UI at
`/openclaw`" (line 6), `/openclaw` listed as a runtime route (line 88), the
setup password described as gating "`/setup` and `/openclaw`" (line 254), and
the whole fix-1/2/3 narrative (lines 258-317). `Dockerfile:61-62` states it as
fact: "The Control UI's HTML shell and static assets are served under this
wrapper's fixed `/openclaw` base path."

**Both claims are wrong as written.** Nothing in the wrapper mounts the Control
UI under `/openclaw`; the wrapper proxies every unmatched path through
unmodified (`[wrapper] src/server.js:1391`). Nothing in the application mounts
it there either, absent the config key. The application's own documentation
describes root as the default and the prefix as opt-in: "default:
`http://<host>:18789/` — optional prefix: set `gateway.controlUi.basePath`
(e.g. `/openclaw`)" (`[app] docs/web/control-ui.md:10-13`). The one place
`/openclaw` is treated as a default in the wrapper is the readiness probe at
`[wrapper] src/server.js:156`, which falls back to `/` precisely because the
guess is not reliable.

This contradiction is real and must be resolved by D8 whichever state is chosen.
It is *not*, on its own, an argument for the prefixed mount: correcting a doc is
cheap, and the wrapper's hardcoded `<a href="/openclaw">` on its setup page
(`[wrapper] src/server.js:390`) is a one-line `sed`, using a patch technique this
`Dockerfile` already applies four times (`Dockerfile:55-115`).

### The actual discriminator: what happens to the blanket exemption

Both end states are technically workable. The decisive difference is what each
does to the merged prefix exemption (`Dockerfile:74-77`), which exempts the
entire `/openclaw` subtree from Basic Auth.

**Under root-mount the exemption becomes dead code and can be deleted.** The
pre-existing root-level exemption list (`Dockerfile:56`) already matches the
application's own root public-asset set almost exactly:

| Path | In `Dockerfile:56` exempt list | In `[app] CONTROL_UI_ROOT_PUBLIC_ASSETS` / `ui/public/` |
| --- | --- | --- |
| `/manifest.webmanifest`, `/favicon.ico`, `/favicon.svg`, `/favicon-32.png`, `/apple-touch-icon.png`, `/sw.js` | yes | yes |
| `/control-ui-config.json` | yes | it *is* `CONTROL_UI_BOOTSTRAP_CONFIG_PATH` under an empty base path |
| `/favicon-16.png` | yes | no — stale entry, harmless |
| `/provider-icons/ProviderIcon-*.svg` | **no** | yes (`ui/public/provider-icons/`) |

**Under base-path mount the exemption must be narrowed, not kept.** Widening the
prefix over a *real* mount pulls genuinely auth-gated application endpoints
under a blanket bypass. Concretely, with `basePath: "/openclaw"`:

- `resolveAssistantMediaRoutePath` (`[app] src/gateway/control-ui.ts:289-293`)
  becomes `/openclaw/__openclaw__/assistant-media`, which matches
  `req.path.startsWith("/openclaw/")` and skips the wrapper's Basic Auth.
- The prefixed bootstrap config `/openclaw/control-ui-config.json` does too —
  an endpoint upstream explicitly documents as gated: "unauthenticated browsers
  cannot fetch it" (`[app] docs/web/control-ui.md:93`).
- Both then reach the gateway carrying a valid credential, because the merged
  fix at `Dockerfile:111-115` made `attachGatewayAuthHeader` inject the gateway
  Bearer token **unconditionally** (upstream's conditional form is `[wrapper]
  src/server.js:1358-1362`; the patch removes the guard). The gateway's own
  check (`authorizeControlUiReadRequest`, `[app]
  src/gateway/control-ui.ts:327-414`) is satisfied by that injected token.

**This exposure is created by the remediation, not pre-existing.** Under today's
empty base path the same handler's route is `/__openclaw__/assistant-media` —
root-level, outside the `/openclaw/` prefix, and absent from the exact-match
exempt list at `Dockerfile:56` — so Basic Auth still gates it today. Choosing the
base-path mount without simultaneously narrowing the exemption would move it
from gated to open.

### Recommendation and its cost

**Target root-mount**, on these grounds:

1. It requires **no live config write at all** — the strongest possible outcome
   under a plan whose entire purpose is to govern live writes. The current value
   is already correct for this target.
2. It lets D9 **delete** an auth exemption rather than widen and then re-narrow
   one.
3. It matches the application's documented default, so no per-instance config
   state has to be created, remembered, or re-applied after a volume restore —
   the exact drift class that already produced the `allowedOrigins` incident
   (`packages/openclaw-railway-installer/src/patch-allowed-origins.ts:17-22`).
4. It needs no new provisioning code. The base-path mount would need a new
   compare-then-write config path alongside the CORS patch, plus tests, plus a
   tier marker — for a value with no environment-variable override.

The costs, both accepted:

- **Documentation must change**, in `deploy/openclaw-railway/README.md` and the
  `Dockerfile:61-73` comment block. Unavoidable either way — those claims are
  wrong today regardless of which state is chosen.
- **The wrapper's setup-page link should be patched** from `/openclaw` to `/`
  (`[wrapper] src/server.js:390`), by the same `sed`-plus-`grep -F`-assertion
  technique already used four times in this `Dockerfile`. Without it, the setup
  page keeps sending users to a non-canonical URL that only works via the SPA
  fallback — and it is the *no-trailing-slash* form, which is the branch that
  happens to work, so the failure would stay latent.
- **One residual risk specific to root-mount:** `/provider-icons/*.svg` is not
  in the root exempt list. See the open question below before D8 treats
  root-mount as fully covered.

## Q4 — What should happen to the merged hardcoded exemption?

**Recommendation: revert it — but sequenced behind Q3's doc and link changes,
not before them.**

- **Keep as-is: no.** Under the recommended target it protects nothing: it
  matches a subtree the application does not mount. It also carries exactly the
  coupling the brief names — it is a literal, the gate cannot see the config
  (Q1), so if the base path ever *did* become non-empty and different, the
  exemption would silently stop matching with no build-time or runtime signal.
  Its `grep -qF` assertion (`Dockerfile:77`) verifies the patch applied, not
  that the literal is still the right one.
- **Derive from configuration: no, on cost and coupling — not on impossibility.**
  Q1 establishes this is buildable: the wrapper already reads the config file
  (`[wrapper] src/server.js:93-112, 1082-1091`). But it would put a config read
  (or a cache with an invalidation story spanning `restartGateway()` at
  `[wrapper] src/server.js:1093-1120`) into the hot path of every request's auth
  check, inside a `sed`-patched third-party file this repo does not own. And it
  would still not be sufficient: a derived *prefix* exemption reproduces the
  assistant-media and bootstrap-config widening from Q3 exactly. The correct
  derived form would be a base-path-joined **explicit list** mirroring
  `CONTROL_UI_ROOT_PUBLIC_ASSETS`, which is strictly more work than deleting the
  patch. Under root-mount that work buys nothing.
- **Revert: yes.** With the canonical URL at root, every path the browser fetches
  passively is already covered by the pre-existing exact-match exemption
  (`Dockerfile:56`), which is the narrower and better-reasoned patch.

**Sequencing is load-bearing.** Reverting before the docs and the setup-page link
move to root would leave a user who lands on `/openclaw/` (trailing slash) with
prefixed passive fetches turning from 404 back into 401 — which is the
re-firing native Basic-Auth popup this exemption was merged to stop. The revert
is safe only after the entry point is unambiguously root. D9 should record that
ordering as part of the decision, not as an implementation detail.

## Q5 — What would remediation touch, and what is the rollback?

Under the recommended target state, remediation is **not** a live config write.
Three change surfaces, in dependency order. Tier names are the protocol's
(`docs/live-instance-operations.md` §2.2); the deploy surface is governed by its
prod-state change procedure (§5) and needs a pre-flight declaration (§4).

| # | Surface | Mutation tier | Rollback |
| --- | --- | --- | --- |
| 1 | `deploy/openclaw-railway/README.md` and the `Dockerfile:61-73` comment block — correct the `/openclaw` claims, document the root URL | none (repo doc) | revert the commit; nothing live is affected |
| 2 | `Dockerfile` — add a `sed` retargeting the wrapper's setup-page link to `/`; remove the prefix-exemption `sed` and its assertion (`Dockerfile:74-77`) | **deploy** — takes effect only via a new image build | revert the commit **and redeploy**; a git revert alone changes nothing live |
| 3 | Live config: **no write.** Confirm `gateway.controlUi.basePath` is still absent | read | n/a — nothing written |

Notes that matter for whoever executes D8:

- **Surface 2 is deploy-tier, and deploys here are one-shot snapshot uploads**
  unconnected to git state
  (`packages/openclaw-railway-installer/src/provision-client.ts:21-32`). So "roll back" means building and deploying the prior
  Dockerfile, not reverting a branch. There is no automatic reversion, and the
  window between a bad deploy and its replacement is a live outage window for
  the dashboard. This is the tier the triggering incident bypassed entirely.
- **Surface 3 is a read**, and a tested library path already covers it
  (`patch-allowed-origins.ts:80-88` issues the `GET /setup/api/config/raw` this
  would use). Per the protocol's read-tier rule, that read should go through
  library code rather than an ad hoc command, and the credential-flow rule
  (§2.4) forbids interpolating the setup password into the argument string —
  which is exactly what the incident's blocked command did.
- **If the alternative (base-path mount) is chosen instead**, remediation becomes
  a **restart-or-redeploy-triggering** write against live config — the protocol
  places raw-config POSTs in that tier, not in plain write. The wrapper's `POST
  /setup/api/config/raw` copies the existing file to a timestamped
  `.bak-<iso>` before writing and then calls `restartGateway()`
  (`[wrapper] src/server.js:1093-1120`), so the prior content is recoverable
  from the volume — but the rollback POST restarts the gateway a second time.
  That path also requires narrowing the exemption in the *same* change, per Q3,
  or it opens the endpoints listed there. It should not be split across two
  deploys.

## What could not be determined without live access

Recorded as open questions rather than guessed. None of them changes the Q3
recommendation; the first three change how D8 verifies it, and the fourth is a
residual risk D8 should close.

1. **The live value of `gateway.controlUi.basePath` was not read in this
   session.** The "currently empty" premise comes from prior evidence supplied
   with the brief plus the code-level fact that nothing in this repo ever sets
   it and no env override exists. D8 should confirm it with a read through the
   library path before acting, not treat this document as the confirmation.
2. **Which URL shape live browsers actually land on** — `/openclaw` or
   `/openclaw/` — is undetermined, and per Q2's fork it decides whether the
   merged exemption is practically covering one HTML document or an entire
   asset tree. Direct-probe evidence (prefixed bundles 200, prefixed
   manifest/favicon/sw/config 404) is consistent with both branches, because it
   describes what the server returns, not what the browser asked for. Settling
   it needs a live request-log status breakdown per path — and this repo's own
   history records that a single successful spot-check is not sufficient
   evidence for a routing/auth fix.
3. **Whether the merged exemption is currently load-bearing for real traffic at
   all** follows from (2) and is likewise a log question, not a code question.
4. **Which root-level paths still need adding to the exact-match exempt list.**
   The exemption table in Q3 shows the list covering the application's root
   public assets, but two root-level paths the browser fetches are absent from
   `Dockerfile:56`, and both are the same class as `/avatar/<agentId>` — a path
   this repo's own history records as 401'ing in 100% of live samples because
   the browser never attached cached Basic-Auth credentials to it. Whether that
   behaviour repeats here cannot be answered from source; it is a browser
   question, and it is **assumed, not measured**, in both directions below.

   - `/__openclaw__/assistant-media` — the sharper of the two. It is rendered
     directly as an `<img src>`
     (`[app] ui/src/pages/chat/components/chat-message.ts:1674, 1685-1691`, URL
     built by `buildAssistantAttachmentUrl` at `:1374-1390`), and the
     signed-`mediaTicket` query-param mechanism
     (`[app] src/gateway/control-ui.ts:459-479`, consumed at `:604-618`) exists
     precisely so the URL works where a `fetch()` auth header cannot be set —
     i.e. a media element. Under an empty base path its route is root-level
     (`resolveAssistantMediaRoutePath`, `[app] src/gateway/control-ui.ts:289-293`)
     and not in the exempt list, so a chat image attachment would 401 at the
     wrapper before reaching the gateway.
   - `/provider-icons/*.svg` — the milder one. Fetched as a CSS `url()`
     background image
     (`[app] ui/src/pages/chat/components/chat-model-controls.ts:219-227` via
     `inferControlUiPublicAssetPath`), which resolves to root under an empty
     inferred base path. CSS `url()` loads are ordinary same-origin
     subresources and most likely *do* carry cached credentials — the two
     documented exceptions in this repo's evidence (`<link rel="manifest">` and
     favicons) are special for reasons that do not apply here — so this one is
     probably fine.

   **Neither is a regression introduced by root-mount**: both are the current
   state today, since the base path is already empty. So this does not weaken
   the recommendation. It is a follow-up candidate — extend the exact-match
   list, or match `/__openclaw__/` by prefix the way `/avatar/` already is
   (`Dockerfile:56`) — and it should be settled by a live per-path status
   breakdown, not by reasoning. The base-path mount would mask both only via
   the blanket exemption that Q3 shows must be narrowed anyway.
5. **Whether any avatar or local-media root is configured** such that the
   widened exemption in the base-path option would expose real files rather
   than 404s. Relevant only if the recommendation is overridden.

## Inputs handed forward

- **To D8:** target state is root-mount; the change set is the three surfaces in
  Q5; open questions 1 and 4 should be closed before or during execution.
- **To D9:** the exemption decision is *revert*, with the sequencing constraint
  in Q4 and the security reasoning in Q3 as its justification — specifically
  that the alternative would have required narrowing the exemption rather than
  keeping it, which is the fact the original merge did not have.
- **To the orchestrating thread — a reconciliation item, since this deliverable
  cannot edit the plan.** The recommendation changes D8's shape. The plan
  declares D8 as `kind: config change`, but under root-mount its config axis is
  a confirm-only read (Q5, surface 3) and its real work is the `Dockerfile`
  edit — the same file D9's revert touches. D8 and D9 therefore collapse onto
  one change, internally ordered by Q4's constraint: the documentation and
  setup-link changes land before the exemption is removed. The human-approval
  gate on D7 is unaffected and still applies.

This document deliberately does not disposition the researched gap list; that
belongs to the protocol and the plan, and duplicating it here would place a gap
in two categories at once.
