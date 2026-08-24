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

    await tools.list_runtime_stream_records("stream one", {
      kind: "result",
      cursor: "opaque-page-token",
      limit: 25
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://control-plane.example/v1/runtime/streams/stream%20one/records?kind=result&cursor=opaque-page-token&limit=25",
      expect.objectContaining({ method: "GET" })
    );
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
});
