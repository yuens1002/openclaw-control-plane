# Railway proof runtime for the public OpenClaw Control Plane starter kit.
#
# The Railway service source should point at this public repo's main branch.
# This Dockerfile then pulls the pinned OpenClaw Railway wrapper dependency and
# builds the actual OpenClaw dashboard/runtime that serves /setup and /openclaw.

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

FROM node:22-bookworm AS openclaw-build

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

RUN set -eux; \
  find ./extensions -name 'package.json' -type f | while read -r f; do \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*">=[^"]+"/"openclaw": "*"/g' "$f"; \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*"workspace:[^"]+"/"openclaw": "*"/g' "$f"; \
  done

RUN pnpm install --no-frozen-lockfile
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
