import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createMcpServiceHost,
  McpServiceError,
  type McpServiceModule,
  type McpToolCallContext
} from "@openclaw-control-plane/mcp-service";

describe("reusable MCP service host", () => {
  it("registers modules deterministically and rejects duplicate public names", async () => {
    const first = fixtureModule("first", "zeta");
    const second = fixtureModule("second", "alpha");
    const host = createMcpServiceHost({
      name: "test-host",
      version: "1.0.0",
      modules: [first, second]
    });
    const { client, close } = await connectInMemory(host.buildServer("stdio"));

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["alpha", "zeta"]);
    await close();

    expect(() =>
      createMcpServiceHost({
        name: "test-host",
        version: "1.0.0",
        modules: [fixtureModule("one", "same"), fixtureModule("two", "same")]
      })
    ).toThrow("Duplicate MCP tool name: same");
    expect(() =>
      createMcpServiceHost({
        name: "test-host",
        version: "1.0.0",
        modules: [fixtureModule("same-module", "one"), fixtureModule("same-module", "two")]
      })
    ).toThrow("Duplicate MCP module ID: same-module");
    expect(() =>
      createMcpServiceHost({
        name: "test-host",
        version: "1.0.0",
        modules: [fixtureModule("blank-tool", "   ")]
      })
    ).toThrow("MCP tool name is required.");
  });

  it("provides server-owned context and compatible structured/text results", async () => {
    let observed: McpToolCallContext | undefined;
    const module = fixtureModule("example", "echo", (context) => {
      observed = context;
    });
    const host = createMcpServiceHost({
      name: "test-host",
      version: "1.0.0",
      modules: [module],
      createInvocationId: () => "00000000-0000-4000-8000-000000000099",
      now: () => new Date("2026-08-25T12:00:00.000Z")
    });
    const { client, close } = await connectInMemory(host.buildServer("stdio"));

    const result = await client.callTool({ name: "echo", arguments: { value: "hello" } });

    expect(result.structuredContent).toEqual({ value: "hello" });
    expect(result.content).toEqual([{ type: "text", text: '{"value":"hello"}' }]);
    expect(observed).toEqual({
      invocationId: "00000000-0000-4000-8000-000000000099",
      moduleId: "example",
      toolName: "echo",
      transport: "stdio",
      startedAt: "2026-08-25T12:00:00.000Z"
    });
    await close();
  });

  it("redacts handler errors from protocol output and diagnostics", async () => {
    const diagnostics: string[] = [];
    const module = fixtureModule("example", "fail");
    module.tools[0]!.handler = async () => {
      throw new Error("credential super-secret-value exploded");
    };
    const host = createMcpServiceHost({
      name: "test-host",
      version: "1.0.0",
      modules: [module],
      onDiagnostic: (message) => diagnostics.push(message)
    });
    const { client, close } = await connectInMemory(host.buildServer("stdio"));

    const result = await client.callTool({ name: "fail", arguments: { value: "hello" } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
    expect(diagnostics).toEqual(["fail failed: internal_error"]);
    await close();
  });

  it("emits only schema-bounded structured error fields", async () => {
    const safe = fixtureModule("safe", "safe_error");
    safe.tools[0]!.handler = async () => {
      throw new McpServiceError("downstream_rejected", {
        status: 409,
        code: "runtime.idempotency_conflict",
        requestId: "request-1"
      });
    };
    const unsafe = fixtureModule("unsafe", "unsafe_error");
    unsafe.tools[0]!.handler = async () => {
      throw new McpServiceError(
        "downstream_rejected",
        { status: 409, token: "sentinel-secret" } as never
      );
    };
    const host = createMcpServiceHost({
      name: "test-host",
      version: "1.0.0",
      modules: [safe, unsafe],
      onDiagnostic: vi.fn()
    });
    const { client, close } = await connectInMemory(host.buildServer("stdio"));

    const safeResult = await client.callTool({ name: "safe_error", arguments: { value: "x" } });
    expect(safeResult.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          error: {
            message: "Downstream request was rejected.",
            status: 409,
            code: "runtime.idempotency_conflict",
            request_id: "request-1"
          }
        })
      }
    ]);
    const unsafeResult = await client.callTool({
      name: "unsafe_error",
      arguments: { value: "x" }
    });
    expect(JSON.stringify(unsafeResult)).not.toContain("sentinel-secret");
    await close();
  });

  it("gates hosted MCP before parsing and serves official-client calls statelessly", async () => {
    const contexts: McpToolCallContext[] = [];
    const module = fixtureModule("example", "echo", (context) => contexts.push(context));
    const originalHandler = module.tools[0]!.handler;
    const handler = vi.fn(originalHandler);
    module.tools[0]!.handler = handler;
    const host = createMcpServiceHost({
      name: "test-host",
      version: "1.0.0",
      modules: [module],
      onDiagnostic: vi.fn()
    });
    const running = await host.startHttp({
      port: 0,
      bearerToken: "bridge-secret",
      allowedOrigins: ["https://trusted.example"]
    });
    const address = running.address()!;
    const endpoint = `http://127.0.0.1:${address.port}`;

    for (const authorization of [undefined, "Basic wrong", "Bearer", "Bearer wrong"]) {
      const denied = await fetch(`${endpoint}/mcp`, {
        method: "POST",
        ...(authorization ? { headers: { authorization } } : {}),
        body: "not-json"
      });
      expect(denied.status).toBe(401);
    }
    expect(handler).not.toHaveBeenCalled();

    const invalidOrigin = await fetch(`${endpoint}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer bridge-secret",
        origin: "https://attacker.example"
      },
      body: "not-json"
    });
    expect(invalidOrigin.status).toBe(403);
    const allowedOrigin = await fetch(`${endpoint}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer bridge-secret",
        origin: "https://trusted.example"
      },
      body: "not-json"
    });
    expect(allowedOrigin.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();

    const client = new Client({ name: "http-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), {
      requestInit: { headers: { authorization: "Bearer bridge-secret" } }
    });
    await client.connect(transport as unknown as Transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(
      (await client.callTool({ name: "echo", arguments: { value: "remote" } })).structuredContent
    ).toEqual({ value: "remote" });
    await client.callTool({ name: "echo", arguments: { value: "again" } });
    expect(contexts).toHaveLength(2);
    expect(contexts.every((context) => context.transport === "streamable-http")).toBe(true);
    expect(contexts[0]!.invocationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(contexts[1]!.invocationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(contexts[0]!.invocationId).not.toBe(contexts[1]!.invocationId);

    const health = await fetch(`${endpoint}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ready: true, dimensions: { example: { ready: true } } });
    await client.close();
    await running.close();
    await host.close();
  });
});

function fixtureModule(
  id: string,
  name: string,
  observe?: (context: McpToolCallContext) => void
): McpServiceModule {
  return {
    id,
    tools: [
      {
        name,
        description: "Echo a value.",
        inputSchema: z.object({ value: z.string() }).strict(),
        outputSchema: z.object({ value: z.string() }).strict(),
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          destructiveHint: false,
          openWorldHint: false
        },
        handler: async (input, context) => {
          observe?.(context);
          return input;
        }
      }
    ]
  };
}

async function connectInMemory(server: ReturnType<ReturnType<typeof createMcpServiceHost>["buildServer"]>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}
