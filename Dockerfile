# Railway proof runtime for the public OpenClaw Control Plane starter kit.
#
# The Railway service source should point at this public repo's main branch.
# This Dockerfile then pulls the pinned OpenClaw Railway wrapper dependency and
# builds the actual OpenClaw dashboard/runtime that serves /setup and the
# root-mounted Control UI at /. The Control UI is NOT served under a base path:
# gateway.controlUi.basePath is unset (its documented default) and nothing in
# this repo sets it. See docs/plans/live-instance-operations/mount-analysis.md.

FROM node:22-bookworm AS template-source

ARG OPENCLAW_TEMPLATE_REF=b9e2467189d02dfe51a80173c40bad650a58eaf2
ARG OPENCLAW_TEMPLATE_REPO=https://github.com/vignesh07/clawdbot-railway-template

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tar \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /template
RUN curl -fsSL "${OPENCLAW_TEMPLATE_REPO}/archive/${OPENCLAW_TEMPLATE_REF}.tar.gz" \
  | tar -xz --strip-components=1

# The wrapper's requireDashboardAuth gates every route with Basic Auth except
# /healthz, /setup/healthz, and /hooks* -- with no exemption for the browser's
# own PWA manifest/icon requests. Browsers (confirmed: Chrome) never attach
# cached HTTP Basic-Auth credentials to <link rel="manifest"> or favicon
# fetches, by spec/security design -- so those paths 401 forever regardless of
# what password is entered, and the browser re-prompts every time it retries
# them (tab refresh, PWA install checks). Not caused by an OPENCLAW_GIT_REF
# bump specifically -- this wrapper gap has always existed; it only became
# visible once the pinned OpenClaw version started shipping a PWA manifest/
# icon set the browser actively fetches. Patched here (not upstream) so every
# future OPENCLAW_GIT_REF bump inherits the fix automatically.
#
# /control-ui-config.json is exempted for a different, client-side reason:
# confirmed live that the OpenClaw app's own frontend attaches its Bearer
# token to this frequently-polled call inconsistently -- the exact same
# browser session flips between 401 and 200 for it within the same second,
# repeatedly, even after fix 2/3 below made a correctly-authed request to it
# succeed reliably via curl. That's a client-side bug in compiled/minified
# app JS this repo has no safe way to patch. Its response body is confirmed
# non-sensitive (assistantName, avatar status, local media paths -- no
# secrets), and it's the dominant source of the recurring native sign-in
# popup in practice, so it's exempted outright rather than left to keep
# re-triggering the browser's Basic-Auth challenge on every failed poll.
#
# /avatar/<agentId> (e.g. /avatar/main) is exempted for the original,
# browser-passive-fetch reason (same class as manifest/favicon): confirmed
# live it's 401 in 100% of real request-log samples, never once succeeding,
# consistent with an <img> tag load the browser never attaches cached
# Basic-Auth to. Confirmed with valid credentials it currently 404s (no
# avatar configured yet) -- nothing sensitive is served either way, and an
# avatar image wouldn't be sensitive even once one is set. Matched by prefix
# rather than a literal path since it's built from the agent id.
RUN sed -i \
  's#if (req.path.startsWith("/hooks")) return next(); // allow OpenClaw webhook endpoints to bypass dashboard auth#if (req.path.startsWith("/hooks")) return next(); // allow OpenClaw webhook endpoints to bypass dashboard auth\n  if (req.path.startsWith("/avatar/")) return next(); // see comments above and below this RUN step for why each path is exempted\n  if (["/manifest.webmanifest", "/favicon.ico", "/favicon.svg", "/favicon-16.png", "/favicon-32.png", "/apple-touch-icon.png", "/sw.js", "/control-ui-config.json"].includes(req.path)) return next(); // see comments above and below this RUN step for why each path is exempted#' \
  src/server.js
RUN grep -qF '/control-ui-config.json' src/server.js
RUN grep -qF 'req.path.startsWith("/avatar/")' src/server.js

# The Control UI is root-mounted (gateway.controlUi.basePath is unset, its
# documented default, and nothing in this repo ever sets it), but the wrapper's
# setup page links to a /openclaw prefix. That URL only appears to work: the
# gateway's SPA fallback serves index.html for unmatched browser navigations,
# so the shell loads while its manifest, icons, service worker, and bootstrap
# config all 404 under the prefix. Worse, the working-vs-half-broken split
# depends on a trailing slash, with nothing pinning which form a user lands on.
# Point the link at the canonical root path instead. See
# docs/plans/live-instance-operations/mount-analysis.md for the full trace.
RUN sed -i \
  's#<a href="/openclaw" target="_blank">Open OpenClaw UI</a>#<a href="/" target="_blank">Open OpenClaw UI</a>#' \
  src/server.js
