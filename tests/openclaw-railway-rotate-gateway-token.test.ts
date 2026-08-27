import { describe, expect, it } from "vitest";

import { rotateGatewayToken } from "@openclaw-control-plane/openclaw-railway-installer/provision-client";
import { FakeRailwayRunner } from "./fixtures/fake-railway-runner.js";

const SERVICE = "acme-openclaw";
const OLD_TOKEN = "old-gateway-token-value";

function runnerWith(vars: Record<string, string>) {
  // Two service-list responses, in order: the pre-redeploy read that captures
  // the current deployment id, then the post-redeploy poll. They must differ,
  // the same reason updateClientTemplateRef's tests do -- a fake that reports
  // one unchanging id would model a platform that never rolls over.
  const runner = new FakeRailwayRunner([
    [{ id: "svc_acme", name: SERVICE, latestDeployment: { id: "dep_before", status: "SUCCESS" } }],
    [{ id: "svc_acme", name: SERVICE, latestDeployment: { id: "dep_after", status: "SUCCESS" } }]
  ]);
  runner.setVariableListResponse(vars);
  return runner;
}

const READY = { sleep: async () => {}, checkSetupStatus: async () => 200 };

const READ_ONLY_CALLS = [
  ["service", "list"],
  ["variable", "list"],
  ["domain", "list"]
];

function mutating(runner: FakeRailwayRunner) {
  return runner.calls.filter((c) => !READ_ONLY_CALLS.some(([a, b]) => c.args[0] === a && c.args[1] === b));
}

