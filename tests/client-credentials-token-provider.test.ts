import { describe, expect, it, vi } from "vitest";

import { createClientCredentialsTokenProvider } from "@openclaw-control-plane/decision-runtime-mcp/token-provider";

describe("OIDC client-credentials token provider", () => {
  it("requires secure endpoints unless local insecure transport is explicit", () => {
    expect(() => createProvider({ tokenEndpoint: "http://issuer.example/token" })).toThrow(
      /requires HTTPS/
    );
    expect(() =>
      createProvider({ tokenEndpoint: "http://127.0.0.1/token", allowInsecureTransport: true })
    ).not.toThrow();
    expect(() =>
      createProvider({
        tokenEndpoint: "http://issuer.remote.example/token",
        allowInsecureTransport: true
      })
    ).toThrow(/requires HTTPS/);
  });

  it("uses Basic client authentication with optional scope and audience", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      Response.json({ access_token: "short-lived", token_type: "bearer", expires_in: 120 })
    );
    const provider = createProvider(
      { scope: "runtime.execute", audience: "control-plane" },
      { fetchImpl }
    );

    await expect(provider.getToken()).resolves.toBe("short-lived");

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://issuer.example/token");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`
    );
    expect(String(init?.body)).toBe(
      "grant_type=client_credentials&scope=runtime.execute&audience=control-plane"
    );
  });

  it("form-encodes OAuth client passwords before Basic encoding", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Basic ${Buffer.from("client%3Aid:s+e%25%3A%E9%9B%AA").toString("base64")}`
      );
      return Response.json({ access_token: "encoded", token_type: "Bearer", expires_in: 60 });
    });
    const provider = createClientCredentialsTokenProvider(
      {
        tokenEndpoint: "https://issuer.example/token",
        clientId: "client:id",
        clientSecret: "s e%:雪"
      },
      { fetchImpl }
    );

    await expect(provider.getToken()).resolves.toBe("encoded");
  });

  it("supports form client authentication without an authorization header", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(String(init?.body)).toContain("client_id=client-id");
      expect(String(init?.body)).toContain("client_secret=client-secret");
      return Response.json({ access_token: "form-token", token_type: "Bearer", expires_in: 60 });
    });
    const provider = createProvider({ authMethod: "client_secret_post" }, { fetchImpl });

    await expect(provider.getToken()).resolves.toBe("form-token");
  });

  it("caches before the refresh boundary and coalesces concurrent refresh", async () => {
    let timestamp = 1_000_000;
    let resolveSecond: ((response: Response) => void) | undefined;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ access_token: "token-1", token_type: "Bearer", expires_in: 60 })
      )
      .mockImplementationOnce(
        async () => new Promise<Response>((resolve) => (resolveSecond = resolve))
      );
    const provider = createProvider(
      { refreshSkewSeconds: 10 },
      { fetchImpl, now: () => timestamp }
    );

    await expect(provider.getToken()).resolves.toBe("token-1");
    timestamp += 49_000;
    await expect(provider.getToken()).resolves.toBe("token-1");
    timestamp += 1_000;
    const one = provider.getToken();
    const two = provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    resolveSecond!(
      Response.json({ access_token: "token-2", token_type: "Bearer", expires_in: 60 })
    );
    await expect(Promise.all([one, two])).resolves.toEqual(["token-2", "token-2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("invalidates only the matching cached token", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ access_token: "token-1", token_type: "Bearer", expires_in: 60 })
      )
      .mockResolvedValueOnce(
        Response.json({ access_token: "token-2", token_type: "Bearer", expires_in: 60 })
      );
    const provider = createProvider({}, { fetchImpl });

    await provider.getToken();
    provider.invalidate("another-token");
    await expect(provider.getToken()).resolves.toBe("token-1");
    provider.invalidate("token-1");
    await expect(provider.getToken()).resolves.toBe("token-2");
  });

  it("returns bounded failures for denied and malformed token responses", async () => {
    const denied = createProvider(
      {},
      { fetchImpl: vi.fn(async () => new Response("client-secret", { status: 401 })) }
    );
    await expect(denied.getToken()).rejects.toThrow("OIDC token endpoint returned 401.");
    await expect(denied.getToken()).rejects.not.toThrow(/client-secret/);

    const malformed = createProvider(
      {},
      {
        fetchImpl: vi.fn(async () =>
          Response.json({ access_token: "leaked-token", token_type: "MAC", expires_in: 60 })
        )
      }
    );
    await expect(malformed.getToken()).rejects.toThrow(
      "OIDC token endpoint returned an invalid response."
    );
    await expect(malformed.getToken()).rejects.not.toThrow(/leaked-token/);
  });
});

function createProvider(
  overrides: Record<string, unknown>,
  options: Parameters<typeof createClientCredentialsTokenProvider>[1] = {}
) {
  return createClientCredentialsTokenProvider(
    {
      tokenEndpoint: "https://issuer.example/token",
      clientId: "client-id",
      clientSecret: "client-secret",
      ...overrides
    },
    options
  );
}