RUN grep -qF '<a href="/" target="_blank">Open OpenClaw UI</a>' src/server.js
RUN ! grep -qF '<a href="/openclaw" target="_blank">' src/server.js

# Two root-level paths the browser fetches passively are absent from the
# exact-match exemption list above, and both are the same class as
# /avatar/<agentId> -- which this repo already had to exempt after observing it
# 401 in 100% of live request-log samples. The precise limitation is that a
# passive fetch cannot set an Authorization header of its own (so the app's
# Bearer token is unavailable to it); whether the browser volunteers *cached*
# Basic-Auth credentials is browser-dependent and, for the avatar path on this
# deployment, observed not to happen. /__openclaw__/assistant-media is rendered
# directly as an <img src> -- its signed mediaTicket query-param mechanism
# exists precisely because a media element cannot set an auth header -- and
# /provider-icons/*.svg is fetched as a CSS url() background. Without these
# exemptions each would 401 at the wrapper and re-trigger the native sign-in
# popup, trading the base-path popup for a different one. Neither serves
# anything sensitive: provider icons are static brand assets, and
# assistant-media is separately gated by the gateway's own signed-ticket check.
#
# assistant-media is matched EXACTLY, not by prefix: this is an auth bypass, and
# a prefix would silently exempt any future sibling route sharing the string
# (/__openclaw__/assistant-media-foo). req.path excludes the query string, so an
# exact match still covers the real ?source=...&mediaTicket=... requests.
RUN sed -i \
  's#if (req.path.startsWith("/avatar/")) return next(); // see comments above and below this RUN step for why each path is exempted#if (req.path.startsWith("/avatar/")) return next(); // see comments above and below this RUN step for why each path is exempted\n  if (req.path.startsWith("/provider-icons/")) return next(); // see comment above this RUN step for why\n  if (req.path === "/__openclaw__/assistant-media") return next(); // exact match, not prefix -- see comment above this RUN step for why#' \
  src/server.js
RUN grep -qF 'req.path.startsWith("/provider-icons/")' src/server.js
RUN grep -qF 'req.path === "/__openclaw__/assistant-media"' src/server.js
RUN ! grep -qF 'req.path.startsWith("/__openclaw__/assistant-media")' src/server.js

# requireDashboardAuth only accepts `Authorization: Basic ...` -- it rejects
# any other scheme outright, including a perfectly valid
# `Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>` the Control UI itself
# already sends for its own API calls once paired (unlike WebSocket upgrades,
# regular fetch() calls CAN set custom headers, so the app doesn't need the
# wrapper's Basic-Auth caching for these at all -- it sends its own Bearer
# token directly). Confirmed live: with the gateway token verified correct in
# the app's own Control UI settings, /control-ui-config.json and similar
# app-issued calls kept 401'ing regardless, because the wrapper's gate
# doesn't recognize Bearer as valid at all. Fix: accept a correct
# `Bearer <OPENCLAW_GATEWAY_TOKEN>` as an alternative to dashboard Basic Auth.
RUN sed -i \
  's#if (!SETUP_PASSWORD) return next(); // no password configured → open#if (!SETUP_PASSWORD) return next(); // no password configured → open\n  { const authHeader = req.headers.authorization || ""; const [authScheme, authValue] = authHeader.split(" "); if (authScheme === "Bearer" \&\& OPENCLAW_GATEWAY_TOKEN \&\& authValue === OPENCLAW_GATEWAY_TOKEN) return next(); }#' \
  src/server.js
RUN grep -qF 'authScheme === "Bearer"' src/server.js

# attachGatewayAuthHeader only injects the gateway's Bearer token when no
# Authorization header is already present. Once a browser has cached
# dashboard Basic-Auth credentials for this origin (guaranteed -- /setup and
# other still-gated routes require it), Chrome auto-attaches that cached
# `Authorization: Basic ...` header to every same-origin request, including
# the app's own fetch() calls. That header satisfies requireDashboardAuth's
# own gate, but then gets forwarded as-is to the real OpenClaw gateway, which
# only understands `Bearer <token>`. The gateway correctly rejects Basic
# auth, and the app's frontend surfaces that as its own "sign in" prompt --
# confirmed live: /control-ui-config.json returns a gateway-level
# {"error":{"message":"Unauthorized"}} even with valid dashboard Basic-Auth
# credentials. Not scoped to one route -- can hit any proxied request once
# the browser starts attaching cached credentials. Fix: always overwrite the
# Authorization header with the gateway's own Bearer token before proxying;
# the client's Basic-Auth header has already served its purpose satisfying
# requireDashboardAuth by this point and must never reach the gateway as-is.
RUN sed -i \
  's#if (!req?.headers?.authorization \&\& OPENCLAW_GATEWAY_TOKEN) {#if (OPENCLAW_GATEWAY_TOKEN) {#' \
  src/server.js
