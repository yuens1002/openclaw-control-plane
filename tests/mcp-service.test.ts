import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createMcpServiceHost,
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

  it("gates hosted MCP before parsing and serves official-client calls statelessly", async () => {
    const handler = vi.fn(async (input: Record<string, unknown>) => input);
    const module = fixtureModule("example", "echo");
    module.tools[0]!.handler = handler;
    const host = createMcpServiceHost({
      name: "test-host",
      version: "1.0.0",
      modules: [module],
      onDiagnostic: vi.fn()
    });
    const running = await host.startHttp({ port: 0, bearerToken: "bridge-secret" });
    const address = running.address()!;
    const endpoint = `http://127.0.0.1:${address.port}`;

    const denied = await fetch(`${endpoint}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: "not-json"
    });
    expect(denied.status).toBe(401);
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
