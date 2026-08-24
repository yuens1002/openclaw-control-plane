import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFile(`${root}/${path}`, "utf8");

describe("decision runtime deployment", () => {
  it("uses a dedicated compiled API image and health check", async () => {
    const [dockerfile, config, docs] = await Promise.all([
      read("deploy/decision-runtime/Dockerfile"),
      read("deploy/decision-runtime/railway.toml"),
      read("docs/decision-runtime-deployment.md")
    ]);

    expect(dockerfile).toContain('CMD ["node", "apps/api/dist/server.js"]');
    expect(dockerfile).toContain("packages/db/migrations");
    expect(dockerfile).toContain("packages/runtime-auth/dist");
    expect(dockerfile).not.toContain("src/server.js");
    expect(config).toContain('dockerfilePath = "deploy/decision-runtime/Dockerfile"');
    expect(config).toContain('healthcheckPath = "/health"');
    expect(config).toContain('restartPolicyType = "on_failure"');
    expect(config).toContain("/deploy/decision-runtime/railway.toml");
    expect(docs).toContain("config-as-code file path to the absolute repository");
    expect(docs).toContain("`/deploy/decision-runtime/railway.toml`");
  });

  it("ships an independently deployable workflow-neutral worker", async () => {
    const [dockerfile, config, worker, docs] = await Promise.all([
      read("deploy/decision-runtime/worker.Dockerfile"),
      read("deploy/decision-runtime/worker.railway.toml"),
      read("apps/worker/src/index.ts"),
      read("docs/decision-runtime-deployment.md")
    ]);

    expect(dockerfile).toContain('CMD ["node", "apps/worker/dist/index.js"]');
    expect(config).toContain('healthcheckPath = "/health"');
    expect(worker).toContain("workflows: []");
    expect(worker).toContain("checkIdentityReadiness");
    expect(docs).toContain("Optional worker");
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
    expect(docs).toContain("`RUNTIME_AUTH_CONFIG_JSON`");
  });

  it("documents production authentication, smoke, backup, restore, and rollback", async () => {
    const [server, authDocs, deployDocs] = await Promise.all([
      read("apps/api/src/server.ts"),
      read("docs/runtime-authentication.md"),
      read("docs/decision-runtime-deployment.md")
    ]);

    expect(server).toContain("RUNTIME_AUTH_CONFIG_JSON");
    expect(server).toContain("Development Basic Authentication cannot be enabled in production");
    expect(authDocs).toContain("OIDC JWT bearer tokens in production");
    expect(authDocs).toContain("Key rotation");
    expect(deployDocs).toContain("Smoke verification");
    expect(deployDocs).toContain("pg_dump");
    expect(deployDocs).toContain("pg_restore");
    expect(deployDocs).toContain("data rollback");
  });
});
