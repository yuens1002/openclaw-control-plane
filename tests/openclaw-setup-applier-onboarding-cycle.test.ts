import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { RailwayRunner } from "@openclaw-control-plane/openclaw-railway-installer";
import { bootstrapOnboardingCycle, runRegressionCheck } from "@openclaw-control-plane/openclaw-setup-applier/onboarding-cycle";
import { createFakeConfigStore } from "./fixtures/fake-config-store.js";
import { FakeRailwayRunner } from "./fixtures/fake-railway-runner.js";

const SENTINEL_MINTED = "sk-test-DO-NOT-LOG-minted-key";
const SENTINEL_MINTED_HASH = "hash-test-minted-abc123";

function readFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/setup-profile/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * `provisionClientInstance` calls `service list` exactly three times when
 * creating a new service: once before `up` (empty), once after `up` to
 * diff the newly created service in, and once more inside
 * `pollServiceUntilSuccess`'s first poll iteration. The shared fixture
 * holds its last queued response once exhausted, so `[[], [created]]`
 * reproduces that sequence -- same pattern as
 * tests/openclaw-railway-provision-client.test.ts's `freshService`.
 */
function newRunner(variables: Record<string, string> = {}, options: { createdServiceName?: string } = {}): FakeRailwayRunner {
  const runner =
    options.createdServiceName !== undefined
      ? new FakeRailwayRunner([[], [createdService(options.createdServiceName)]])
      : new FakeRailwayRunner();
  runner.setVariableListResponse(variables);
  runner.setDomainList({
    domains: [{ domain: "fixture-onboard.up.railway.app", type: "service", targetPort: 8080 }]
  });
  return runner;
}

function createdService(name: string) {
  return { id: "svc_new", name, latestDeployment: { id: "dep_new", status: "SUCCESS" as const } };
}

function writesOf(runner: FakeRailwayRunner): Array<{ name: string; value?: string; skipDeploys: boolean }> {
  return runner.calls
    .filter((call) => call.args[0] === "variable" && call.args[1] === "set")
    .map((call) => ({
      name: call.args[2] as string,
      skipDeploys: call.args.includes("--skip-deploys"),
      ...(call.stdin !== undefined ? { value: call.stdin } : {})
    }));
}

