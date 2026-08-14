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
