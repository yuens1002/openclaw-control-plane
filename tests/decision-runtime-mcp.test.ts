import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { createDecisionRuntimeMcpModule } from "@openclaw-control-plane/decision-runtime-mcp";
import { createMcpServiceHost } from "@openclaw-control-plane/mcp-service";

const RECORD_ID = "00000000-0000-4000-8000-000000000012";
const WORK_ITEM_ID = "00000000-0000-4000-8000-000000000010";

describe("Decision Runtime MCP module", () => {
  it("exposes exactly ten reviewed tools and maps every call through the HTTP adapter", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const tokenProvider = provider();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return runtimeResponse(String(url));
    });
    const module = createDecisionRuntimeMcpModule({
      runtimeBaseUrl: "https://runtime.example",
      tokenProvider,
      fetchImpl
    });
    const host = createMcpServiceHost({
      name: "decision-runtime",
      version: "1.0.0",
      modules: [module],
      createInvocationId: () => "tool-call-42"
    });
    const { client, close } = await connect(host);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
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
    ]);
    expect(
      listed.tools.find((tool) => tool.name === "execute_runtime_command")?.annotations
    ).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
      destructiveHint: true,
      openWorldHint: true
    });
    expect(
      listed.tools.find((tool) => tool.name === "get_runtime_record")?.annotations
    ).toMatchObject({ readOnlyHint: true, destructiveHint: false });

    await client.callTool({ name: "list_runtime_registrations", arguments: {} });
    await client.callTool({ name: "create_runtime_event", arguments: intakeInput(RECORD_ID) });
    await client.callTool({
      name: "create_runtime_work_item",
      arguments: intakeInput(WORK_ITEM_ID)
    });
    await client.callTool({ name: "create_runtime_approval", arguments: approvalInput() });
    await client.callTool({ name: "execute_runtime_command", arguments: commandInput() });
    await client.callTool({ name: "get_runtime_record", arguments: { record_id: RECORD_ID } });
    await client.callTool({ name: "get_runtime_edges", arguments: { record_id: RECORD_ID } });
    await client.callTool({
      name: "list_runtime_stream_records",
      arguments: { stream_id: "stream-1", kind: "result", limit: 25 }
    });
    await client.callTool({ name: "list_runtime_audit", arguments: { limit: 20 } });
    await client.callTool({
      name: "get_runtime_projection",
      arguments: {
        projection_type: "example.current",
        subject_type: "example.environment",
        subject_id: "production",
        stream_id: "stream-1",
        projection_version: 1
      }
    });

    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/v1/runtime/registrations",
      "/v1/runtime/events",
      "/v1/runtime/work-items",
      "/v1/runtime/approvals",
      "/v1/runtime/commands",
      `/v1/runtime/records/${RECORD_ID}`,
      `/v1/runtime/records/${RECORD_ID}/edges`,
      "/v1/runtime/streams/stream-1/records",
      "/v1/runtime/audit",
      "/v1/runtime/projections/example.current/example.environment/production"
    ]);
    expect(new URL(requests[7]!.url).search).toBe("?kind=result&limit=25");
    expect(new URL(requests[9]!.url).search).toBe(
      "?stream_id=stream-1&projection_version=1"
    );
    expect(new Headers(requests[4]!.init.headers).get("x-tool-invocation-id")).toBe(
      "tool-call-42"
    );
    expect(JSON.parse(String(requests[4]!.init.body)).idempotency_key).toBe("command-1");
    expect(tokenProvider.getToken).toHaveBeenCalledTimes(10);
    await close();
  });

  it("rejects malformed input before token acquisition or runtime access", async () => {
    const tokenProvider = provider();
    const fetchImpl = vi.fn();
    const host = createMcpServiceHost({
      name: "decision-runtime",
      version: "1.0.0",
      modules: [
        createDecisionRuntimeMcpModule({
          runtimeBaseUrl: "https://runtime.example",
          tokenProvider,
          fetchImpl
        })
      ]
    });
    const { client, close } = await connect(host);

    const result = await client.callTool({ name: "execute_runtime_command", arguments: {} });

    expect(result.isError).toBe(true);
    expect(tokenProvider.getToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    await close();
  });

  it("reacquires once after a 401 and does not retry authorization denials", async () => {
    const tokenProvider = provider();
    tokenProvider.getToken.mockResolvedValueOnce("expired").mockResolvedValueOnce("fresh");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ types: [], operations: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const host = createMcpServiceHost({
      name: "decision-runtime",
      version: "1.0.0",
      modules: [
        createDecisionRuntimeMcpModule({
          runtimeBaseUrl: "https://runtime.example",
          tokenProvider,
          fetchImpl
        })
      ]
    });
    const { client, close } = await connect(host);

    const recovered = await client.callTool({ name: "list_runtime_registrations", arguments: {} });
    expect(recovered.isError).not.toBe(true);
    expect(tokenProvider.invalidate).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const denied = await client.callTool({ name: "list_runtime_registrations", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(tokenProvider.invalidate).toHaveBeenCalledOnce();
    await close();
  });
});

function provider() {
  return {
    getToken: vi.fn(async () => "runtime-token"),
    invalidate: vi.fn(),
    status: () => ({ ready: true, cached: true })
  };
}

function runtimeResponse(url: string) {
  const path = new URL(url).pathname;
  if (path.endsWith("/registrations")) return Response.json({ types: [], operations: [] });
  if (path.endsWith("/events")) {
    return Response.json({ status: "inserted", record: runtimeRecord(RECORD_ID, "event") });
  }
  if (path.endsWith("/work-items")) {
    return Response.json({ status: "inserted", record: runtimeRecord(WORK_ITEM_ID, "work_item") });
  }
  if (path.endsWith("/approvals")) {
    return Response.json({
      status: "inserted",
      approval_id: "00000000-0000-4000-8000-000000000020",
      command_digest: `sha256:${"a".repeat(64)}`
    });
  }
  if (path.endsWith("/commands")) {
    return Response.json({
      status: "inserted",
      terminal_status: "succeeded",
      operation_record_id: RECORD_ID,
      result_record_ids: []
    });
  }
  if (path.endsWith("/edges")) return Response.json({ edges: [] });
  if (path.includes("/streams/") || path.endsWith("/audit")) {
    return Response.json({ records: [], next_cursor: null });
  }
  if (path.includes("/projections/")) {
    return Response.json({ projection: { state: { ready: true }, last_record_sequence: 4 } });
  }
  return Response.json({ record: runtimeRecord(RECORD_ID, "event") });
}

function intakeInput(recordId: string) {
  return {
    record_id: recordId,
    stream_id: "stream-1",
    type: "example.intake",
    schema_version: 1,
    subject: { type: "example.environment", id: "production" },
    payload: { ready: true },
    source_refs: []
  };
}

function commandEnvelope() {
  return {
    operation_type: "example.state.reconcile",
    operation_schema_version: 1,
    work_item_id: WORK_ITEM_ID,
    action_revision: 1,
    target: { type: "example.environment", id: "production" },
    arguments: { desired: { ready: true } },
    declared_effects: []
  };
}

function approvalInput() {
  return { ...commandEnvelope(), decision: "approved" };
}

function commandInput() {
  return {
    ...commandEnvelope(),
    stream_id: "stream-1",
    idempotency_key: "command-1",
    trigger: { type: "user_request", ref: { kind: "work_item", id: WORK_ITEM_ID } },
    causation_ref: { kind: "work_item", id: WORK_ITEM_ID },
    correlation_id: "correlation-1",
    input_refs: []
  };
}

function runtimeRecord(recordId: string, kind: "event" | "work_item") {
  return {
    record_id: recordId,
    stream_id: "stream-1",
    record_sequence: 1,
    kind,
    type: "example.intake",
    schema_version: 1,
    schema_ref: "runtime://schemas/example/v1",
    command_context: {
      authenticated_principal_ref: "principal://example/service",
      effective_actor: { type: "service", id: "example-service" },
      request_origin: "tool",
      authorization: {
        decision_id: "decision-1",
        action: "example.read",
        result: "allowed",
        policy_version: "v1",
        reason_codes: []
      }
    },
    subject: { type: "example.environment", id: "production" },
    payload: { ready: true },
    occurred_at: "2026-08-25T12:00:00.000Z",
    recorded_at: "2026-08-25T12:00:00.000Z"
  };
}

async function connect(host: ReturnType<typeof createMcpServiceHost>) {
  const server = host.buildServer("stdio");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "module-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
      await host.close();
    }
  };
}
