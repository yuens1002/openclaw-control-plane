import { describe, expect, it, vi } from "vitest";

import { createOpenClawControlPlaneTools } from "@openclaw-control-plane/openclaw-adapter";

describe("authenticated runtime tool adapter", () => {
  it("rejects bearer tokens over plaintext transport unless explicitly enabled", () => {
    expect(() =>
      createOpenClawControlPlaneTools({
        baseUrl: "http://control-plane.example",
        tokenProvider: () => "token"
      })
    ).toThrow(/require HTTPS/i);
  });
  it("obtains a fresh bearer token for every call", async () => {
    const requests: RequestInit[] = [];
    const tokenProvider = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("token-1")
      .mockResolvedValueOnce("token-2");
    const tools = createOpenClawControlPlaneTools({
      baseUrl: "https://control-plane.example/",
      tokenProvider,
      fetchImpl: vi.fn(async (_url, init) => {
        requests.push(init ?? {});
        return Response.json({ types: [], operations: [] });
      })
    });

    await tools.list_runtime_registrations();
    await tools.list_runtime_registrations();

    expect(tokenProvider).toHaveBeenCalledTimes(2);
    expect(new Headers(requests[0]!.headers).get("authorization")).toBe("Bearer token-1");
    expect(new Headers(requests[1]!.headers).get("authorization")).toBe("Bearer token-2");
  });

  it("maps bounded query inputs to the versioned API", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ records: [], next_cursor: null }));
    const tools = createOpenClawControlPlaneTools({
      baseUrl: "https://control-plane.example",
      tokenProvider: () => "token",
      fetchImpl
    });

    await tools.list_runtime_stream_records("stream-one", {
      kind: "result",
      cursor: "opaque-page-token",
      limit: 25
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://control-plane.example/v1/runtime/streams/stream-one/records?kind=result&cursor=opaque-page-token&limit=25",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("serializes a supplied falsy JSON body", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ status: "inserted", event: false })
    );
    const tools = createOpenClawControlPlaneTools({
      baseUrl: "https://control-plane.example",
      fetchImpl
    });

    await tools.ingest_event(false as never);

    const request = fetchImpl.mock.calls[0]![1]!;
    expect(new Headers(request.headers).get("content-type")).toBe("application/json");
    expect(request.body).toBe("false");
  });

  it("does not include bearer tokens in API errors", async () => {
    const tools = createOpenClawControlPlaneTools({
      baseUrl: "https://control-plane.example",
      tokenProvider: () => "super-secret-token",
      fetchImpl: vi.fn(async () => new Response("denied", { status: 403 }))
    });

    await expect(tools.list_runtime_registrations()).rejects.toThrow(
      "Control plane API returned 403"
    );
    await expect(tools.list_runtime_registrations()).rejects.not.toThrow(/super-secret-token/);
  });

  it("rejects malformed API responses instead of trusting a TypeScript cast", async () => {
    const tools = createOpenClawControlPlaneTools({
      baseUrl: "https://control-plane.example",
      tokenProvider: () => "token",
      fetchImpl: vi.fn(async () => Response.json({ totally: "wrong" }))
    });

    await expect(tools.list_runtime_registrations()).rejects.toThrow();
  });

  it("rejects malformed tool input before issuing a request", async () => {
    const fetchImpl = vi.fn();
    const tools = createOpenClawControlPlaneTools({
      baseUrl: "https://control-plane.example",
      tokenProvider: () => "token",
      fetchImpl
    });

    await expect(tools.execute_runtime_command({} as never)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates command, record, provenance, projection, and audit responses", async () => {
    const toolInvocationIdProvider = vi.fn(async () => "tool-call-42");
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/commands")) {
        expect(new Headers(init?.headers).get("x-tool-invocation-id")).toBe("tool-call-42");
        return Response.json({
          status: "inserted",
          terminal_status: "succeeded",
          operation_record_id: "00000000-0000-4000-8000-000000000012",
          result_record_ids: ["00000000-0000-4000-8000-000000000013"]
        });
      }
      if (path.endsWith("/edges")) return Response.json({ edges: [] });
      if (path.includes("/projections/")) {
        return Response.json({ projection: { state: { ready: true }, last_record_sequence: 4 } });
      }
      if (path.endsWith("/audit")) return Response.json({ records: [], next_cursor: null });
      return Response.json({ record: runtimeRecord() });
    });
    const tools = createOpenClawControlPlaneTools({
      baseUrl: "https://control-plane.example",
      tokenProvider: () => "token",
      toolInvocationIdProvider,
      fetchImpl
    });

    await tools.execute_runtime_command(commandRequest());
    await tools.get_runtime_record("00000000-0000-4000-8000-000000000012");
    await tools.get_runtime_edges("00000000-0000-4000-8000-000000000012");
    await tools.get_runtime_projection(
      "example.current",
      "example.environment",
      "production",
      "stream-1",
      1
    );
    await tools.list_runtime_audit();

    expect(toolInvocationIdProvider).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});

function commandRequest() {
  return {
    stream_id: "stream-1",
    idempotency_key: "command-1",
    operation_type: "example.state.reconcile",
    operation_schema_version: 1,
    work_item_id: "00000000-0000-4000-8000-000000000010",
    action_revision: 1,
    target: { type: "example.environment", id: "production" },
    arguments: { desired: { ready: true } },
    declared_effects: [],
    trigger: {
      type: "user_request" as const,
      ref: { kind: "work_item" as const, id: "00000000-0000-4000-8000-000000000010" }
    },
    causation_ref: {
      kind: "work_item" as const,
      id: "00000000-0000-4000-8000-000000000010"
    },
    correlation_id: "correlation-1",
    input_refs: []
  };
}

function runtimeRecord() {
  return {
    record_id: "00000000-0000-4000-8000-000000000012",
    stream_id: "stream-1",
    record_sequence: 1,
    kind: "action_attempt",
    type: "runtime.action.attempt",
    schema_version: 1,
    schema_ref: "runtime://schemas/action-attribution/v1",
    command_context: {
      authenticated_principal_ref: "principal://example/service",
      effective_actor: { type: "service", id: "example-service" },
      request_origin: "tool",
      authorization: {
        decision_id: "decision-1",
        action: "state.reconcile",
        result: "allowed",
        policy_version: "v1",
        reason_codes: ["example.allowed"]
      }
    },
    subject: { type: "example.environment", id: "production" },
    payload: {},
    occurred_at: "2026-08-24T12:00:00.000Z",
    recorded_at: "2026-08-24T12:00:00.000Z"
  };
}
