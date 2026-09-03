import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readDockerfileOpenclawGitRef(): string {
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  const match = dockerfile.match(/^ARG OPENCLAW_GIT_REF=(.+)$/m);
  if (!match) {
    throw new Error("Dockerfile has no 'ARG OPENCLAW_GIT_REF=...' line -- has it moved or changed shape?");
  }
  return match[1]!.trim();
}

function readCommittedLockfileMetaRef(): string {
  const metaPath = join(repoRoot, "deploy", "openclaw-railway", "openclaw.pnpm-lock.meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { openclawGitRef?: string };
  if (!meta.openclawGitRef) {
    throw new Error(`${metaPath} has no "openclawGitRef" field`);
  }
  return meta.openclawGitRef;
}

describe("committed OpenClaw lockfile stays in sync with OPENCLAW_GIT_REF", () => {
  it("Dockerfile's pinned OPENCLAW_GIT_REF matches the committed lockfile's own recorded ref", () => {
    // This asserts the cross-file RELATION, not a hardcoded literal ref
    // string -- a future OPENCLAW_GIT_REF bump without regenerating the
    // committed lockfile (scripts/generate-openclaw-lockfile.sh) fails this
    // test, rather than silently shipping a build pinned against a stale,
    // mismatched lock.
    expect(readCommittedLockfileMetaRef()).toBe(readDockerfileOpenclawGitRef());
  });
});
