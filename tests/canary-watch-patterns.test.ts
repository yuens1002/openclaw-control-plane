import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFile(`${root}/${path}`, "utf8");

/**
 * Extracts the quoted string entries of a `watchPatterns = [...]` array from
 * raw railway.toml text. Scoped to exactly the array syntax this feature
 * produces -- not a general TOML parser. Strips `#`-to-end-of-line comments
 * first and anchors the key to a line start, so a commented-out array (or a
 * commented-out individual entry inside an otherwise-live array) is not
 * silently harvested as if it were live -- either shape would previously
 * pass every assertion below while describing a config that actually
 * watches nothing (or is missing one real entry), the exact failure mode
 * this drift guard exists to catch.
 */
function parseWatchPatterns(tomlText: string): string[] {
  const uncommented = tomlText
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
  const arrayMatch = uncommented.match(/^\s*watchPatterns\s*=\s*\[([\s\S]*?)\]/m);
  if (!arrayMatch) return [];
  const entries = [...(arrayMatch[1] ?? "").matchAll(/"([^"]+)"/g)];
  return entries.map((entry) => entry[1] ?? "");
}

/**
 * Reads the `dockerfilePath` value out of raw railway.toml text, defaulting
 * to "Dockerfile" if absent -- so this test always derives against whatever
 * Dockerfile the reference spec actually names, rather than a path
 * hardcoded independently of it.
 */
function parseDockerfilePath(tomlText: string): string {
  const match = tomlText.match(/^\s*dockerfilePath\s*=\s*"([^"]+)"/m);
  return match?.[1] ?? "Dockerfile";
}

/**
 * Mechanically derives the expected watch-pattern set from every `COPY`/`ADD`
 * line whose source isn't `--from=` (which copies build output from another
 * build stage, with no corresponding source path in the repository).
 * Case-insensitive and joins backslash-continued lines first, since Docker
 * instructions are case-insensitive and commonly span multiple physical
 * lines -- neither form appears in the current Dockerfile, but a future one
 * that used either would otherwise derive an incomplete set with no error.
 * A source is a `dir/**` pattern if the real repo path it names is a
 * directory, or an exact-path pattern if it's a file -- resolved against the
 * actual filesystem (`fs.stat`) rather than guessed from whether the
 * basename contains a dot, since an extensionless file (`COPY LICENSE ./`)
 * or a dotted directory name would otherwise be misclassified into a
 * pattern shape that doesn't actually match the real path under Railway's
 * gitignore-style semantics. A COPY source that doesn't exist in the repo
 * fails loudly (the `stat` rejection propagates) instead of being silently
 * misclassified.
 */
