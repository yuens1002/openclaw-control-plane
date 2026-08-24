import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFile(`${root}/${path}`, "utf8");

describe("decision runtime deployment", () => {
  it("uses a dedicated compiled API image and health check", async () => {
    const [dockerfile, config] = await Promise.all([
      read("deploy/decision-runtime/Dockerfile"),
      read("deploy/decision-runtime/railway.toml")
    ]);

    expect(dockerfile).toContain('CMD ["node", "apps/api/dist/server.js"]');
    expect(dockerfile).toContain("packages/db/migrations");
    expect(dockerfile).not.toContain("src/server.js");
    expect(config).toContain('dockerfilePath = "deploy/decision-runtime/Dockerfile"');
    expect(config).toContain('healthcheckPath = "/health"');
    expect(config).toContain('restartPolicyType = "on_failure"');
  });

  it("keeps local secrets and generated files out of the Docker context", async () => {
    const ignored = (await read(".dockerignore")).split(/\r?\n/);

    expect(ignored).toEqual(
      expect.arrayContaining([
        ".git",
        ".env",
        ".env.*",
        "*.local.md",
        "node_modules",
        "**/dist",
        "coverage"
      ])
    );
  });

  it("documents separate runtime and migration connections", async () => {
    const [server, docs] = await Promise.all([
      read("apps/api/src/server.ts"),
      read("docs/decision-runtime-deployment.md")
    ]);

    expect(server).toContain("process.env.DATABASE_URL_UNPOOLED");
    expect(docs).toContain("`DATABASE_URL` to the pooled connection");
    expect(docs).toContain("`DATABASE_URL_UNPOOLED` to the direct connection");
    expect(docs).toContain("Operational\nwrite routes remain fail-closed");
  });
});
