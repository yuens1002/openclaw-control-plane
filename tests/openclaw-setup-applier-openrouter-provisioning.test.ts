import { describe, expect, it } from "vitest";

import {
  deleteOpenRouterKey,
  mintOpenRouterKey,
  OpenRouterProvisioningError
} from "@openclaw-control-plane/openclaw-setup-applier/openrouter-provisioning";

// Every test in this file stubs `fetch`. Minting/deleting is real, billable,
// and irreversible against the actual OpenRouter API — no test here may
// reach `https://openrouter.ai`.

describe("OpenRouter key minting", () => {
  it("POSTs to /api/v1/keys with the requested spend limit and reset, and returns the minted key + hash", async () => {
    const requests: Array<{ url: string; body: string; auth: string | null }> = [];
    const minted = await mintOpenRouterKey(
      { name: "EXAMPLE_OPENROUTER_MANAGED_API_KEY", spendLimitUsd: 25, limitReset: "monthly" },
      {
        managementKey: "sk-test-DO-NOT-LOG-mgmt",
        fetchImpl: async (input, init) => {
          requests.push({
            url: String(input),
            body: String(init?.body),
            auth: (init?.headers as Record<string, string> | undefined)?.["authorization"] ?? null
          });
          // Real shape, confirmed live: `data.hash` is nested, not top-level.
          return new Response(
            JSON.stringify({ key: "sk-test-DO-NOT-LOG-minted", data: { hash: "hash-test-abc123" } }),
            { status: 200 }
          );
        }
      }
    );

    expect(minted).toEqual({ key: "sk-test-DO-NOT-LOG-minted", hash: "hash-test-abc123" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/keys");
    expect(requests[0]?.body).toContain('"limit":25');
    expect(requests[0]?.body).toContain('"limit_reset":"monthly"');
    expect(requests[0]?.auth).toBe("Bearer sk-test-DO-NOT-LOG-mgmt");
  });

  it("throws a status-only error and never leaks the response body", async () => {
    const error = await mintOpenRouterKey(
      { name: "EXAMPLE_KEY", spendLimitUsd: 10, limitReset: "monthly" },
      {
        managementKey: "sk-test-DO-NOT-LOG-mgmt",
        fetchImpl: async () =>
          new Response(JSON.stringify({ detail: "sk-test-DO-NOT-LOG-leak" }), { status: 429 })
      }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenRouterProvisioningError);
    expect((error as OpenRouterProvisioningError).status).toBe(429);
    expect((error as Error).message).not.toContain("sk-test-DO-NOT-LOG-leak");
  });

  it("throws if the response has no key", async () => {
    const error = await mintOpenRouterKey(
      { name: "EXAMPLE_KEY", spendLimitUsd: 10, limitReset: "monthly" },
      {
        managementKey: "sk-test-DO-NOT-LOG-mgmt",
        fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 })
      }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
  });

  it("throws if the response has a key but no data.hash", async () => {
    const error = await mintOpenRouterKey(
      { name: "EXAMPLE_KEY", spendLimitUsd: 10, limitReset: "monthly" },
      {
        managementKey: "sk-test-DO-NOT-LOG-mgmt",
        fetchImpl: async () => new Response(JSON.stringify({ key: "sk-test-DO-NOT-LOG-minted" }), { status: 200 })
      }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("hash");
  });

  it("throws if data is present but data.hash is missing", async () => {
    const error = await mintOpenRouterKey(
      { name: "EXAMPLE_KEY", spendLimitUsd: 10, limitReset: "monthly" },
      {
        managementKey: "sk-test-DO-NOT-LOG-mgmt",
        fetchImpl: async () =>
          new Response(JSON.stringify({ key: "sk-test-DO-NOT-LOG-minted", data: { name: "EXAMPLE_KEY" } }), {
            status: 200
          })
      }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("hash");
  });
});

describe("OpenRouter key deletion", () => {
  it("DELETEs /api/v1/keys/{hash} with the management bearer token", async () => {
    const requests: Array<{ url: string; method: string | undefined; auth: string | null }> = [];
    await deleteOpenRouterKey("hash-test-abc123", {
      managementKey: "sk-test-DO-NOT-LOG-mgmt",
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method,
          auth: (init?.headers as Record<string, string> | undefined)?.["authorization"] ?? null
        });
        return new Response(null, { status: 200 });
      }
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/keys/hash-test-abc123");
    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.auth).toBe("Bearer sk-test-DO-NOT-LOG-mgmt");
  });

  it("throws a status-only error and never leaks the response body", async () => {
    const error = await deleteOpenRouterKey("hash-test-abc123", {
      managementKey: "sk-test-DO-NOT-LOG-mgmt",
      fetchImpl: async () => new Response(JSON.stringify({ detail: "sk-test-DO-NOT-LOG-leak" }), { status: 404 })
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenRouterProvisioningError);
    expect((error as OpenRouterProvisioningError).status).toBe(404);
    expect((error as Error).message).not.toContain("sk-test-DO-NOT-LOG-leak");
  });
});
