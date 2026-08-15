import { describe, expect, it } from "vitest";

import {
  mintOpenRouterKey,
  OpenRouterProvisioningError
} from "@openclaw-control-plane/openclaw-setup-applier/openrouter-provisioning";

// Every test in this file stubs `fetch`. Minting is real, billable, and
// irreversible against the actual OpenRouter API — no test here may reach
// `https://openrouter.ai`.

describe("OpenRouter key minting", () => {
  it("POSTs to /api/v1/keys with the requested spend limit and reset, and returns the minted key", async () => {
    const requests: Array<{ url: string; body: string; auth: string | null }> = [];
    const key = await mintOpenRouterKey(
      { name: "EXAMPLE_OPENROUTER_MANAGED_API_KEY", spendLimitUsd: 25, limitReset: "monthly" },
      {
        managementKey: "sk-test-DO-NOT-LOG-mgmt",
        fetchImpl: async (input, init) => {
          requests.push({
            url: String(input),
            body: String(init?.body),
            auth: (init?.headers as Record<string, string> | undefined)?.["authorization"] ?? null
          });
          return new Response(JSON.stringify({ key: "sk-test-DO-NOT-LOG-minted" }), { status: 200 });
        }
      }
    );

    expect(key).toBe("sk-test-DO-NOT-LOG-minted");
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
});