RUN grep -qF '  if (OPENCLAW_GATEWAY_TOKEN) {' src/server.js
RUN ! grep -qF '!req?.headers?.authorization' src/server.js

# restartGateway() sends SIGTERM to the wrapped OpenClaw gateway process, waits
# a flat 750ms with no confirmation the process actually exited, then
# unconditionally spawns a replacement. If OpenClaw's own shutdown (closing a
# channel provider's persistent connection, flushing state, etc.) ever takes
# longer than 750ms, the old and new gateway processes briefly run
# concurrently. Filed upstream at
# https://github.com/vignesh07/clawdbot-railway-template/issues/233. Observed
# live: OpenClaw's Slack channel logged "socket mode reports 2 active
# connections for this Slack app" -- structurally consistent with this
# exact race, though not confirmed as its cause in that specific incident.
# Patched here rather than waiting on upstream so every future
# OPENCLAW_TEMPLATE_REF bump doesn't reintroduce the exposure. Fix: wait for
# the process's actual `exit` event, escalating to SIGKILL after a timeout,
# before considering the gateway slot free.
#
# The same inline kill/sleep(750)/null sequence also lives in the
# POST /setup/import handler ("Stop gateway before restore so we don't
# overwrite live files") -- the one place a stale gateway process is actively
# dangerous, because tar.x then writes over the files it may still hold open.
# Both sites now call one exit-confirmed helper, stopGatewayAndWait(), that
# the script defines once above restartGateway(); the pinned template's four
# `await sleep(750);` sites drop to two (the gateway.stop and reset paths,
# which are out of scope). Tracked in
# https://github.com/yuens1002/openclaw-control-plane/issues/73.
# A real script rather than an inline `sed` one-liner: this is a multi-line
# structural replacement (the old kill/wait/null block spans several lines),
# and a multi-line `sed` pattern is fragile to get exactly right -- it's
# already caught one real correctness bug from Copilot review on the first
# `sed`-based version of this patch (a stale `gatewayProc` reference raced
# against the wrapper's own pre-existing exit handler). An exact literal
# block match via `String.prototype.replace` in scripts/patch-wrapper-restart-gateway.mjs
# is not ambiguous the way a hand-escaped multi-line sed pattern is, and the
# script fails loudly (non-zero exit) rather than silently no-op-ing if the
# pinned wrapper's source ever changes shape -- each of its three target
# blocks carries its own exactly-one-occurrence guard.
COPY scripts/patch-wrapper-restart-gateway.mjs ./patch-wrapper-restart-gateway.mjs
RUN node patch-wrapper-restart-gateway.mjs src/server.js
RUN grep -qF 'stopGatewayAndWait' src/server.js
RUN test "$(grep -cF 'async function stopGatewayAndWait()' src/server.js)" -eq 1
RUN test "$(grep -cF 'await stopGatewayAndWait();' src/server.js)" -eq 2
RUN grep -qF '// Wait for the process to actually exit' src/server.js
RUN grep -qF 'proc.once("exit"' src/server.js
RUN test "$(grep -cF 'await sleep(750);' src/server.js)" -eq 2
RUN node --check src/server.js