describe("runRegressionCheck", () => {
  const instanceBaseUrl = "https://fixture.example.up.railway.app";

  function buildFetchStub(options: {
    statusConfigured: boolean;
    healthzStatus: number;
    statusThrows?: boolean;
    calls: string[];
  }): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://openrouter.ai/api/v1/keys") {
        options.calls.push("mint");
        return new Response(JSON.stringify({ key: SENTINEL_MINTED, data: { hash: SENTINEL_MINTED_HASH } }), { status: 200 });
      }
      if (url === `https://openrouter.ai/api/v1/keys/${SENTINEL_MINTED_HASH}`) {
        options.calls.push("delete");
        return new Response(null, { status: 200 });
      }
      if (url === `${instanceBaseUrl}/setup/api/status`) {
        options.calls.push("status");
        if (options.statusThrows) {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(JSON.stringify({ configured: options.statusConfigured }), { status: 200 });
      }
      if (url === `${instanceBaseUrl}/setup/healthz`) {
        options.calls.push("healthz");
        return new Response(options.healthzStatus === 200 ? "ok" : "not ready", { status: options.healthzStatus });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
  }

  it("mints a fresh key, writes it, verifies status+healthz, and deletes the key on success", async () => {
    const calls: string[] = [];
    const runner = newRunner({});
    const fetchImpl = buildFetchStub({ statusConfigured: true, healthzStatus: 200, calls });

    const result = await runRegressionCheck(
      {
        service: "fixture-svc",
        instanceBaseUrl,
        profile: readFixture("key-provisioning-provider.json"),
        setupUsername: "openclaw",
        setupPassword: "sk-test-DO-NOT-LOG-pw"
      },
      { runner, openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl }
    );

    expect(result.passed).toBe(true);
    expect(result.statusConfigured).toBe(true);
    expect(result.healthzStatus).toBe(200);
    expect(result.mintedKeyHash).toBe(SENTINEL_MINTED_HASH);
    expect(result.keyDeleted).toBe(true);
    expect(calls).toEqual(["mint", "status", "healthz", "delete"]);
    expect(writesOf(runner)).toEqual([
      { name: "EXAMPLE_OPENROUTER_MANAGED_API_KEY", value: SENTINEL_MINTED, skipDeploys: true }
    ]);
  });

  it("still deletes the minted key, exactly once, when the status check reports not-configured", async () => {
    const calls: string[] = [];
    const runner = newRunner({});
    const fetchImpl = buildFetchStub({ statusConfigured: false, healthzStatus: 200, calls });

    const result = await runRegressionCheck(
      {
        service: "fixture-svc",
        instanceBaseUrl,
        profile: readFixture("key-provisioning-provider.json"),
        setupUsername: "openclaw",
        setupPassword: "sk-test-DO-NOT-LOG-pw"
      },
      { runner, openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl }
    );

    expect(result.passed).toBe(false);
    expect(result.error).toBeDefined();
    expect(calls.filter((c) => c === "delete")).toHaveLength(1);
  });

  it("guarantees deletion even when the status check throws", async () => {
    const calls: string[] = [];
    const runner = newRunner({});
    const fetchImpl = buildFetchStub({ statusConfigured: true, healthzStatus: 200, statusThrows: true, calls });

    const result = await runRegressionCheck(
      {
        service: "fixture-svc",
        instanceBaseUrl,
        profile: readFixture("key-provisioning-provider.json"),
        setupUsername: "openclaw",
        setupPassword: "sk-test-DO-NOT-LOG-pw"
      },
      { runner, openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl }
    );

    expect(result.passed).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.mintedKeyHash).toBe(SENTINEL_MINTED_HASH);
    expect(result.keyDeleted).toBe(true);
    expect(calls.filter((c) => c === "delete")).toHaveLength(1);
    expect(calls.filter((c) => c === "mint")).toHaveLength(1);
  });

  it("never throws when deletion itself fails, folds the delete failure into the result, and forces passed=false", async () => {
    const calls: string[] = [];
    const runner = newRunner({});
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://openrouter.ai/api/v1/keys") {
        calls.push("mint");
        return new Response(JSON.stringify({ key: SENTINEL_MINTED, data: { hash: SENTINEL_MINTED_HASH } }), { status: 200 });
      }
      if (url === `${instanceBaseUrl}/setup/api/status`) {
        calls.push("status");
        return new Response(JSON.stringify({ configured: true }), { status: 200 });
      }
      if (url === `${instanceBaseUrl}/setup/healthz`) {
        calls.push("healthz");
        return new Response("ok", { status: 200 });
      }
      if (url === `https://openrouter.ai/api/v1/keys/${SENTINEL_MINTED_HASH}`) {
        calls.push("delete-attempt");
        return new Response(null, { status: 401 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await runRegressionCheck(
      {
        service: "fixture-svc",
        instanceBaseUrl,
        profile: readFixture("key-provisioning-provider.json"),
        setupUsername: "openclaw",
        setupPassword: "sk-test-DO-NOT-LOG-pw"
      },
      { runner, openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl }
    );

    // Even though status/healthz both passed, a failed delete forces
    // passed=false and the delete failure's own message survives in
    // `error` -- neither gets silently swallowed by the `finally` block.
    expect(result.passed).toBe(false);
    expect(result.keyDeleted).toBe(false);
    expect(result.statusConfigured).toBe(true);
    expect(result.healthzStatus).toBe(200);
    expect(result.error).toContain("key deletion failed");
    expect(calls).toEqual(["mint", "status", "healthz", "delete-attempt"]);
  });

  it("guarantees deletion even when the Railway variable write itself throws", async () => {
    const calls: string[] = [];
    const runner: RailwayRunner = {
      run: async (args) => {
        if (args[0] === "variable" && args[1] === "set") {
          throw new Error("simulated railway CLI failure");
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };
    const deleteSpy = vi.fn(async () => new Response(null, { status: 200 }));
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://openrouter.ai/api/v1/keys") {
        return new Response(JSON.stringify({ key: SENTINEL_MINTED, data: { hash: SENTINEL_MINTED_HASH } }), { status: 200 });
      }
      if (url === `https://openrouter.ai/api/v1/keys/${SENTINEL_MINTED_HASH}`) {
        calls.push("delete");
        return deleteSpy();
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await runRegressionCheck(
      {
        service: "fixture-svc",
        instanceBaseUrl,
        profile: readFixture("key-provisioning-provider.json"),
        setupUsername: "openclaw",
        setupPassword: "sk-test-DO-NOT-LOG-pw"
      },
      { runner, openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl }
    );

    expect(result.passed).toBe(false);
    expect(result.error).toContain("simulated railway CLI failure");
    expect(calls).toEqual(["delete"]);
    expect(deleteSpy).toHaveBeenCalledOnce();
  });

  it("throws before minting anything when the profile has no keyProvisioning intent", async () => {
    const runner = newRunner({});
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch must not be called");
    }) as unknown as typeof fetch;

    await expect(
      runRegressionCheck(
        {
          service: "fixture-svc",
          instanceBaseUrl,
          profile: readFixture("plain-secret-provider.json"),
          setupUsername: "openclaw",
          setupPassword: "sk-test-DO-NOT-LOG-pw"
        },
        { runner, openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl }
      )
    ).rejects.toThrow("keyProvisioning intent");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("bootstrapOnboardingCycle", () => {
  it("provisions, dry-runs, then applies, in that order, and returns mintedKeyHash", async () => {
    const runner = newRunner({}, { createdServiceName: "fixture-onboard" });
    const calls: string[] = [];
    let configured = false;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://openrouter.ai/api/v1/keys") {
        calls.push("mint");
        return new Response(JSON.stringify({ key: SENTINEL_MINTED, data: { hash: SENTINEL_MINTED_HASH } }), { status: 200 });
      }
      if (url.endsWith("/setup/api/status")) {
        calls.push("status");
        return new Response(JSON.stringify({ configured }), { status: 200 });
      }
      if (url.endsWith("/setup/api/run")) {
        calls.push("run");
        configured = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/setup/healthz")) {
        calls.push("healthz");
        return new Response("ok", { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await bootstrapOnboardingCycle(
      { clientName: "fixture-onboard", profile: readFixture("key-provisioning-provider.json") },
      {
        runner,
        openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt",
        fetchImpl,
        // provisionClientInstance's own readiness poll targets `/setup/api/status`
        // via global `fetch` unless overridden — stub it directly rather than
        // routing it through the setup-applier-side `fetchImpl` above, since
        // that's a distinct injection point (`InstallerDependencies.checkSetupStatus`).
        checkSetupStatus: async () => 200,
        // provisionClientInstance now also runs the #23 post-deploy steps
        // (allowedOrigins patch, device-pairing approve) -- stub both to
        // their "nothing to do" shape so this test stays focused on the
        // bootstrap/apply/mint ordering it actually asserts.
        ...createFakeConfigStore().deps,
        getPendingDevices: async () => ({ ok: true, requestIds: [] }),
        approveDevice: async () => ({ ok: true }),
        // `pollServiceUntilSuccess` sleeps before its first check (real
        // default is 15s) — stub it so the test doesn't wait out a real timer.
        sleep: async () => {}
      }
    );

    expect(result.provision.serviceName).toBe("fixture-onboard");
    expect(result.dryRun.requiredSecrets).toEqual([
      { name: "EXAMPLE_OPENROUTER_MANAGED_API_KEY", present: false }
    ]);
    expect(result.apply.outcome).toBe("applied");
    expect(result.apply.mintedKeyHash).toBe(SENTINEL_MINTED_HASH);
    // Bootstrap never deletes what it mints — a human-supervised step needs
    // the key to still be live after this call returns.
    expect(calls).not.toContain("delete");
    expect(calls.indexOf("status")).toBeLessThan(calls.indexOf("mint"));
    expect(calls.indexOf("mint")).toBeLessThan(calls.indexOf("run"));
  });
});
