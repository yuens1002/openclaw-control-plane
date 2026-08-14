import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { CommandResult, RailwayRunner } from "@openclaw-control-plane/openclaw-railway-installer";
import {
  applyProfile,
  dryRunApplyProfile,
  printDryRunResult
} from "@openclaw-control-plane/openclaw-setup-applier/apply-profile";
import { createSetupApiClient } from "@openclaw-control-plane/openclaw-setup-applier/setup-api-client";

const SENTINEL_SECRET = "sk-test-DO-NOT-LOG-9f8e7d";
const SENTINEL_MINTED = "sk-test-DO-NOT-LOG-minted-key";

class FakeRailwayRunner implements RailwayRunner {
  readonly writes: Array<{ name: string; value?: string; skipDeploys: boolean }> = [];
  constructor(private readonly variables: Record<string, string>) {}

  async run(args: string[], stdin?: string): Promise<CommandResult> {
    if (args[0] === "variable" && args[1] === "list") {
      return { stdout: JSON.stringify(this.variables) };
    }
    if (args[0] === "variable" && args[1] === "set") {
      const name = args[2];
      if (name === undefined) {
        throw new Error("Missing variable name in write args.");
      }
      this.writes.push({
        name,
        skipDeploys: args.includes("--skip-deploys"),
        ...(stdin !== undefined ? { value: stdin } : {})
      });
      this.variables[name] = stdin ?? "";
      return { stdout: JSON.stringify({ ok: true }) };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  }
}

/** Fetch stub shared by the mutating-path tests: branches on URL. */
function buildFetchStub(options: {
  instanceUrl: string;
  configured: boolean;
  callOrder: string[];
}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${options.instanceUrl}/setup/api/status`) {
      options.callOrder.push("status");
      return new Response(JSON.stringify({ configured: options.configured }), { status: 200 });
    }
    if (url === `${options.instanceUrl}/setup/api/run`) {
      options.callOrder.push("run");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url === `${options.instanceUrl}/setup/healthz`) {
      options.callOrder.push("healthz");
      return new Response("ok", { status: 200 });
    }
    if (url === "https://openrouter.ai/api/v1/keys") {
      options.callOrder.push("mint");
      return new Response(JSON.stringify({ key: SENTINEL_MINTED }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

describe("apply-profile dry-run mode", () => {
  it("reports a required secret as present when it exists in Railway variables", async () => {
    const runner = new FakeRailwayRunner({ EXAMPLE_OPENROUTER_API_KEY: SENTINEL_SECRET });

    const result = await dryRunApplyProfile(readFixture("plain-secret-provider.json"), { service: "svc" }, { runner });

    expect(result.requiredSecrets).toEqual([{ name: "EXAMPLE_OPENROUTER_API_KEY", present: true }]);
  });

  it("reports a required secret as missing when it isn't set", async () => {
    const runner = new FakeRailwayRunner({});

    const result = await dryRunApplyProfile(readFixture("plain-secret-provider.json"), { service: "svc" }, { runner });

    expect(result.requiredSecrets).toEqual([{ name: "EXAMPLE_OPENROUTER_API_KEY", present: false }]);
  });

  it("builds a redacted payload preview with no real secret values", async () => {
    const runner = new FakeRailwayRunner({ EXAMPLE_OPENROUTER_API_KEY: SENTINEL_SECRET });

    const result = await dryRunApplyProfile(readFixture("plain-secret-provider.json"), { service: "svc" }, { runner });

    expect(result.payloadPreview.providers).toEqual([
      { authGroup: "openrouter", authChoice: "openrouter", flow: "quickstart", authSecret: "<redacted>" }
    ]);
  });

  it("never prints a real secret value when the result is printed", async () => {
    const runner = new FakeRailwayRunner({ EXAMPLE_OPENROUTER_API_KEY: SENTINEL_SECRET });
    const result = await dryRunApplyProfile(readFixture("plain-secret-provider.json"), { service: "svc" }, { runner });

    const originalLog = console.log;
    const logged: string[] = [];
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      printDryRunResult(result);
    } finally {
      console.log = originalLog;
    }

    expect(logged.some((line) => line.includes(SENTINEL_SECRET))).toBe(false);
  });
});

describe("apply-profile apply mode", () => {
  const instanceUrl = "https://example-openclaw.example.com";

  it("skips /setup/api/run entirely when the instance already reports configured", async () => {
    const callOrder: string[] = [];
    const runner = new FakeRailwayRunner({ EXAMPLE_OPENROUTER_API_KEY: SENTINEL_SECRET });
    const fetchImpl = buildFetchStub({ instanceUrl, configured: true, callOrder });
    const setupApiClient = createSetupApiClient({ baseUrl: instanceUrl, fetchImpl });

    const result = await applyProfile(
      readFixture("plain-secret-provider.json"),
      { service: "svc", instanceBaseUrl: instanceUrl },
      { runner, setupApiClient, openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl }
    );

    expect(result.outcome).toBe("already-configured");
    expect(callOrder).toEqual(["status"]);
  });

  it("skips minting when the required secret is already present in Railway variables", async () => {
    const callOrder: string[] = [];
    const runner = new FakeRailwayRunner({ EXAMPLE_OPENROUTER_MANAGED_API_KEY: SENTINEL_SECRET });
    const fetchImpl = buildFetchStub({ instanceUrl, configured: false, callOrder });
    const setupApiClient = createSetupApiClient({ baseUrl: instanceUrl, fetchImpl });

    const result = await applyProfile(
      readFixture("key-provisioning-provider.json"),
      { service: "svc", instanceBaseUrl: instanceUrl },
      { runner, setupApiClient, openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl }
    );

    expect(result.outcome).toBe("applied");
    expect(callOrder).not.toContain("mint");
    expect(runner.writes).toHaveLength(0);
  });

  it("mints, writes with --skip-deploys, and never re-healthchecks for a plain provider", async () => {
    const callOrder: string[] = [];
    const runner = new FakeRailwayRunner({});
    const fetchImpl = buildFetchStub({ instanceUrl, configured: false, callOrder });
    const setupApiClient = createSetupApiClient({ baseUrl: instanceUrl, fetchImpl });

    await applyProfile(
      readFixture("key-provisioning-provider.json"),
      { service: "svc", instanceBaseUrl: instanceUrl },
      { runner, setupApiClient, openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl }
    );

    expect(callOrder).not.toContain("healthz");
    expect(runner.writes).toEqual([
      { name: "EXAMPLE_OPENROUTER_MANAGED_API_KEY", value: SENTINEL_MINTED, skipDeploys: true }
    ]);
    expect(callOrder.indexOf("mint")).toBeLessThan(callOrder.indexOf("run"));
  });

  it("omits --skip-deploys and re-healthchecks before run for a customProviderApiKeyEnv attachment", async () => {
    const callOrder: string[] = [];
    const runner = new FakeRailwayRunner({});
    const fetchImpl = buildFetchStub({ instanceUrl, configured: false, callOrder });
    const setupApiClient = createSetupApiClient({ baseUrl: instanceUrl, fetchImpl });
    const customProfile = {
      attachments: {
        modelProviders: [
          {
            id: "provider-example-custom",
            nonSecretConfig: {
              authGroup: "openrouter",
              authChoice: "openrouter",
              flow: "advanced",
              customProviderApiKeyEnv: "EXAMPLE_CUSTOM_PROVIDER_KEY",
              keyProvisioning: { method: "openrouter-provisioning-api", spendLimitUsd: 10, limitReset: "monthly" }
            },
            requiredSecretNames: ["EXAMPLE_CUSTOM_PROVIDER_KEY"]
          }
        ],
        channels: []
      }
    };

    await applyProfile(
      customProfile,
      { service: "svc", instanceBaseUrl: instanceUrl },
      { runner, setupApiClient, openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl }
    );

    expect(runner.writes).toEqual([
      { name: "EXAMPLE_CUSTOM_PROVIDER_KEY", value: SENTINEL_MINTED, skipDeploys: false }
    ]);
    expect(callOrder).toContain("healthz");
    expect(callOrder.indexOf("healthz")).toBeLessThan(callOrder.indexOf("run"));
  });

  it("never logs a real secret value across a full stubbed mint-and-apply run", async () => {
    const callOrder: string[] = [];
    const runner = new FakeRailwayRunner({});
    const fetchImpl = buildFetchStub({ instanceUrl, configured: false, callOrder });
    const setupApiClient = createSetupApiClient({ baseUrl: instanceUrl, fetchImpl });

    const originalLog = console.log;
    const originalError = console.error;
    const logged: string[] = [];
    console.log = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    try {
      await applyProfile(
        readFixture("key-provisioning-provider.json"),
        { service: "svc", instanceBaseUrl: instanceUrl },
        { runner, setupApiClient, openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl }
      );
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    expect(logged.some((line) => line.includes(SENTINEL_MINTED))).toBe(false);
    expect(logged.some((line) => line.includes("sk-test-DO-NOT-LOG-mgmt"))).toBe(false);
  });

  it("throws rather than silently applying only the first of multiple model providers", async () => {
    const callOrder: string[] = [];
    const runner = new FakeRailwayRunner({});
    const fetchImpl = buildFetchStub({ instanceUrl, configured: false, callOrder });
    const setupApiClient = createSetupApiClient({ baseUrl: instanceUrl, fetchImpl });
    const twoProviderProfile = {
      attachments: {
        modelProviders: [
          {
            id: "provider-example-first",
            nonSecretConfig: { authGroup: "openrouter", authChoice: "openrouter", flow: "quickstart" },
            requiredSecretNames: ["EXAMPLE_FIRST_KEY"]
          },
          {
            id: "provider-example-second",
            nonSecretConfig: { authGroup: "anthropic", authChoice: "apiKey", flow: "quickstart" },
            requiredSecretNames: ["EXAMPLE_SECOND_KEY"]
          }
        ],
        channels: []
      }
    };

    await expect(
      applyProfile(
        twoProviderProfile,
        { service: "svc", instanceBaseUrl: instanceUrl },
        { runner, setupApiClient, openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl }
      )
    ).rejects.toThrow("2 modelProviders attachments");
    expect(callOrder).not.toContain("run");
  });
});

function readFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/setup-profile/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}