# The wrapper's GET /setup/export tars all of STATE_DIR plus WORKSPACE_DIR with
# no filter. Measured on a live instance during planning (read-only `du -sh`):
# STATE_DIR is 541 MB -- bin/ 415 MB, agents/main/sessions/ 64 MB, lib/ 32 MB,
# agents/main/agent/{plugins,codex-home} ~22 MB -- while the state that a
# backup actually needs (openclaw.json, exec-approvals.json, credentials/,
# devices/, cron/, identity/, memory/, state/openclaw.sqlite ~7 MB,
# agents/*/agent/{*.sqlite,models.json,auth-profiles*}) is ~7.2 MB. A daily
# backup pulling 541 MB to save 7 MB is the defect. state/openclaw.sqlite also
# runs in WAL mode with a live -wal/-shm pair, so even a filtered plain file
# copy is not a consistent database; the runtime image (node:22-bookworm) has
# no sqlite3 CLI, but node:sqlite (unflagged since Node 22.13) provides
# `VACUUM INTO`, which yields a consistent single-file snapshot from a
# read-only connection.
# Fix: `GET /setup/export?scope=state` on the same route (so requireSetupAuth
# is inherited and there is one export entry point) builds the state subset
# in a temp dir under os.tmpdir() -- copying included regular files, VACUUM
# INTO-snapshotting every *.sqlite, skipping -wal/-shm/*.bak*/symlinks, and
# refusing past a byte cap (200 MiB default; OPENCLAW_STATE_EXPORT_MAX_BYTES
# overrides) before any archive bytes stream -- then streams it as
# .openclaw/... relative to /data, the exact shape the wrapper's own
# POST /setup/import extracts. Any other non-empty scope is a 400; no scope
# is the unmodified full export (the delegate is a prefix of the handler, not
# a rewrite). The logic is scripts/wrapper-state-export.mjs, copied into
# src/ so the runtime stage's `COPY --from=template-source /template/src`
# carries it; scripts/patch-wrapper-scoped-export.mjs only injects the import
# line and the delegate, each with an exactly-one-occurrence anchor guard plus
# an already-applied guard. Build-time rather than upstream for the same
# reason as every patch above: it survives every OPENCLAW_TEMPLATE_REF bump,
# and the upstream request is filed separately (see
# docs/plans/wrapper-scoped-export-and-import-restart/upstream-issues.md).
# https://github.com/yuens1002/openclaw-control-plane/issues/73
COPY scripts/wrapper-state-export.mjs src/wrapper-state-export.mjs
COPY scripts/patch-wrapper-scoped-export.mjs ./patch-wrapper-scoped-export.mjs
RUN node patch-wrapper-scoped-export.mjs src/server.js
RUN grep -qF 'scope === "state"' src/server.js
RUN grep -qF 'import { buildStateExportTree } from "./wrapper-state-export.mjs";' src/server.js
RUN test "$(grep -cF 'scope === "state"' src/server.js)" -eq 1
RUN node --check src/server.js
RUN node --check src/wrapper-state-export.mjs

# Neither the wrapper's own routes nor upstream OpenClaw can verify a GitHub
# App webhook delivery. Upstream's generic `/hooks` gateway and bundled
# `webhooks` plugin both authenticate with a static shared secret compared
# against an `Authorization`/`x-openclaw-webhook-secret` header; a GitHub App
# delivery never sends the secret itself -- it HMAC-SHA256-signs the raw
# request body and sends the digest in `X-Hub-Signature-256`. Fix: one new
# wrapper-owned route, `POST /hooks/github-webhook-verify`, that verifies that
# signature and responds 200/401 accordingly -- no dispatch, no agent
# involvement, no gateway process involvement. It is registered *before* the
# wrapper's global `app.use(express.json({ limit: "1mb" }));` body parser --
# not merely before the later catch-all `app.use(requireDashboardAuth, ...)`
# that proxies everything else to the OpenClaw gateway, though it is also
# earlier than that. Anchoring on the catch-all alone was tried first and
# looked correct (Express dispatches in registration order, so the route
# still runs before the proxy) but was empirically dead in the built image:
# express.json() is registered even earlier and unconditionally drains the
# request stream via its own 'data'/'end' listeners, so a route registered
# after it never sees those events fire and readRawBody hangs to its own
# timeout on every real request. Anchoring before express.json() instead
# means this route reads the raw body itself before anything else can touch
# the stream, and it is still registered ahead of the catch-all proxy, so a
# request to it never reaches the gateway either way. `/hooks*` is already
# exempt from the wrapper's dashboard Basic Auth (see the sed patch above,
# "allow OpenClaw webhook endpoints to bypass dashboard auth") -- this route
# relies on that existing exemption rather than adding a new one.
#
# Build-time wrapper patch, not an upstream change or an OpenClaw plugin, for
# the same reason as every patch above: a plugin would mean publishing/
# installing an npm package and routing through the app/gateway process,
# unnecessary for this narrow a scope, and every future OPENCLAW_TEMPLATE_REF
# bump should inherit the fix automatically rather than needing to be redone.
#
# The route and its env var (`GITHUB_WEBHOOK_SECRET`) are deliberately named
# generically -- not tied to any one deployed instance -- because this patch
# lands in the *shared* wrapper image every provisioned instance builds from.
# Every instance gets the route; each opts in independently later, out of
# band from this repo, by setting its own `GITHUB_WEBHOOK_SECRET` and
# registering its own GitHub App webhook URL. When `GITHUB_WEBHOOK_SECRET` is
# unset (the default for an instance that hasn't opted in), the handler
# responds `404` before reading the body or comparing any signature -- it
# never falls back to accepting an unsigned request. The logic is
# scripts/wrapper-github-webhook-verify.mjs, copied into src/ so the runtime
# stage's `COPY --from=template-source /template/src` carries it;
# scripts/patch-wrapper-github-webhook.mjs only injects the import line and
# the route registration, each with an exactly-one-occurrence anchor guard
# plus an already-applied guard, same contract as
# scripts/patch-wrapper-scoped-export.mjs above.
# https://github.com/yuens1002/openclaw-control-plane/issues/108
COPY scripts/wrapper-github-webhook-verify.mjs src/wrapper-github-webhook-verify.mjs
COPY scripts/patch-wrapper-github-webhook.mjs ./patch-wrapper-github-webhook.mjs
RUN node patch-wrapper-github-webhook.mjs src/server.js
RUN grep -qF 'app.post("/hooks/github-webhook-verify"' src/server.js
RUN grep -qF 'import { handleGithubWebhookVerify } from "./wrapper-github-webhook-verify.mjs";' src/server.js
RUN test "$(grep -cF 'app.post("/hooks/github-webhook-verify"' src/server.js)" -eq 1
RUN node --check src/server.js
RUN node --check src/wrapper-github-webhook-verify.mjs

