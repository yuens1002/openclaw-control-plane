import { describe, expect, it } from "vitest";

import { patchAllowedOrigins } from "@openclaw-control-plane/openclaw-railway-installer/patch-allowed-origins";
import { createFakeConfigStore } from "./fixtures/fake-config-store.js";

const AUTH = { username: "openclaw-admin", password: "setup-secret" };
const BASE_URL = "https://example-openclaw.example.com";
const DOMAIN = "example-openclaw.example.com";
const ORIGIN = "https://example-openclaw.example.com";

describe("patchAllowedOrigins", () => {
  it("appends the instance's own domain when absent and preserves the rest of the config", async () => {
    const store = createFakeConfigStore({
      initialContent: JSON.stringify({
        agents: { defaults: { model: "anthropic/claude" } },
        gateway: { mode: "local", controlUi: { allowedOrigins: ["https://existing.example.com"] } }
      })
    });

    const result = await patchAllowedOrigins(BASE_URL, AUTH, DOMAIN, store);

    expect(result.patched).toBe(true);
    expect(store.posted).toHaveLength(1);
    const written = JSON.parse(store.posted[0] ?? "{}");
    expect(written.gateway.controlUi.allowedOrigins).toEqual(["https://existing.example.com", ORIGIN]);
    // Unrelated config content is preserved untouched.
    expect(written.agents.defaults.model).toBe("anthropic/claude");
  });

  it("is idempotent -- no POST when the origin is already present", async () => {
    const store = createFakeConfigStore({
      initialContent: JSON.stringify({ gateway: { controlUi: { allowedOrigins: [ORIGIN] } } })
    });

    const result = await patchAllowedOrigins(BASE_URL, AUTH, DOMAIN, store);

    expect(result.patched).toBe(false);
    expect(store.posted).toHaveLength(0);
    // The skipped write also skips the verification read: one GET total.
    expect(store.getCalls).toBe(1);
  });

  it("writes successfully when the config already has a baseline gateway.mode (creates the nested controlUi path)", async () => {
    const store = createFakeConfigStore({ initialContent: JSON.stringify({ gateway: { mode: "local" } }) });

    const result = await patchAllowedOrigins(BASE_URL, AUTH, DOMAIN, store);

    expect(result.patched).toBe(true);
    const written = JSON.parse(store.posted[0] ?? "{}");
    expect(written.gateway.controlUi.allowedOrigins).toEqual([ORIGIN]);
  });

  it("skips the write and reports patched:false against a genuinely fresh instance with no gateway.mode (issue #77)", async () => {
    // An empty/unconfigured config file is exactly what the wrapper serves
    // for an instance that has never been through /setup/api/run -- no
    // `gateway` section at all, so no `gateway.mode` either.
    const store = createFakeConfigStore({ initialContent: "" });

    const result = await patchAllowedOrigins(BASE_URL, AUTH, DOMAIN, store);

    expect(result.patched).toBe(false);
    // Never POSTs an incomplete document -- the wrapper treats a config with
    // allowedOrigins but no gateway.mode as suspicious/clobbered and refuses
    // to start the gateway against it.
    expect(store.posted).toHaveLength(0);
  });

  it("skips the write when gateway.mode is present but not a non-empty string", async () => {
    const store = createFakeConfigStore({ initialContent: JSON.stringify({ gateway: { mode: "" } }) });

    const result = await patchAllowedOrigins(BASE_URL, AUTH, DOMAIN, store);

    expect(result.patched).toBe(false);
    expect(store.posted).toHaveLength(0);
  });

  it("re-reads the config after writing to confirm the origin actually landed", async () => {
    const store = createFakeConfigStore({ initialContent: JSON.stringify({ gateway: { mode: "local" } }) });

    await patchAllowedOrigins(BASE_URL, AUTH, DOMAIN, store);

    // Two GETs: the compare-then-write read, then the post-write verification
    // read. A single GET would mean the write was never confirmed.
    expect(store.getCalls).toBe(2);
  });

  it("throws when the write reports success but the origin is absent afterward", async () => {
    // The endpoint answers ok:true and the value never lands -- exactly the
    // silent-failure class an ok:true check alone cannot detect.
    const store = createFakeConfigStore({
      initialContent: JSON.stringify({ gateway: { mode: "local" } }),
      persistWrites: false
    });

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
          return getCalls === 1 ? { ok: true, content: JSON.stringify({ gateway: { mode: "local" } }) } : { ok: false, content: "" };
        },
        postConfigRaw: async () => ({ ok: true })
      })
    ).rejects.toThrow(/Post-write verification failed/);
  });

  it("reports a verification failure, not a bare parse error, when the config comes back unparseable", async () => {
    let getCalls = 0;
    await expect(
      patchAllowedOrigins(BASE_URL, AUTH, DOMAIN, {
        getConfigRaw: async () => {
          getCalls += 1;
          // Valid on the first read; corrupt on the verification read.
          return getCalls === 1 ? { ok: true, content: JSON.stringify({ gateway: { mode: "local" } }) } : { ok: true, content: "{ not json" };
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
        getConfigRaw: async () => ({ ok: true, content: JSON.stringify({ gateway: { mode: "local" } }) }),
        postConfigRaw: async () => ({ ok: false })
      })
    ).rejects.toThrow("ok:false");
  });
});
