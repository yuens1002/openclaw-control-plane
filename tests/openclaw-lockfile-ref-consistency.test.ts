import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockfilesDir = join(repoRoot, "deploy", "openclaw-railway", "lockfiles");
const LOCKFILE_NAME = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.pnpm-lock\.yaml$/;

function readDockerfile(): string {
  return readFileSync(join(repoRoot, "Dockerfile"), "utf8");
}

function readDockerfileOpenclawGitRef(): string {
  const match = readDockerfile().match(/^ARG OPENCLAW_GIT_REF=(.+)$/m);
  if (!match) {
    throw new Error("Dockerfile has no 'ARG OPENCLAW_GIT_REF=...' line -- has it moved or changed shape?");
  }
  return match[1]!.trim();
}

describe("committed per-ref OpenClaw lockfiles", () => {
  it("include one for the Dockerfile's default OPENCLAW_GIT_REF", () => {
    // Asserts the cross-file RELATION, not a literal ref: bumping the default
    // without generating its lockfile (scripts/generate-openclaw-lockfile.sh)
    // fails here instead of at build time on every instance using the default.
    const ref = readDockerfileOpenclawGitRef();
    expect(existsSync(join(lockfilesDir, `${ref}.pnpm-lock.yaml`)), `missing lockfiles/${ref}.pnpm-lock.yaml`).toBe(true);
  });

  it("are all named <ref>.pnpm-lock.yaml with a filename-safe ref and look like pnpm lockfiles", () => {
    const files = readdirSync(lockfilesDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file, `unexpected file in lockfiles/: ${file}`).toMatch(LOCKFILE_NAME);
      // pnpm 12 (OpenClaw v2026.9.x) prefixes a YAML document marker; older pnpm does not.
      expect(readFileSync(join(lockfilesDir, file), "utf8"), file).toMatch(/^(?:---\r?\n)?lockfileVersion: /);
    }
  });

  it("are selected in the Dockerfile by the ref that was actually cloned", () => {
    const dockerfile = readDockerfile();
    const clone = dockerfile.indexOf('git clone --depth 1 --branch "${OPENCLAW_GIT_REF}"');
    const record = dockerfile.indexOf("printf '%s\\n' \"${OPENCLAW_GIT_REF}\" > /tmp/openclaw-git-ref");
    const select = dockerfile.indexOf('lockfile="/tmp/openclaw-lockfiles/${ref}.pnpm-lock.yaml"');
    const install = dockerfile.indexOf("RUN pnpm install --frozen-lockfile");
    expect(clone).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(clone);
    expect(select).toBeGreaterThan(record);
    expect(install).toBeGreaterThan(select);
    expect(dockerfile).toContain('ref="$(cat /tmp/openclaw-git-ref)"');
  });
});