FROM node:22-bookworm AS openclaw-source

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    python3 \
    make \
    g++ \
    unzip \
  && rm -rf /var/lib/apt/lists/*

ARG BUN_VERSION=1.3.3
RUN curl -fsSL https://bun.com/install | bash -s "bun-v${BUN_VERSION}"
ENV PATH="/root/.bun/bin:${PATH}"
RUN test "$(bun --version)" = "${BUN_VERSION}" && bun --revision

RUN corepack enable

WORKDIR /openclaw

ARG OPENCLAW_GIT_REF=v2026.7.1-2
RUN git clone --depth 1 --branch "${OPENCLAW_GIT_REF}" https://github.com/openclaw/openclaw.git .

# Extracted to scripts/relax-openclaw-extension-versions.mjs (issue #104) so
# both this real build and the deliberate lockfile-regeneration path below
# run identical relaxation logic -- one source of truth, not two copies that
# can quietly drift apart.
COPY scripts/relax-openclaw-extension-versions.mjs /tmp/relax-openclaw-extension-versions.mjs
RUN node /tmp/relax-openclaw-extension-versions.mjs .

# Deliberate, NOT part of the real build below -- built only via
# `docker build --target openclaw-lockfile-refresh` (see
# scripts/generate-openclaw-lockfile.sh), run manually whenever
# OPENCLAW_GIT_REF bumps. This is the one deliberate point where dependency
# resolution touches the live npm registry; every ordinary build below uses
# the committed, frozen result instead. Before this split, EVERY build ran
# `pnpm install --no-frozen-lockfile` here, re-resolving this ~162-workspace
# monorepo's full dependency graph against the live registry every time --
# any transitive package tripping a registry-side supply-chain policy (e.g.
# pnpm's minimumReleaseAge) failed the build regardless of what changed in
# this repo. Confirmed: every deploy failed for 26+ hours across 7 unrelated
# commits before the blocking package aged past that policy on its own.
FROM openclaw-source AS openclaw-lockfile-refresh
RUN pnpm install --no-frozen-lockfile

FROM openclaw-source AS openclaw-build
COPY deploy/openclaw-railway/openclaw.pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
RUN pnpm build
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:install && pnpm ui:build

FROM node:22-bookworm
ENV NODE_ENV=production

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    python3 \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.23.0 --activate

ENV NPM_CONFIG_PREFIX=/data/npm
ENV NPM_CONFIG_CACHE=/data/npm-cache
ENV PNPM_HOME=/data/pnpm
ENV PNPM_STORE_DIR=/data/pnpm-store
ENV PATH="/data/npm/bin:/data/pnpm:${PATH}"

WORKDIR /app

COPY --from=template-source /template/package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=openclaw-build /openclaw /openclaw
RUN printf '%s\n' '#!/usr/bin/env bash' 'exec node /openclaw/dist/entry.js "$@"' > /usr/local/bin/openclaw \
  && chmod +x /usr/local/bin/openclaw

COPY --from=template-source /template/src ./src

# The wrapper listens on Railway's injected $PORT.
EXPOSE 8080

ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
