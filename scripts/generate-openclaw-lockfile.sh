#!/usr/bin/env bash
# Generates the committed OpenClaw lockfile for one OpenClaw ref:
# deploy/openclaw-railway/lockfiles/<ref>.pnpm-lock.yaml.
#
# Usage: scripts/generate-openclaw-lockfile.sh [<openclaw-git-ref>]
# The ref defaults to the Dockerfile's `ARG OPENCLAW_GIT_REF=` value.
#
# Run it for every ref an instance may pin (the default and any per-client
# OPENCLAW_GIT_REF override), then commit the output. The real build selects
# the file matching the ref it cloned and fails if none exists. Delete a ref's
# file once no instance pins it. This is the one deliberate point where
# dependency resolution for the OpenClaw monorepo touches the live npm
# registry -- the real build (Dockerfile's `openclaw-build` stage) never does,
# by design. See issue #104 and docs/plans/openclaw-build-determinism/plan.md.
#
# Requires a local Docker daemon.

set -euo pipefail
cd "$(dirname "$0")/.."

DEFAULT_REF="$(sed -n 's/^ARG OPENCLAW_GIT_REF=\(.*\)$/\1/p' Dockerfile)"
if [ -z "$DEFAULT_REF" ]; then
  echo "could not find 'ARG OPENCLAW_GIT_REF=...' in Dockerfile -- has it moved or changed shape?" >&2
  exit 1
fi
OPENCLAW_GIT_REF="${1:-$DEFAULT_REF}"
# The ref becomes a filename; accept only tag/branch-safe characters.
if ! [[ "$OPENCLAW_GIT_REF" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "refusing unsafe OpenClaw ref '$OPENCLAW_GIT_REF' (allowed: letters, digits, '.', '_', '-')" >&2
  exit 1
fi

IMAGE_TAG="openclaw-control-plane-lockfile-refresh:tmp"
CONTAINER_NAME="openclaw-control-plane-lockfile-refresh-tmp"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rmi -f "$IMAGE_TAG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --target openclaw-lockfile-refresh --build-arg "OPENCLAW_GIT_REF=$OPENCLAW_GIT_REF" -t "$IMAGE_TAG" .
docker create --name "$CONTAINER_NAME" "$IMAGE_TAG" >/dev/null

OUTPUT="deploy/openclaw-railway/lockfiles/$OPENCLAW_GIT_REF.pnpm-lock.yaml"
mkdir -p deploy/openclaw-railway/lockfiles
docker cp "$CONTAINER_NAME:/openclaw/pnpm-lock.yaml" "$OUTPUT"

echo "generated $OUTPUT for OPENCLAW_GIT_REF=$OPENCLAW_GIT_REF"
