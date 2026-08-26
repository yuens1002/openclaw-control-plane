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
const EXPECTED_TOOLS = [
  "create_runtime_approval",
  "create_runtime_event",
  "create_runtime_work_item",
  "execute_runtime_command",
  "get_runtime_edges",
  "get_runtime_projection",
  "get_runtime_record",
  "list_runtime_audit",
  "list_runtime_registrations",
  "list_runtime_stream_records"
];

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
    const invocationIds: string[] = [];
    const tokenServer = await listen((request, response) => {
      tokenRequests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ access_token: "process-token", token_type: "Bearer", expires_in: 60 })
      );
    });
    const runtimeServer = await listen((request, response) => {
      runtimeAuthorization.push(request.headers.authorization ?? "");
      if (request.url?.endsWith("/commands")) {
        invocationIds.push(String(request.headers["x-tool-invocation-id"]));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            status: "inserted",
            terminal_status: "succeeded",
            operation_record_id: "00000000-0000-4000-8000-000000000012",
            result_record_ids: []
          })
        );
        return;
      }
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
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(
      EXPECTED_TOOLS
    );
    const result = await client.callTool({ name: "list_runtime_registrations", arguments: {} });

    expect(result.structuredContent).toEqual({ types: [], operations: [] });
    await client.callTool({ name: "execute_runtime_command", arguments: commandInput("one") });
    await client.callTool({ name: "execute_runtime_command", arguments: commandInput("two") });
    expect(tokenRequests).toEqual(["/token"]);
    expect(runtimeAuthorization).toEqual([
      "Bearer process-token",
      "Bearer process-token",
      "Bearer process-token"
    ]);
    expect(invocationIds).toHaveLength(2);
    expect(invocationIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(invocationIds[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(invocationIds[0]).not.toBe(invocationIds[1]);
    expect(diagnostics.join("")).toBe("");
    expect(transport.pid).not.toBeNull();
    await client.close();
    expect(transport.pid).toBeNull();
  });
});

function commandInput(suffix: string) {
  const workItemId = "00000000-0000-4000-8000-000000000010";
  return {
    stream_id: "stream-1",
    idempotency_key: `command-${suffix}`,
    operation_type: "example.state.reconcile",
    operation_schema_version: 1,
    work_item_id: workItemId,
    action_revision: 1,
    target: { type: "example.environment", id: "production" },
    arguments: { desired: { ready: true } },
    declared_effects: [],
    trigger: { type: "user_request", ref: { kind: "work_item", id: workItemId } },
    causation_ref: { kind: "work_item", id: workItemId },
    correlation_id: `correlation-${suffix}`,
    input_refs: []
  };
}

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
