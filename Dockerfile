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
RUN sed -i \
  's#if (req.path.startsWith("/hooks")) return next(); // allow OpenClaw webhook endpoints to bypass dashboard auth#if (req.path.startsWith("/hooks")) return next(); // allow OpenClaw webhook endpoints to bypass dashboard auth\n  if (["/manifest.webmanifest", "/favicon.ico", "/favicon.svg", "/favicon-16.png", "/favicon-32.png", "/apple-touch-icon.png", "/sw.js"].includes(req.path)) return next(); // browsers never attach cached Basic-Auth credentials to these passive resource fetches#' \
  src/server.js
RUN grep -q 'browsers never attach cached Basic-Auth credentials' src/server.js

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
