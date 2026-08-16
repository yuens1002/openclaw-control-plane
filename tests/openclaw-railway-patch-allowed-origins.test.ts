import { describe, expect, it } from "vitest";

import { patchAllowedOrigins } from "@openclaw-control-plane/openclaw-railway-installer/patch-allowed-origins";

const AUTH = { username: "openclaw-admin", password: "setup-secret" };
const BASE_URL = "https://example-openclaw.example.com";
const DOMAIN = "example-openclaw.example.com";

describe("patchAllowedOrigins", () => {
  it("appends the instance's own domain when absent and preserves the rest of the config", async () => {
    const posted: string[] = [];

    const result = await patchAllowedOrigins(BASE_URL, AUTH, DOMAIN, {
      getConfigRaw: async () => ({
        ok: true,
        content: JSON.stringify({
          agents: { defaults: { model: "anthropic/claude" } },
          gateway: { controlUi: { allowedOrigins: ["https://existing.example.com"] } }
        })
      }),
      postConfigRaw: async (_baseUrl, _auth, content) => {
        posted.push(content);
        return { ok: true };
      }
    });

    expect(result.patched).toBe(true);
    expect(posted).toHaveLength(1);
    const written = JSON.parse(posted[0] ?? "{}");
    expect(written.gateway.controlUi.allowedOrigins).toEqual([
      "https://existing.example.com",
      "https://example-openclaw.example.com"
    ]);
    // Unrelated config content is preserved untouched.
    expect(written.agents.defaults.model).toBe("anthropic/claude");
  });

  it("is idempotent -- no POST when the origin is already present", async () => {
    let postCalls = 0;

    const result = await patchAllowedOrigins(BASE_URL, AUTH, DOMAIN, {
      getConfigRaw: async () => ({
        ok: true,
        content: JSON.stringify({
          gateway: { controlUi: { allowedOrigins: ["https://example-openclaw.example.com"] } }
        })
      }),
      postConfigRaw: async () => {
        postCalls += 1;
        return { ok: true };
      }
    });

    expect(result.patched).toBe(false);
    expect(postCalls).toBe(0);
  });

  it("handles an empty/unconfigured config file by creating the nested path", async () => {
    const posted: string[] = [];

    const result = await patchAllowedOrigins(BASE_URL, AUTH, DOMAIN, {
      getConfigRaw: async () => ({ ok: true, content: "" }),
      postConfigRaw: async (_baseUrl, _auth, content) => {
        posted.push(content);
        return { ok: true };
      }
    });

    expect(result.patched).toBe(true);
    const written = JSON.parse(posted[0] ?? "{}");
    expect(written.gateway.controlUi.allowedOrigins).toEqual(["https://example-openclaw.example.com"]);
  });
});
