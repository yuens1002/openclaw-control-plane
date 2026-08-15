import { describe, expect, it } from "vitest";

import { createSetupApiClient, SetupApiError } from "@openclaw-control-plane/openclaw-setup-applier/setup-api-client";

describe("setup API client (read calls)", () => {
  it("calls GET /setup/api/status against the configured base URL", async () => {
    const requests: string[] = [];
    const client = createSetupApiClient({
      baseUrl: "https://example-openclaw.example.com/",
      fetchImpl: async (input) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ configured: true }), { status: 200 });
      }
    });

    const status = await client.getStatus();

    expect(requests).toEqual(["https://example-openclaw.example.com/setup/api/status"]);
    expect(status).toEqual({ configured: true });
  });

  it("calls GET /setup/api/auth-groups", async () => {
    const requests: string[] = [];
    const client = createSetupApiClient({
      baseUrl: "https://example-openclaw.example.com",
      fetchImpl: async (input) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ authGroups: ["openrouter"] }), { status: 200 });
      }
    });

    await client.getAuthGroups();

    expect(requests).toEqual(["https://example-openclaw.example.com/setup/api/auth-groups"]);
  });

  it("throws a status-only error and never leaks the response body", async () => {
    const client = createSetupApiClient({
      baseUrl: "https://example-openclaw.example.com",
      fetchImpl: async () =>
        new Response(JSON.stringify({ secretDetail: "sk-test-DO-NOT-LOG-leak" }), { status: 503 })
    });

    const error = await client.getStatus().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SetupApiError);
    expect((error as SetupApiError).status).toBe(503);
    expect((error as Error).message).not.toContain("sk-test-DO-NOT-LOG-leak");
  });
});

describe("setup API client (mutating calls)", () => {
  it("POSTs the given payload to /setup/api/run", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const client = createSetupApiClient({
      baseUrl: "https://example-openclaw.example.com",
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    });

    await client.run({ authGroup: "openrouter", authSecret: "sk-test-DO-NOT-LOG-9f8e7d" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://example-openclaw.example.com/setup/api/run");
    expect(requests[0]?.body).toContain("sk-test-DO-NOT-LOG-9f8e7d");
  });

  it("POSTs to /setup/api/reset", async () => {
    const requests: string[] = [];
    const client = createSetupApiClient({
      baseUrl: "https://example-openclaw.example.com",
      fetchImpl: async (input) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    });

    await client.reset();

    expect(requests).toEqual(["https://example-openclaw.example.com/setup/api/reset"]);
  });

  it("throws a status-only error for a failed run call, never leaking the response body", async () => {
    const client = createSetupApiClient({
      baseUrl: "https://example-openclaw.example.com",
      fetchImpl: async () =>
        new Response(JSON.stringify({ secretDetail: "sk-test-DO-NOT-LOG-leak" }), { status: 500 })
    });

    const error = await client.run({}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SetupApiError);
    expect((error as SetupApiError).status).toBe(500);
    expect((error as Error).message).not.toContain("sk-test-DO-NOT-LOG-leak");
  });
});

describe("setup API client (Basic auth)", () => {
  it("sends a Basic auth header, decoding back to username:password, on every call when auth is given", async () => {
    const headersSeen: Array<Record<string, string> | undefined> = [];
    const client = createSetupApiClient({
      baseUrl: "https://example-openclaw.example.com",
      auth: { username: "openclaw", password: "sk-test-DO-NOT-LOG-pw" },
      fetchImpl: async (_input, init) => {
        headersSeen.push(init?.headers as Record<string, string> | undefined);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    });

    await client.getStatus();
    await client.getAuthGroups();
    await client.run({});
    await client.reset();

    expect(headersSeen).toHaveLength(4);
    for (const headers of headersSeen) {
      const authorization = headers?.authorization;
      expect(authorization).toMatch(/^Basic .+/);
      const decoded = Buffer.from(authorization!.slice("Basic ".length), "base64").toString("utf8");
      expect(decoded).toBe("openclaw:sk-test-DO-NOT-LOG-pw");
    }
  });

  it("sends no Authorization header when auth is omitted (regression)", async () => {
    const headersSeen: Array<Record<string, string> | undefined> = [];
    const client = createSetupApiClient({
      baseUrl: "https://example-openclaw.example.com",
      fetchImpl: async (_input, init) => {
        headersSeen.push(init?.headers as Record<string, string> | undefined);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    });

    await client.getStatus();
    await client.getAuthGroups();
    await client.run({});
    await client.reset();

    expect(headersSeen).toHaveLength(4);
    for (const headers of headersSeen) {
      expect(headers?.authorization).toBeUndefined();
    }
  });

  it("never leaks the password or the encoded credential in a thrown error", async () => {
    const client = createSetupApiClient({
      baseUrl: "https://example-openclaw.example.com",
      auth: { username: "openclaw", password: "sk-test-DO-NOT-LOG-pw" },
      fetchImpl: async () => new Response(JSON.stringify({ secretDetail: "irrelevant" }), { status: 401 })
    });

    const error = await client.getStatus().catch((caught: unknown) => caught);
    const encodedCredential = Buffer.from("openclaw:sk-test-DO-NOT-LOG-pw").toString("base64");

    expect(error).toBeInstanceOf(SetupApiError);
    expect((error as Error).message).not.toContain("sk-test-DO-NOT-LOG-pw");
    expect((error as Error).message).not.toContain(encodedCredential);
  });
});
