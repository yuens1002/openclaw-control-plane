import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFile(`${root}/${path}`, "utf8");

describe("public MCP documentation", () => {
  it("documents the HTTP/MCP authority boundary and proxy non-goal", async () => {
    const [adr, guide, architecture] = await Promise.all([
      read("docs/adr/0004-agent-facing-mcp-service-boundary.md"),
      read("docs/mcp-service.md"),
      read("docs/architecture.md")
    ]);

    expect(adr).toContain("MCP as the agent-facing discovery and invocation boundary");
    expect(adr).toContain("Tool discovery is not authorization");
    expect(adr).toContain("general MCP proxy or gateway");
    expect(guide).toContain("The API remains the service boundary");
    expect(guide).toContain("proxy filtering, federation");
    expect(architecture).toContain("MCP supplies discovery");
  });

  it("provides generic OpenClaw, deployment, probe, and rollback operations", async () => {
    const guide = await read("docs/mcp-service.md");

    expect(guide).toContain('transport: "streamable-http"');
    expect(guide).toContain("toolFilter");
    expect(guide).toContain("openclaw mcp doctor decisionRuntime --probe");
    expect(guide).toContain("deploy/decision-runtime-mcp/railway.toml");
    expect(guide).toContain("To roll back");
    expect(guide).toContain("MCP_INBOUND_BEARER_TOKEN");
    expect(guide).toContain("MCP_DOWNSTREAM_AUTH_MODE");
    expect(guide).toContain("MCP_WORKLOAD_JWT_PRIVATE_KEY");
    expect(guide).toContain("credentials remain the default");
    expect(guide).toContain("publish the new public JWK beside the current key");
    expect(guide).not.toMatch(/railway\.app|neon\.tech|principal:\/\/[^<`\s]*\/(?:em|sunny)/i);
  });

  it("indexes the guide from public entry points", async () => {
    const [readme, docsReadme, tools] = await Promise.all([
      read("README.md"),
      read("docs/README.md"),
      read("docs/openclaw-tools.md")
    ]);

    expect(readme).toContain("docs/mcp-service.md");
    expect(docsReadme).toContain("mcp-service.md");
    expect(tools).toContain("mcp-service.md");
  });
});
