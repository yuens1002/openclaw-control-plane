import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
});

describe("Decision Runtime MCP stdio process", () => {
  it("serves discovery and calls through the real executable without stdout diagnostics", async () => {
    const tokenRequests: string[] = [];
    const runtimeAuthorization: string[] = [];
    const tokenServer = await listen((request, response) => {
      tokenRequests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ access_token: "process-token", token_type: "Bearer", expires_in: 60 })
      );
    });
    const runtimeServer = await listen((request, response) => {
      runtimeAuthorization.push(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ types: [], operations: [] }));
    });
    const tokenPort = addressPort(tokenServer);
    const runtimePort = addressPort(runtimeServer);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "apps/mcp/src/server.ts"],
      cwd: root,
      stderr: "pipe",
      env: {
        NODE_ENV: "development",
        MCP_TRANSPORT: "stdio",
        MCP_ALLOW_INSECURE_TRANSPORT: "true",
        RUNTIME_API_URL: `http://127.0.0.1:${runtimePort}`,
        OIDC_TOKEN_ENDPOINT: `http://127.0.0.1:${tokenPort}/token`,
        OIDC_CLIENT_ID: "example-client",
        OIDC_CLIENT_SECRET: "example-secret"
      }
    });
    const diagnostics: string[] = [];
    transport.stderr?.on("data", (chunk) => diagnostics.push(String(chunk)));
    const client = new Client({ name: "stdio-conformance", version: "1.0.0" });

    await client.connect(transport as unknown as Transport);
    expect((await client.listTools()).tools).toHaveLength(10);
    const result = await client.callTool({ name: "list_runtime_registrations", arguments: {} });

    expect(result.structuredContent).toEqual({ types: [], operations: [] });
    expect(tokenRequests).toEqual(["/token"]);
    expect(runtimeAuthorization).toEqual(["Bearer process-token"]);
    expect(diagnostics.join("")).toBe("");
    expect(transport.pid).not.toBeNull();
    await client.close();
    expect(transport.pid).toBeNull();
  });
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function addressPort(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server is not listening.");
  return address.port;
}