async function deriveExpectedPatterns(
  dockerfileText: string,
  extras: string[],
  repoRoot: string
): Promise<Set<string>> {
  const patterns = new Set<string>(extras);
  const joined = dockerfileText.replace(/\\\r?\n/g, " ");
  for (const line of joined.split(/\r?\n/)) {
    const instructionMatch = line.match(/^\s*(?:COPY|ADD)\s+(.+)$/i);
    const copySources = instructionMatch?.[1];
    if (!copySources || copySources.includes("--from=")) continue;
    const tokens = copySources
      .trim()
      .split(/\s+/)
      .filter((token) => !token.startsWith("--"));
    if (tokens.length < 2) continue;
    for (const source of tokens.slice(0, -1)) {
      const isDirectory = (await stat(`${repoRoot}/${source}`)).isDirectory();
      patterns.add(isDirectory ? `/${source}/**` : `/${source}`);
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
  let expectedFromDockerfile: Set<string>;

  beforeAll(async () => {
    canaryConfig = await read("deploy/openclaw-railway/canary.railway.toml");
    dockerfile = await read(parseDockerfilePath(canaryConfig));
    canaryPatterns = parseWatchPatterns(canaryConfig);
    expectedFromDockerfile = await deriveExpectedPatterns(dockerfile, [], root);
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
    for (const pattern of expectedFromDockerfile) {
      expect(matchesAnyPattern(pattern, canaryPatterns)).toBe(true);
    }
  });

  it("matches the Dockerfile itself and .dockerignore", () => {
    expect(matchesAnyPattern("Dockerfile", canaryPatterns)).toBe(true);
    expect(matchesAnyPattern(".dockerignore", canaryPatterns)).toBe(true);
  });

  // This reference file has zero effect on the built image (it isn't a COPY
  // source, and Railway doesn't read it -- see its own header comment), so a
  // change to it alone must not trigger a rebuild.
  it("does not match its own reference file", () => {
    expect(matchesAnyPattern("deploy/openclaw-railway/canary.railway.toml", canaryPatterns)).toBe(false);
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

  it("keeps the canary watch patterns exactly in sync with the Dockerfile's build input", async () => {
    const expected = await deriveExpectedPatterns(dockerfile, ["/Dockerfile", "/.dockerignore"], root);
    expect(new Set(canaryPatterns)).toEqual(expected);
  });

  it("detects drift when the Dockerfile gains a COPY source absent from watch patterns", async () => {
    const dockerfileWithNewInput = [
      "FROM node:22-bookworm AS template-source",
      "COPY scripts/patch-wrapper-restart-gateway.mjs ./patch-wrapper-restart-gateway.mjs",
      "COPY scripts/relax-openclaw-extension-versions.mjs ./new-patch-step.mjs",
      "FROM node:22-bookworm",
      "COPY --from=template-source /template/src ./src"
    ].join("\n");
    const staleWatchPatterns = new Set(["/scripts/patch-wrapper-restart-gateway.mjs"]);

    const expected = await deriveExpectedPatterns(dockerfileWithNewInput, [], root);
    const missing = [...expected].filter((pattern) => !staleWatchPatterns.has(pattern));

    expect(missing).toEqual(["/scripts/relax-openclaw-extension-versions.mjs"]);
  });

  it("ignores build-stage COPY flags like --chown when deriving sources", async () => {
    const dockerfileWithChown = [
      "FROM node:22-bookworm AS build",
      "COPY --chown=node:node scripts/patch-wrapper-restart-gateway.mjs ./patch-wrapper-restart-gateway.mjs"
    ].join("\n");

    const expected = await deriveExpectedPatterns(dockerfileWithChown, [], root);

    expect(expected).toEqual(new Set(["/scripts/patch-wrapper-restart-gateway.mjs"]));
  });

  it("recognizes a lowercase copy instruction and joins backslash-continued lines", async () => {
    const dockerfileWithLowercaseAndContinuation = [
      "FROM node:22-bookworm AS build",
      "copy \\",
      "  scripts/patch-wrapper-restart-gateway.mjs \\",
      "  ./patch-wrapper-restart-gateway.mjs"
    ].join("\n");

    const expected = await deriveExpectedPatterns(dockerfileWithLowercaseAndContinuation, [], root);

    expect(expected).toEqual(new Set(["/scripts/patch-wrapper-restart-gateway.mjs"]));
  });

  it("does not silently harvest a commented-out watchPatterns array or a commented-out entry", () => {
    const wholeArrayCommented = [
      "[build]",
      "# watchPatterns = [",
      '#   "/scripts/patch-wrapper-restart-gateway.mjs"',
      "# ]"
    ].join("\n");
    expect(parseWatchPatterns(wholeArrayCommented)).toEqual([]);

    const oneEntryCommented = [
      "[build]",
      "watchPatterns = [",
      '  "/Dockerfile",',
      '  # "/scripts/patch-wrapper-restart-gateway.mjs",',
      '  "/.dockerignore"',
      "]"
    ].join("\n");
    expect(parseWatchPatterns(oneEntryCommented)).toEqual(["/Dockerfile", "/.dockerignore"]);
  });
});