describe("rotateGatewayToken", () => {
  it("writes a fresh token, redeploys, and confirms readiness -- without ever returning or logging the new value", async () => {
    const runner = runnerWith({ OPENCLAW_GATEWAY_TOKEN: OLD_TOKEN, SETUP_PASSWORD: "setup-secret" });

    const result = await rotateGatewayToken({ service: SERVICE, pollSeconds: 0 }, { runner, ...READY });

    expect(result).toEqual({ serviceName: SERVICE, newDeploymentReady: true });
    // The result object is the only thing a caller sees; it must not carry
    // the rotated value under any key.
    expect(JSON.stringify(result)).not.toContain(OLD_TOKEN);

    const calls = mutating(runner);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual([
      "variable",
      "set",
      "OPENCLAW_GATEWAY_TOKEN",
      "--service",
      SERVICE,
      "--skip-deploys",
      "--stdin",
      "--json"
    ]);
    // The written value must be a fresh secret, not the old one and not empty.
    expect(calls[0]?.stdin).toBeTruthy();
    expect(calls[0]?.stdin).not.toBe(OLD_TOKEN);
    expect(calls[1]?.args).toEqual(["redeploy", "--service", SERVICE, "--yes", "--json"]);

    // Scoping guarantee: nothing addressed a different service.
    for (const call of runner.calls) {
      const i = call.args.indexOf("--service");
      if (i >= 0) {
        expect(call.args[i + 1]).toBe(SERVICE);
      }
    }
  });

  it("generates a different value on every call -- rotation is never a no-op", async () => {
    const seen = new Set<string | undefined>();
    for (let i = 0; i < 3; i += 1) {
      const runner = runnerWith({ OPENCLAW_GATEWAY_TOKEN: OLD_TOKEN, SETUP_PASSWORD: "setup-secret" });
      await rotateGatewayToken({ service: SERVICE, pollSeconds: 0 }, { runner, ...READY });
      seen.add(mutating(runner)[0]?.stdin);
    }
    expect(seen.size).toBe(3);
  });

  it("refuses when the service has no OPENCLAW_GATEWAY_TOKEN at all", async () => {
    const runner = runnerWith({ SETUP_PASSWORD: "setup-secret" });

    await expect(
      rotateGatewayToken({ service: SERVICE, pollSeconds: 0 }, { runner, ...READY })
    ).rejects.toThrow(/nothing to rotate/);
    expect(mutating(runner)).toHaveLength(0);
  });

  it("refuses before writing when the current deployment id cannot be read", async () => {
    const runner = new FakeRailwayRunner([[{ id: "svc_acme", name: SERVICE }]]);
    runner.setVariableListResponse({ OPENCLAW_GATEWAY_TOKEN: OLD_TOKEN, SETUP_PASSWORD: "setup-secret" });

    await expect(
      rotateGatewayToken({ service: SERVICE, pollSeconds: 0 }, { runner, ...READY })
    ).rejects.toThrow(/current deployment id could not be read/);
    expect(mutating(runner)).toHaveLength(0);
  });

  it("fails loudly, naming the completed change, when the instance never becomes ready", async () => {
    const runner = runnerWith({ OPENCLAW_GATEWAY_TOKEN: OLD_TOKEN, SETUP_PASSWORD: "setup-secret" });

    await expect(
      rotateGatewayToken(
        { service: SERVICE, pollSeconds: 0, timeoutMinutes: 0 },
        { runner, sleep: async () => {}, checkSetupStatus: async () => 401 }
      )
    ).rejects.toThrow(/WAS rotated, but the instance is not confirmed healthy/);

    // The write and redeploy did happen, so the operator must be able to
    // tell that the instance was changed and is unverified, not untouched.
    expect(mutating(runner)).toHaveLength(2);
  });

  it("diagnoses a token that did not take as a rotation problem, not an unhealthy instance", async () => {
    const runner = runnerWith({ OPENCLAW_GATEWAY_TOKEN: OLD_TOKEN, SETUP_PASSWORD: "setup-secret" });
    const inner = runner.run.bind(runner);
    // Accept the write, but never let it take effect.
    runner.run = async (args: string[], stdin?: string) => {
      if (args[0] === "variable" && args[1] === "set") {
        return { stdout: "[]" };
      }
      return inner(args, stdin);
    };

    const error = await rotateGatewayToken({ service: SERVICE, pollSeconds: 0 }, { runner, ...READY }).catch(
      (caught: unknown) => caught
    );

    expect(String(error)).toMatch(/rotation is unconfirmed/);
    expect(String(error)).not.toMatch(/not confirmed healthy/);
  });

  it("treats a failed verification read as a rotation problem, not an unhealthy instance", async () => {
    // Readiness already passed; only the confirming read failed. Reporting
    // that as a health problem would misdirect recovery.
    const runner = runnerWith({ OPENCLAW_GATEWAY_TOKEN: OLD_TOKEN, SETUP_PASSWORD: "setup-secret" });
    const inner = runner.run.bind(runner);
    let listCalls = 0;
    runner.run = async (args: string[], stdin?: string) => {
      if (args[0] === "variable" && args[1] === "list") {
        listCalls += 1;
        // Three variable-list reads happen: the current token, SETUP_PASSWORD
        // for readiness, then the confirming readback. Fail only the last.
        if (listCalls >= 3) {
          throw new Error("transient variable-list failure");
        }
      }
      return inner(args, stdin);
    };

    const error = await rotateGatewayToken({ service: SERVICE, pollSeconds: 0 }, { runner, ...READY }).catch(
      (caught: unknown) => caught
    );

    expect(String(error)).toMatch(/reading the variable back to confirm it failed/);
    expect(String(error)).not.toMatch(/not confirmed healthy/);
  });

  it("still reports the change as live when the redeploy itself fails", async () => {
    const runner = runnerWith({ OPENCLAW_GATEWAY_TOKEN: OLD_TOKEN, SETUP_PASSWORD: "setup-secret" });
    const inner = runner.run.bind(runner);
    runner.run = async (args: string[], stdin?: string) => {
      if (args[0] === "redeploy") {
        throw new Error("railway exploded");
      }
      return inner(args, stdin);
    };

    await expect(
      rotateGatewayToken({ service: SERVICE, pollSeconds: 0 }, { runner, ...READY })
    ).rejects.toThrow(/WAS rotated, but the instance is not confirmed healthy.*railway exploded/s);
  });

  it("authenticates readiness with a custom setup username when one is given", async () => {
    const runner = runnerWith({ OPENCLAW_GATEWAY_TOKEN: OLD_TOKEN, SETUP_PASSWORD: "setup-secret" });
    const seen: Array<{ username: string; password: string }> = [];

    await rotateGatewayToken(
      { service: SERVICE, setupUsername: "custom-admin", pollSeconds: 0 },
      {
        runner,
        sleep: async () => {},
        checkSetupStatus: async (_url, auth) => {
          seen.push(auth);
          return 200;
        }
      }
    );

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.username).toBe("custom-admin");
  });
});
