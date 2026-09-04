import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFile(`${root}/${path}`, "utf8");

/**
 * Extracts the quoted string entries of a `watchPatterns = [...]` array from
 * raw railway.toml text. Scoped to exactly the array syntax this feature
 * produces -- not a general TOML parser.
 */
function parseWatchPatterns(tomlText: string): string[] {
  const arrayMatch = tomlText.match(/watchPatterns\s*=\s*\[([\s\S]*?)\]/);
  if (!arrayMatch) return [];
  const entries = [...(arrayMatch[1] ?? "").matchAll(/"([^"]+)"/g)];
  return entries.map((entry) => entry[1] ?? "");
}

/**
 * Mechanically derives the expected watch-pattern set from every `COPY` line
 * whose source isn't `--from=` (which copies build output from another build
 * stage, with no corresponding source path in the repository): a source is a
 * `dir/**` pattern if its basename has no extension, or an exact-path pattern
 * otherwise.
 */
function deriveExpectedPatterns(dockerfileText: string, extras: string[]): Set<string> {
  const patterns = new Set<string>(extras);
  for (const line of dockerfileText.split(/\r?\n/)) {
    const copyMatch = line.match(/^COPY\s+(.+)$/);
    const copySources = copyMatch?.[1];
    if (!copySources || copySources.includes("--from=")) continue;
    const tokens = copySources
      .trim()
      .split(/\s+/)
      .filter((token) => !token.startsWith("--"));
    if (tokens.length < 2) continue;
    for (const source of tokens.slice(0, -1)) {
      const basename = source.split("/").pop() ?? source;
      const isFile = /\.[^./]+$/.test(basename);
      patterns.add(isFile ? `/${source}` : `/${source}/**`);
    }
  }
  return patterns;
}

/**
 * Evaluates whether a changed path is covered by a watch-pattern list, using
 * only the two shapes this feature's patterns emit: an exact path, or an
 * anchored `dir/**` prefix. Not general gitignore semantics.
 */
function matchesAnyPattern(path: string, patterns: string[]): boolean {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      return normalized.startsWith(pattern.slice(0, -2));
    }
    return normalized === pattern;
  });
}

describe("canary watch patterns", () => {
  let canaryConfig: string;
  let dockerfile: string;
  let canaryPatterns: string[];

  beforeAll(async () => {
    [canaryConfig, dockerfile] = await Promise.all([
      read("deploy/openclaw-railway/canary.railway.toml"),
      read("Dockerfile")
    ]);
    canaryPatterns = parseWatchPatterns(canaryConfig);
  });

  // An absent/empty watchPatterns list is not "watch nothing" -- Railway's
  // actual default is "watch everything" (every commit deploys), which is
  // exactly the CLI/pinned behavior this feature moves away from. A config
  // that declared no patterns at all would silently be even less scoped than
  // today's manual deploys, not more.
  it("declares a non-empty watch pattern list", () => {
    expect(canaryPatterns.length).toBeGreaterThan(0);
  });

  it("matches every wrapper build source the Dockerfile copies from this repo", () => {
    const paths = [
      "scripts/patch-wrapper-restart-gateway.mjs",
      "scripts/wrapper-state-export.mjs",
      "scripts/patch-wrapper-scoped-export.mjs",
      "scripts/relax-openclaw-extension-versions.mjs",
      "deploy/openclaw-railway/openclaw.pnpm-lock.yaml",
      "Dockerfile",
      "deploy/openclaw-railway/canary.railway.toml"
    ];
    for (const path of paths) {
      expect(matchesAnyPattern(path, canaryPatterns)).toBe(true);
    }
  });

  it("matches .dockerignore", () => {
    expect(matchesAnyPattern(".dockerignore", canaryPatterns)).toBe(true);
  });

  it("does not match the public-proof service's own config, docs, or unrelated repo content", () => {
    const paths = [
      "railway.toml",
      "docs/architecture.md",
      "README.md",
      "CHANGELOG.md",
      "package.json",
      "package-lock.json",
      "deploy/openclaw-railway/openclaw.pnpm-lock.meta.json",
      "scripts/generate-openclaw-lockfile.sh",
      "scripts/write-precheck-stamp.mjs",
      "scripts/check-acs-coverage.mjs",
      "tests/canary-watch-patterns.test.ts",
      ".github/workflows/ci.yml"
    ];
    for (const path of paths) {
      expect(matchesAnyPattern(path, canaryPatterns)).toBe(false);
    }
  });

  // The pinned-client CLI path (deploy/openclaw-railway/*.ps1) is a
  // deliberately separate deploy model from the canary -- a change to it
  // must not redeploy the canary, and vice versa is already covered by the
  // fact that these files are never referenced by the Dockerfile at all.
  it("does not match the pinned-client provisioning scripts", () => {
    const paths = [
      "deploy/openclaw-railway/provision-client.ps1",
      "deploy/openclaw-railway/update-client-openclaw-ref.ps1",
      "deploy/openclaw-railway/update-client-template-ref.ps1",
      "deploy/openclaw-railway/install-template.ps1"
    ];
    for (const path of paths) {
      expect(matchesAnyPattern(path, canaryPatterns)).toBe(false);
    }
  });

  it("keeps the canary watch patterns exactly in sync with the Dockerfile's build input", () => {
    const expected = deriveExpectedPatterns(dockerfile, [
      "/Dockerfile",
      "/deploy/openclaw-railway/canary.railway.toml",
      "/.dockerignore"
    ]);
    expect(new Set(canaryPatterns)).toEqual(expected);
  });

  it("detects drift when the Dockerfile gains a COPY source absent from watch patterns", () => {
    const dockerfileWithNewInput = [
      "FROM node:22-bookworm AS template-source",
      "COPY scripts/patch-wrapper-restart-gateway.mjs ./patch-wrapper-restart-gateway.mjs",
      "COPY scripts/new-patch-step.mjs ./new-patch-step.mjs",
      "FROM node:22-bookworm",
      "COPY --from=template-source /template/src ./src"
    ].join("\n");
    const staleWatchPatterns = new Set(["/scripts/patch-wrapper-restart-gateway.mjs"]);

    const expected = deriveExpectedPatterns(dockerfileWithNewInput, []);
    const missing = [...expected].filter((pattern) => !staleWatchPatterns.has(pattern));

    expect(missing).toEqual(["/scripts/new-patch-step.mjs"]);
  });

  it("excludes runtime-stage COPY --from lines from derivation", () => {
    const expected = deriveExpectedPatterns(dockerfile, []);
    for (const pattern of expected) {
      expect(pattern).not.toContain("/openclaw/");
      expect(pattern).not.toContain("/src");
    }
  });

  it("ignores build-stage COPY flags like --chown when deriving sources", () => {
    const dockerfileWithChown = [
      "FROM node:22-bookworm AS build",
      "COPY --chown=node:node scripts/patch-wrapper-restart-gateway.mjs ./patch-wrapper-restart-gateway.mjs"
    ].join("\n");

    const expected = deriveExpectedPatterns(dockerfileWithChown, []);

    expect(expected).toEqual(new Set(["/scripts/patch-wrapper-restart-gateway.mjs"]));
  });

  // Guards this feature's own committed file against naming the live Railway
  // service/project it targets -- this repo's Public-Repo Rule
  // (docs/README.md) bans deployment-specific service names in committed
  // docs, and this config-as-code file is committed to a public repo.
  it("does not name the live canary service or project in the committed config", () => {
    expect(canaryConfig.toLowerCase()).not.toContain("yuen");
    expect(canaryConfig.toLowerCase()).not.toContain("agency-ops");
  });
});
