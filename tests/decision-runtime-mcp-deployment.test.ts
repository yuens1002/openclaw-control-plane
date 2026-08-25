import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFile(`${root}/${path}`, "utf8");

describe("Decision Runtime MCP deployment", () => {
  it("builds a dedicated compiled service with a health check", async () => {
    const [dockerfile, config] = await Promise.all([
      read("deploy/decision-runtime-mcp/Dockerfile"),
      read("deploy/decision-runtime-mcp/railway.toml")
    ]);

    expect(dockerfile).toContain('CMD ["node", "apps/mcp/dist/server.js"]');
    expect(dockerfile).toContain("ENV MCP_TRANSPORT=streamable-http");
    expect(dockerfile).not.toContain("src/server.js");
    expect(config).toContain(
      'dockerfilePath = "deploy/decision-runtime-mcp/Dockerfile"'
    );
    expect(config).toContain('healthcheckPath = "/health"');
    expect(config).toContain('restartPolicyType = "on_failure"');
  });

  it("copies only the MCP dependency boundary and no database assets", async () => {
    const dockerfile = await read("deploy/decision-runtime-mcp/Dockerfile");

    expect(dockerfile).toContain("apps/mcp");
    expect(dockerfile).toContain("packages/mcp-service");
    expect(dockerfile).toContain("packages/decision-runtime-mcp");
    expect(dockerfile).toContain("packages/openclaw-adapter");
    expect(dockerfile).toContain("packages/contracts");
    expect(dockerfile).not.toContain("packages/db");
    expect(dockerfile).not.toContain("migrations");
    expect(dockerfile).not.toContain("DATABASE_URL");
    expect(dockerfile).not.toContain("apps/api");
    expect(dockerfile).not.toContain("apps/worker");
  });

  it("leaves sibling deployment manifests unchanged in this feature diff", async () => {
    const [runtime, worker, openclaw] = await Promise.all([
      read("deploy/decision-runtime/railway.toml"),
      read("deploy/decision-runtime/worker.railway.toml"),
      read("railway.toml")
    ]);

    expect(runtime).toContain('dockerfilePath = "deploy/decision-runtime/Dockerfile"');
    expect(worker).toContain('dockerfilePath = "deploy/decision-runtime/worker.Dockerfile"');
    expect(openclaw).not.toContain("decision-runtime-mcp");
  });
});
