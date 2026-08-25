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
 * Mechanically derives the expected watch-pattern set from a Dockerfile's
 * build-stage COPY sources: a copied directory becomes `dir/**`, a copied
 * file becomes its exact path. `COPY --from=` lines (runtime-stage copies of
 * compiled output) are excluded — they have no corresponding source path in
 * the repository. No consolidation: a directory's `dir/**` pattern and the
 * exact-path pattern for a file separately copied from inside it both
 * appear, matching the 1:1 mapping this feature's real watchPatterns arrays
 * use.
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

describe("decision runtime watch patterns", () => {
  let apiConfig: string;
  let workerConfig: string;
  let apiDockerfile: string;
  let workerDockerfile: string;
  let apiPatterns: string[];
  let workerPatterns: string[];

  beforeAll(async () => {
    [apiConfig, workerConfig, apiDockerfile, workerDockerfile] = await Promise.all([
      read("deploy/decision-runtime/railway.toml"),
      read("deploy/decision-runtime/worker.railway.toml"),
      read("deploy/decision-runtime/Dockerfile"),
      read("deploy/decision-runtime/worker.Dockerfile")
    ]);
    apiPatterns = parseWatchPatterns(apiConfig);
    workerPatterns = parseWatchPatterns(workerConfig);
  });

  it("declares watch patterns for both services", () => {
    expect(apiPatterns.length).toBeGreaterThan(0);
    expect(workerPatterns.length).toBeGreaterThan(0);
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
    const paths = ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.base.json", ".dockerignore"];
    for (const path of paths) {
      expect(matchesAnyPattern(path, apiPatterns)).toBe(true);
      expect(matchesAnyPattern(path, workerPatterns)).toBe(true);
    }
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
    ]);
    expect(new Set(apiPatterns)).toEqual(expected);
  });

  it("keeps the worker watch patterns exactly in sync with the worker Dockerfile's build input", () => {
    const expected = deriveExpectedPatterns(workerDockerfile, [
      "/deploy/decision-runtime/worker.Dockerfile",
      "/deploy/decision-runtime/worker.railway.toml",
      "/.dockerignore"
    ]);
    expect(new Set(workerPatterns)).toEqual(expected);
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
