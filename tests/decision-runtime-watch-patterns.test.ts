import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFile(`${root}/${path}`, "utf8");

/**
 * Extracts the quoted string entries of a `watchPatterns = [...]` array from
 * raw railway.toml text. Scoped to exactly the array syntax this feature
 * produces — not a general TOML parser.
 */
function parseWatchPatterns(tomlText: string): string[] {
  const arrayMatch = tomlText.match(/watchPatterns\s*=\s*\[([\s\S]*?)\]/);
  if (!arrayMatch) return [];
  const entries = [...(arrayMatch[1] ?? "").matchAll(/"([^"]+)"/g)];
  return entries.map((entry) => entry[1] ?? "");
}

/**
 * Mechanically derives the expected watch-pattern set from every `COPY` line
 * whose source isn't `--from=` (which copies compiled output from another
 * build stage, with no corresponding source path in the repository): a
 * source is a `dir/**` pattern if its basename has no extension, or an
 * exact-path pattern otherwise. No consolidation: a directory's `dir/**`
 * pattern and the exact-path pattern for a file separately copied from
 * inside it both appear, matching the 1:1 mapping this feature's real
 * watchPatterns arrays use.
 */
// `exclude` carries deliberate, documented departures from the otherwise 1:1
// COPY-source -> watchPattern mapping. Issue #86: the repo-root /package.json is
// copied by both Dockerfiles but is intentionally NOT watched, because its
// version field moves on every release and would redeploy both live services
// for a change neither image reads.
function deriveExpectedPatterns(
  dockerfileText: string,
  extras: string[],
  exclude: string[] = []
): Set<string> {
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
  for (const excluded of exclude) patterns.delete(excluded);
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

describe("decision runtime watch patterns", () => {
  let apiConfig: string;
  let workerConfig: string;
  let apiDockerfile: string;
  let workerDockerfile: string;
  let mcpConfig: string;
  let mcpDockerfile: string;
  let apiPatterns: string[];
  let workerPatterns: string[];
  let mcpPatterns: string[];

  beforeAll(async () => {
    [apiConfig, workerConfig, apiDockerfile, workerDockerfile, mcpConfig, mcpDockerfile] =
      await Promise.all([
        read("deploy/decision-runtime/railway.toml"),
        read("deploy/decision-runtime/worker.railway.toml"),
        read("deploy/decision-runtime/Dockerfile"),
        read("deploy/decision-runtime/worker.Dockerfile"),
        read("deploy/decision-runtime-mcp/railway.toml"),
        read("deploy/decision-runtime-mcp/Dockerfile")
      ]);
    apiPatterns = parseWatchPatterns(apiConfig);
    workerPatterns = parseWatchPatterns(workerConfig);
    mcpPatterns = parseWatchPatterns(mcpConfig);
  });

  // Issue #89: the MCP config declared no watchPatterns at all, so every commit to
  // the tracked branch redeployed it -- docs, installer work, changelog entries
  // included. An empty list is indistinguishable from "watch everything", so this
  // asserts a non-empty list rather than merely a parseable one.
  it("declares watch patterns for all three services", () => {
    expect(apiPatterns.length).toBeGreaterThan(0);
    expect(workerPatterns.length).toBeGreaterThan(0);
    expect(mcpPatterns.length).toBeGreaterThan(0);
  });

  it("matches an API app change to the API service only", () => {
    const path = "apps/api/src/server.ts";
    expect(matchesAnyPattern(path, apiPatterns)).toBe(true);
    expect(matchesAnyPattern(path, workerPatterns)).toBe(false);
  });

  it("matches a worker app change to the worker service only", () => {
    const path = "apps/worker/src/index.ts";
    expect(matchesAnyPattern(path, workerPatterns)).toBe(true);
    expect(matchesAnyPattern(path, apiPatterns)).toBe(false);
  });

  it("matches a shared package change to both services", () => {
    const paths = [
      "packages/contracts/src/index.ts",
      "packages/runtime-auth/src/index.ts",
      "packages/db/migrations/0001_init.sql"
    ];
    for (const path of paths) {
      expect(matchesAnyPattern(path, apiPatterns)).toBe(true);
      expect(matchesAnyPattern(path, workerPatterns)).toBe(true);
    }
  });

  it("matches a dependency or shared config change to both services", () => {
    const paths = ["package-lock.json", "tsconfig.json", "tsconfig.base.json", ".dockerignore"];
    for (const path of paths) {
      expect(matchesAnyPattern(path, apiPatterns)).toBe(true);
      expect(matchesAnyPattern(path, workerPatterns)).toBe(true);
    }
  });

  // Issue #86. A release bumps only the root manifest's version field, which no
  // decision-runtime image reads; watching it redeployed both live services once
  // per release. Real dependency and workspace changes still rewrite
  // package-lock.json, which stays watched above.
  it("matches neither service for a repo-root package.json change", () => {
    expect(matchesAnyPattern("package.json", apiPatterns)).toBe(false);
    expect(matchesAnyPattern("package.json", workerPatterns)).toBe(false);
  });

  // Guards the premise of the exclusion above. Both Dockerfiles run `npm ci`,
  // which executes root install-lifecycle scripts if any are declared. While none
  // exist, a root-manifest edit cannot change the built image without also
  // rewriting package-lock.json. Adding one would break that: the image would
  // change with no watched path changing, silently skipping both deploys.
  it("declares no root install-lifecycle scripts, so an unwatched package.json cannot alter the image", async () => {
    const manifest = JSON.parse(await read("package.json")) as { scripts?: Record<string, string> };
    const lifecycle = ["preinstall", "install", "postinstall", "prepare", "prepublish", "preprepare", "postprepare"];
    const declared = lifecycle.filter((name) => manifest.scripts?.[name] !== undefined);
    expect(declared).toEqual([]);
  });

  it("matches a deployment-target change to its own service only", () => {
    expect(matchesAnyPattern("deploy/decision-runtime/railway.toml", apiPatterns)).toBe(true);
    expect(matchesAnyPattern("deploy/decision-runtime/railway.toml", workerPatterns)).toBe(false);
    expect(matchesAnyPattern("deploy/decision-runtime/worker.railway.toml", workerPatterns)).toBe(true);
    expect(matchesAnyPattern("deploy/decision-runtime/worker.railway.toml", apiPatterns)).toBe(false);
  });

  it("matches neither service for unrelated, docs-only, or OpenClaw-wrapper-only changes", () => {
    const paths = [
      "docs/decision-runtime-deployment.md",
      "README.md",
      "packages/openclaw-railway-installer/src/cli.ts",
      "packages/openclaw-setup-applier/src/index.ts",
      "railway.toml",
      "Dockerfile",
      "workers/vending/src/index.ts"
    ];
    for (const path of paths) {
      expect(matchesAnyPattern(path, apiPatterns)).toBe(false);
      expect(matchesAnyPattern(path, workerPatterns)).toBe(false);
    }
  });

  it("keeps the API watch patterns exactly in sync with the API Dockerfile's build input", () => {
    const expected = deriveExpectedPatterns(apiDockerfile, [
      "/deploy/decision-runtime/Dockerfile",
      "/deploy/decision-runtime/railway.toml",
      "/.dockerignore"
    ], ["/package.json"]);
    expect(new Set(apiPatterns)).toEqual(expected);
  });

  it("keeps the worker watch patterns exactly in sync with the worker Dockerfile's build input", () => {
    const expected = deriveExpectedPatterns(workerDockerfile, [
      "/deploy/decision-runtime/worker.Dockerfile",
      "/deploy/decision-runtime/worker.railway.toml",
      "/.dockerignore"
    ], ["/package.json"]);
    expect(new Set(workerPatterns)).toEqual(expected);
  });

  it("keeps the MCP watch patterns exactly in sync with the MCP Dockerfile's build input", () => {
    const expected = deriveExpectedPatterns(mcpDockerfile, [
      "/deploy/decision-runtime-mcp/Dockerfile",
      "/deploy/decision-runtime-mcp/railway.toml",
      "/.dockerignore"
    ], ["/package.json"]);
    expect(new Set(mcpPatterns)).toEqual(expected);
  });

  it("matches an MCP app or MCP-only package change to the MCP service only", () => {
    const paths = [
      "apps/mcp/src/server.ts",
      "packages/mcp-service/src/index.ts",
      "packages/decision-runtime-mcp/src/token-provider.ts",
      "packages/openclaw-adapter/src/index.ts"
    ];
    for (const path of paths) {
      expect(matchesAnyPattern(path, mcpPatterns)).toBe(true);
      expect(matchesAnyPattern(path, apiPatterns)).toBe(false);
      expect(matchesAnyPattern(path, workerPatterns)).toBe(false);
    }
  });

  // The MCP image deliberately excludes the database boundary (see
  // tests/decision-runtime-mcp-deployment.test.ts), so a db or api change must not
  // reach it -- and docs/installer churn must not reach any of the three.
  it("does not match the MCP service for db, api, worker, docs, or installer changes", () => {
    const paths = [
      "packages/db/src/schema.ts",
      "apps/api/src/index.ts",
      "apps/worker/src/index.ts",
      "docs/architecture.md",
      "CHANGELOG.md",
      "packages/openclaw-railway-installer/src/cli.ts"
    ];
    for (const path of paths) {
      expect(matchesAnyPattern(path, mcpPatterns)).toBe(false);
    }
  });

  it("detects drift when a Dockerfile gains a COPY source absent from watch patterns", () => {
    const dockerfileWithNewInput = [
      "FROM node:22-bookworm-slim AS build",
      "WORKDIR /app",
      "COPY package.json ./",
      "COPY apps/api apps/api",
      "COPY apps/api/extra-config.json apps/api/extra-config.json",
      "RUN npm ci",
      "FROM node:22-bookworm-slim AS runtime",
      "COPY --from=build /app/apps/api/dist ./apps/api/dist"
    ].join("\n");
    const staleWatchPatterns = new Set(["/package.json", "/apps/api/**"]);

    const expected = deriveExpectedPatterns(dockerfileWithNewInput, []);
    const missing = [...expected].filter((pattern) => !staleWatchPatterns.has(pattern));

    expect(missing).toEqual(["/apps/api/extra-config.json"]);
  });

  it("excludes runtime-stage COPY --from lines from derivation", () => {
    const expected = deriveExpectedPatterns(apiDockerfile, []);
    for (const pattern of expected) {
      expect(pattern).not.toContain("/app/");
      expect(pattern).not.toContain("dist");
    }
  });

  it("ignores build-stage COPY flags like --chown when deriving sources", () => {
    const dockerfileWithChown = [
      "FROM node:22-bookworm-slim AS build",
      "WORKDIR /app",
      "COPY --chown=node:node package.json ./",
      "COPY --chown=node:node apps/api apps/api",
      "RUN npm ci"
    ].join("\n");

    const expected = deriveExpectedPatterns(dockerfileWithChown, []);

    expect(expected).toEqual(new Set(["/package.json", "/apps/api/**"]));
  });
});
