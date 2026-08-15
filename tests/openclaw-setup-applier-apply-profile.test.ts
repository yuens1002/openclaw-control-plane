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

/**
 * Fetch stub shared by the mutating-path tests: branches on URL. Tracks
 * "configured" state across calls so a `status` check after `run` reflects
 * whether the simulated instance actually took the config — `run` flips
 * it to `configuredAfterRun` (default true), not just always-true, so a
 * test can also simulate a `run` that completes without taking effect.
 */
function buildFetchStub(options: {
  instanceUrl: string;
  configured: boolean;
  callOrder: string[];
  configuredAfterRun?: boolean;
}): typeof fetch {
  let currentlyConfigured = options.configured;
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${options.instanceUrl}/setup/api/status`) {
      options.callOrder.push("status");
      return new Response(JSON.stringify({ configured: currentlyConfigured }), { status: 200 });
    }
    if (url === `${options.instanceUrl}/setup/api/run`) {
      options.callOrder.push("run");
      currentlyConfigured = options.configuredAfterRun ?? true;
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
      { authChoice: "openrouter", flow: "quickstart", authSecret: "<redacted>" }
    ]);
  });

  it("previews the flat channel-field shape, redacted -- one field per declared secret, not one per channel", async () => {
    const runner = new FakeRailwayRunner({});

    const result = await dryRunApplyProfile(readFixture("slack-channel.json"), { service: "svc" }, { runner });

    expect(result.payloadPreview.channels).toEqual({
      slackBotToken: "<redacted>",
      slackAppToken: "<redacted>"
    });
  });

  it("previews multiple channels in one call as separate top-level fields", async () => {
    const runner = new FakeRailwayRunner({});

    const result = await dryRunApplyProfile(readFixture("multi-channel.json"), { service: "svc" }, { runner });

    expect(result.payloadPreview.channels).toEqual({
      telegramToken: "<redacted>",
      slackBotToken: "<redacted>",
      slackAppToken: "<redacted>"
    });
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

  it("also fails loud on a structurally invalid channel, same as apply mode -- dry-run must not preview a profile that would fail live", async () => {
    const runner = new FakeRailwayRunner({});
    const profile = {
      attachments: {
        modelProviders: [],
        channels: [{ id: "channel-example-irc", type: "irc", requiredSecretNames: ["EXAMPLE_IRC_TOKEN"] }]
      }
    };

    await expect(dryRunApplyProfile(profile, { service: "svc" }, { runner })).rejects.toThrow(
      "Unsupported channel type 'irc'"
    );
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

  it("throws if /setup/api/status still doesn't report configured after run completes", async () => {
    const callOrder: string[] = [];
    const runner = new FakeRailwayRunner({ EXAMPLE_OPENROUTER_MANAGED_API_KEY: SENTINEL_SECRET });
    // configuredAfterRun: false simulates run() returning 2xx without the
    // instance actually taking the config (e.g. a payload-shape mismatch
    // it tolerates rather than rejects).
    const fetchImpl = buildFetchStub({ instanceUrl, configured: false, callOrder, configuredAfterRun: false });
    const setupApiClient = createSetupApiClient({ baseUrl: instanceUrl, fetchImpl });

    await expect(
      applyProfile(
        readFixture("key-provisioning-provider.json"),
        { service: "svc", instanceBaseUrl: instanceUrl },
        { runner, setupApiClient, openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl }
      )
    ).rejects.toThrow("does not report configured");
    expect(callOrder).toEqual(["status", "run", "status"]);
  });

  it("sends a flat payload for a single channel: no channels key, no authGroup key", async () => {
    const callOrder: string[] = [];
    const runner = new FakeRailwayRunner({ EXAMPLE_OPENROUTER_API_KEY: SENTINEL_SECRET, EXAMPLE_TELEGRAM_BOT_TOKEN: "sk-test-DO-NOT-LOG-tg" });
    const fetchImpl = buildFetchStub({ instanceUrl, configured: false, callOrder });
    const requests: Array<{ url: string; body: string }> = [];
    const capturingFetch: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body ?? "") });
      return fetchImpl(input, init);
    };
    const profile = {
      attachments: {
        modelProviders: [
          {
            id: "provider-example-openrouter",
            nonSecretConfig: { authGroup: "openrouter", authChoice: "openrouter", flow: "quickstart" },
            requiredSecretNames: ["EXAMPLE_OPENROUTER_API_KEY"]
          }
        ],
        channels: [{ id: "channel-example-telegram", type: "telegram", requiredSecretNames: ["EXAMPLE_TELEGRAM_BOT_TOKEN"] }]
      }
    };

    await applyProfile(
      profile,
      { service: "svc", instanceBaseUrl: instanceUrl },
      {
        runner,
        setupApiClient: createSetupApiClient({ baseUrl: instanceUrl, fetchImpl: capturingFetch }),
        openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt",
        fetchImpl: capturingFetch
      }
    );

    const runRequest = requests.find((request) => request.url === `${instanceUrl}/setup/api/run`);
    const body = JSON.parse(runRequest?.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({
      authChoice: "openrouter",
      flow: "quickstart",
      authSecret: SENTINEL_SECRET,
      telegramToken: "sk-test-DO-NOT-LOG-tg"
    });
    expect(body).not.toHaveProperty("authGroup");
    expect(body).not.toHaveProperty("channels");
  });

  it("resolves every declared secret for a multi-secret channel, not just the first", async () => {
    const callOrder: string[] = [];
    const runner = new FakeRailwayRunner({
      EXAMPLE_SLACK_BOT_TOKEN: "sk-test-DO-NOT-LOG-bot",
      EXAMPLE_SLACK_APP_TOKEN: "sk-test-DO-NOT-LOG-app"
    });
    const fetchImpl = buildFetchStub({ instanceUrl, configured: false, callOrder });
    const requests: Array<{ url: string; body: string }> = [];
    const capturingFetch: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body ?? "") });
      return fetchImpl(input, init);
    };

    await applyProfile(
      readFixture("slack-channel.json"),
      { service: "svc", instanceBaseUrl: instanceUrl },
      { runner, setupApiClient: createSetupApiClient({ baseUrl: instanceUrl, fetchImpl: capturingFetch }), openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl: capturingFetch }
    );

    const runRequest = requests.find((request) => request.url === `${instanceUrl}/setup/api/run`);
    const body = JSON.parse(runRequest?.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({ slackBotToken: "sk-test-DO-NOT-LOG-bot", slackAppToken: "sk-test-DO-NOT-LOG-app" });
  });

  it("sets multiple channels' fields in a single /setup/api/run call, not multiple calls", async () => {
    const callOrder: string[] = [];
    const runner = new FakeRailwayRunner({
      EXAMPLE_TELEGRAM_BOT_TOKEN: "sk-test-DO-NOT-LOG-tg",
      EXAMPLE_SLACK_BOT_TOKEN: "sk-test-DO-NOT-LOG-bot",
      EXAMPLE_SLACK_APP_TOKEN: "sk-test-DO-NOT-LOG-app"
    });
    const fetchImpl = buildFetchStub({ instanceUrl, configured: false, callOrder });
    const requests: Array<{ url: string; body: string }> = [];
    const capturingFetch: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body ?? "") });
      return fetchImpl(input, init);
    };

    await applyProfile(
      readFixture("multi-channel.json"),
      { service: "svc", instanceBaseUrl: instanceUrl },
      { runner, setupApiClient: createSetupApiClient({ baseUrl: instanceUrl, fetchImpl: capturingFetch }), openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl: capturingFetch }
    );

    const runRequests = requests.filter((request) => request.url === `${instanceUrl}/setup/api/run`);
    expect(runRequests).toHaveLength(1);
    const body = JSON.parse(runRequests[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({
      telegramToken: "sk-test-DO-NOT-LOG-tg",
      slackBotToken: "sk-test-DO-NOT-LOG-bot",
      slackAppToken: "sk-test-DO-NOT-LOG-app"
    });
  });

  it("throws on an unsupported channel type before any network call", async () => {
    const callOrder: string[] = [];
    const runner = new FakeRailwayRunner({});
    const fetchImpl = buildFetchStub({ instanceUrl, configured: false, callOrder });
    const setupApiClient = createSetupApiClient({ baseUrl: instanceUrl, fetchImpl });
    const profile = {
      attachments: {
        modelProviders: [],
        channels: [{ id: "channel-example-irc", type: "irc", requiredSecretNames: ["EXAMPLE_IRC_TOKEN"] }]
      }
    };

    await expect(
      applyProfile(
        profile,
        { service: "svc", instanceBaseUrl: instanceUrl },
        { runner, setupApiClient, openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl }
      )
    ).rejects.toThrow("Unsupported channel type 'irc'");
    expect(callOrder).not.toContain("run");
  });

  it("treats an Object.prototype-named channel type as unsupported, not as a bypass", async () => {
    // channel.type is an untrusted string from the parsed profile; a plain
    // object lookup would return an inherited method (e.g. `toString`)
    // instead of undefined for this "type", silently skipping the
    // unsupported-type check. Regression for that specific bypass class.
    const callOrder: string[] = [];
    const runner = new FakeRailwayRunner({});
    const fetchImpl = buildFetchStub({ instanceUrl, configured: false, callOrder });
    const setupApiClient = createSetupApiClient({ baseUrl: instanceUrl, fetchImpl });
    const profile = {
      attachments: {
        modelProviders: [],
        channels: [{ id: "channel-example-prototype", type: "toString", requiredSecretNames: ["EXAMPLE_TOKEN"] }]
      }
    };

    await expect(
      applyProfile(
        profile,
        { service: "svc", instanceBaseUrl: instanceUrl },
        { runner, setupApiClient, openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl }
      )
    ).rejects.toThrow("Unsupported channel type 'toString'");
    expect(callOrder).not.toContain("run");
  });

  it("throws on a duplicate channel type before any network call", async () => {
    const callOrder: string[] = [];
    const runner = new FakeRailwayRunner({
      EXAMPLE_TELEGRAM_BOT_TOKEN_1: "sk-test-DO-NOT-LOG-tg1",
      EXAMPLE_TELEGRAM_BOT_TOKEN_2: "sk-test-DO-NOT-LOG-tg2"
    });
    const fetchImpl = buildFetchStub({ instanceUrl, configured: false, callOrder });
    const setupApiClient = createSetupApiClient({ baseUrl: instanceUrl, fetchImpl });
    const profile = {
      attachments: {
        modelProviders: [],
        channels: [
          { id: "channel-example-telegram-1", type: "telegram", requiredSecretNames: ["EXAMPLE_TELEGRAM_BOT_TOKEN_1"] },
          { id: "channel-example-telegram-2", type: "telegram", requiredSecretNames: ["EXAMPLE_TELEGRAM_BOT_TOKEN_2"] }
        ]
      }
    };

    await expect(
      applyProfile(
        profile,
        { service: "svc", instanceBaseUrl: instanceUrl },
        { runner, setupApiClient, openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl }
      )
    ).rejects.toThrow("more than one 'telegram' channel attachment");
    expect(callOrder).not.toContain("run");
  });

  it("throws on a slack channel attachment without exactly 2 requiredSecretNames", async () => {
    const callOrder: string[] = [];
    const runner = new FakeRailwayRunner({ EXAMPLE_SLACK_BOT_TOKEN: "sk-test-DO-NOT-LOG-bot" });
    const fetchImpl = buildFetchStub({ instanceUrl, configured: false, callOrder });
    const setupApiClient = createSetupApiClient({ baseUrl: instanceUrl, fetchImpl });
    const profile = {
      attachments: {
        modelProviders: [],
        channels: [{ id: "channel-example-slack", type: "slack", requiredSecretNames: ["EXAMPLE_SLACK_BOT_TOKEN"] }]
      }
    };

    await expect(
      applyProfile(
        profile,
        { service: "svc", instanceBaseUrl: instanceUrl },
        { runner, setupApiClient, openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt", fetchImpl }
      )
    ).rejects.toThrow("'slack' channel attachment must declare exactly 2 requiredSecretNames");
    expect(callOrder).not.toContain("run");
  });

  it("retries the post-redeploy healthcheck instead of failing on the first attempt", async () => {
    const callOrder: string[] = [];
    let healthzAttempts = 0;
    const sleepCalls: number[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === `${instanceUrl}/setup/healthz`) {
        healthzAttempts += 1;
        callOrder.push("healthz");
        return healthzAttempts < 3 ? new Response("not ready", { status: 503 }) : new Response("ok", { status: 200 });
      }
      if (url === `${instanceUrl}/setup/api/status`) {
        callOrder.push("status");
        return new Response(JSON.stringify({ configured: healthzAttempts >= 3 }), { status: 200 });
      }
      if (url === `${instanceUrl}/setup/api/run`) {
        callOrder.push("run");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "https://openrouter.ai/api/v1/keys") {
        callOrder.push("mint");
        return new Response(JSON.stringify({ key: SENTINEL_MINTED }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const runner = new FakeRailwayRunner({});
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
      { service: "svc", instanceBaseUrl: instanceUrl, healthcheckPollSeconds: 0 },
      {
        runner,
        setupApiClient,
        openRouterManagementKey: "sk-test-DO-NOT-LOG-mgmt",
        fetchImpl,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        }
      }
    );

    expect(healthzAttempts).toBe(3);
    expect(sleepCalls).toEqual([0, 0]);
    expect(callOrder.filter((entry) => entry === "run")).toHaveLength(1);
  });
});

function readFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/setup-profile/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}
