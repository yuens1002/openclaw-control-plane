import { describe, expect, it } from "vitest";

import { patchAllowedOrigins } from "@openclaw-control-plane/openclaw-railway-installer/patch-allowed-origins";

const AUTH = { username: "openclaw-admin", password: "setup-secret" };
const BASE_URL = "https://example-openclaw.example.com";
const DOMAIN = "example-openclaw.example.com";
const ORIGIN = "https://example-openclaw.example.com";

/**
 * A fake config endpoint that behaves like the real wrapper: a successful POST
 * changes what the next GET returns.
 *
 * Static stubs cannot exercise the post-write verification read at all -- they
 * report the pre-write state forever, so a write that genuinely landed looks
 * like a failure. `persistWrites: false` deliberately models the case this
 * verification exists to catch: the endpoint answers ok:true but the intended
 * value is not actually present afterward.
 */
function createFakeConfigStore(initialContent: string, options: { persistWrites?: boolean } = {}) {
  const persistWrites = options.persistWrites ?? true;
  let content = initialContent;
  const posted: string[] = [];
  let getCalls = 0;

  return {
    posted,
    get getCalls() {
      return getCalls;
    },
    getConfigRaw: async () => {
      getCalls += 1;
      return { ok: true, content };
    },
    postConfigRaw: async (_baseUrl: string, _auth: unknown, next: string) => {
      posted.push(next);
      if (persistWrites) {
        content = next;
      }
      return { ok: true };
    }
  };
}

describe("patchAllowedOrigins", () => {
  it("appends the instance's own domain when absent and preserves the rest of the config", async () => {
    const store = createFakeConfigStore(
      JSON.stringify({
        agents: { defaults: { model: "anthropic/claude" } },
        gateway: { controlUi: { allowedOrigins: ["https://existing.example.com"] } }
      })
    );

    const result = await patchAllowedOrigins(BASE_URL, AUTH, DOMAIN, store);

    expect(result.patched).toBe(true);
    expect(store.posted).toHaveLength(1);
    const written = JSON.parse(store.posted[0] ?? "{}");
    expect(written.gateway.controlUi.allowedOrigins).toEqual(["https://existing.example.com", ORIGIN]);
    // Unrelated config content is preserved untouched.
    expect(written.agents.defaults.model).toBe("anthropic/claude");
  });

  it("is idempotent -- no POST when the origin is already present", async () => {
    const store = createFakeConfigStore(
      JSON.stringify({ gateway: { controlUi: { allowedOrigins: [ORIGIN] } } })
    );

    const result = await patchAllowedOrigins(BASE_URL, AUTH, DOMAIN, store);

    expect(result.patched).toBe(false);
    expect(store.posted).toHaveLength(0);
    // The skipped write also skips the verification read: one GET total.
    expect(store.getCalls).toBe(1);
  });

  it("handles an empty/unconfigured config file by creating the nested path", async () => {
    const store = createFakeConfigStore("");

    const result = await patchAllowedOrigins(BASE_URL, AUTH, DOMAIN, store);

    expect(result.patched).toBe(true);
    const written = JSON.parse(store.posted[0] ?? "{}");
    expect(written.gateway.controlUi.allowedOrigins).toEqual([ORIGIN]);
  });

  it("re-reads the config after writing to confirm the origin actually landed", async () => {
    const store = createFakeConfigStore("{}");

    await patchAllowedOrigins(BASE_URL, AUTH, DOMAIN, store);

    // Two GETs: the compare-then-write read, then the post-write verification
    // read. A single GET would mean the write was never confirmed.
    expect(store.getCalls).toBe(2);
  });

  it("throws when the write reports success but the origin is absent afterward", async () => {
    // The endpoint answers ok:true and the value never lands -- exactly the
    // silent-failure class an ok:true check alone cannot detect.
    const store = createFakeConfigStore("{}", { persistWrites: false });

    await expect(patchAllowedOrigins(BASE_URL, AUTH, DOMAIN, store)).rejects.toThrow(
      /Post-write verification failed/
    );
    // It still attempted the write; the failure is in confirming it, not sending it.
    expect(store.posted).toHaveLength(1);
  });

  it("throws when the post-write verification read itself responds ok:false", async () => {
    let getCalls = 0;
    await expect(
      patchAllowedOrigins(BASE_URL, AUTH, DOMAIN, {
        getConfigRaw: async () => {
          getCalls += 1;
          // First read succeeds; the verification read fails.
          return getCalls === 1 ? { ok: true, content: "{}" } : { ok: false, content: "" };
        },
        postConfigRaw: async () => ({ ok: true })
      })
    ).rejects.toThrow(/Post-write verification failed/);
  });

  it("throws when the wrapper responds ok:false on GET, even with a 2xx-shaped body", async () => {
    await expect(
      patchAllowedOrigins(BASE_URL, AUTH, DOMAIN, {
        getConfigRaw: async () => ({ ok: false, content: "" }),
        postConfigRaw: async () => ({ ok: true })
      })
    ).rejects.toThrow("ok:false");
  });

  it("throws when the wrapper responds ok:false on POST, and does not report patched: true", async () => {
    await expect(
      patchAllowedOrigins(BASE_URL, AUTH, DOMAIN, {
        getConfigRaw: async () => ({ ok: true, content: "{}" }),
        postConfigRaw: async () => ({ ok: false })
      })
    ).rejects.toThrow("ok:false");
  });
});
