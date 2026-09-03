#!/usr/bin/env bash
# Regenerates the committed OpenClaw lockfile
# (deploy/openclaw-railway/openclaw.pnpm-lock.yaml) against the currently
# pinned OPENCLAW_GIT_REF, plus its ref-tracking meta.json.
#
# Run this whenever bumping OPENCLAW_GIT_REF in the Dockerfile, then commit
# both output files. This is the one deliberate point where dependency
# resolution for the OpenClaw monorepo touches the live npm registry -- the
# real build (Dockerfile's `openclaw-build` stage) never does, by design.
# See issue #104 and docs/plans/openclaw-build-determinism/plan.md.
#
# Requires a local Docker daemon.

set -euo pipefail
cd "$(dirname "$0")/.."

OPENCLAW_GIT_REF="$(sed -n 's/^ARG OPENCLAW_GIT_REF=\(.*\)$/\1/p' Dockerfile)"
if [ -z "$OPENCLAW_GIT_REF" ]; then
  echo "could not find 'ARG OPENCLAW_GIT_REF=...' in Dockerfile -- has it moved or changed shape?" >&2
  exit 1
fi

IMAGE_TAG="openclaw-control-plane-lockfile-refresh:tmp"
CONTAINER_NAME="openclaw-control-plane-lockfile-refresh-tmp"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rmi -f "$IMAGE_TAG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --target openclaw-lockfile-refresh -t "$IMAGE_TAG" .
docker create --name "$CONTAINER_NAME" "$IMAGE_TAG" >/dev/null

mkdir -p deploy/openclaw-railway
docker cp "$CONTAINER_NAME:/openclaw/pnpm-lock.yaml" deploy/openclaw-railway/openclaw.pnpm-lock.yaml

GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > deploy/openclaw-railway/openclaw.pnpm-lock.meta.json <<EOF
{
  "openclawGitRef": "$OPENCLAW_GIT_REF",
  "generatedAt": "$GENERATED_AT"
}
EOF

echo "regenerated deploy/openclaw-railway/openclaw.pnpm-lock.yaml for OPENCLAW_GIT_REF=$OPENCLAW_GIT_REF"
