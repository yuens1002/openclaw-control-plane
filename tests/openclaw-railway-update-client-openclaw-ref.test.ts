import { describe, expect, it } from "vitest";

import { updateClientOpenClawRef } from "@openclaw-control-plane/openclaw-railway-installer/provision-client";
import { FakeRailwayRunner } from "./fixtures/fake-railway-runner.js";

const SERVICE = "acme-openclaw";
const OLD_REF = "v2026.6.0-1";
const NEW_REF = "v2026.7.1-2";

function runnerWith(vars: Record<string, string>) {
  const runner = new FakeRailwayRunner([
    [{ id: "svc_acme", name: SERVICE, latestDeployment: { id: "dep_new", status: "SUCCESS" } }]
  ]);
  runner.setVariableListResponse(vars);
  return runner;
}

const READY = { sleep: async () => {}, checkSetupStatus: async () => 200 };

function mutating(runner: FakeRailwayRunner) {
  return runner.calls.filter(
    (c) => !(c.args[0] === "service" && c.args[1] === "list") && !(c.args[0] === "variable" && c.args[1] === "list") && c.args[0] !== "domain"
  );
}

describe("updateClientOpenClawRef", () => {
  it("writes and redeploys when the current ref matches what the caller expected", async () => {
    const runner = runnerWith({ OPENCLAW_GIT_REF: OLD_REF, SETUP_PASSWORD: "setup-secret" });

    const result = await updateClientOpenClawRef(
      { service: SERVICE, openclawRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
      { runner, ...READY }
    );

    expect(result).toEqual({ serviceName: SERVICE, openclawRef: NEW_REF, changed: true });

    const calls = mutating(runner);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual([
      "variable",
      "set",
      "OPENCLAW_GIT_REF",
      "--service",
      SERVICE,
      "--skip-deploys",
      "--stdin",
      "--json"
    ]);
    expect(calls[0]?.stdin).toBe(NEW_REF);
    expect(calls[1]?.args).toEqual(["redeploy", "--service", SERVICE, "--yes", "--json"]);

    // Scoping guarantee: nothing addressed a different service.
    for (const call of runner.calls) {
      const i = call.args.indexOf("--service");
      if (i >= 0) {
        expect(call.args[i + 1]).toBe(SERVICE);
      }
    }
  });

  it("does not redeploy when the service is already at the requested ref", async () => {
    const runner = runnerWith({ OPENCLAW_GIT_REF: NEW_REF, SETUP_PASSWORD: "setup-secret" });

    const result = await updateClientOpenClawRef(
      { service: SERVICE, openclawRef: NEW_REF, expectedCurrentRef: NEW_REF, pollSeconds: 0 },
      { runner, ...READY }
    );

    // A redeploy is live downtime; a no-op must not buy one.
    expect(result.changed).toBe(false);
    expect(mutating(runner)).toHaveLength(0);
  });

  it("refuses to overwrite when the current ref is not what the caller expected", async () => {
    const runner = runnerWith({ OPENCLAW_GIT_REF: "v-something-else", SETUP_PASSWORD: "setup-secret" });

    await expect(
      updateClientOpenClawRef(
        { service: SERVICE, openclawRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
        { runner, ...READY }
      )
    ).rejects.toThrow(/expected it to currently be/);

    // Nothing was written and nothing was redeployed.
    expect(mutating(runner)).toHaveLength(0);
  });

  it("refuses when the variable is not set at all, rather than treating it as a first write", async () => {
    const runner = runnerWith({ SETUP_PASSWORD: "setup-secret" });

    await expect(
      updateClientOpenClawRef(
        { service: SERVICE, openclawRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
        { runner, ...READY }
      )
    ).rejects.toThrow(/has no OPENCLAW_GIT_REF variable set/);
    expect(mutating(runner)).toHaveLength(0);
  });

  it("fails loudly, naming the completed change, when the instance never becomes ready", async () => {
    const runner = runnerWith({ OPENCLAW_GIT_REF: OLD_REF, SETUP_PASSWORD: "setup-secret" });

    // Deployment reports SUCCESS but the instance never answers an
    // authenticated request -- the exact case a status-only poll misses.
    await expect(
      updateClientOpenClawRef(
        { service: SERVICE, openclawRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0, timeoutMinutes: 0 },
        { runner, sleep: async () => {}, checkSetupStatus: async () => 401 }
      )
    ).rejects.toThrow(/Setup readiness check/);

    // The write and redeploy did happen, so the operator must be able to
    // tell that the instance was changed and is unverified, not untouched.
    expect(mutating(runner)).toHaveLength(2);
  });

  it("still reports the change as live when the redeploy itself fails", async () => {
    const runner = runnerWith({ OPENCLAW_GIT_REF: OLD_REF, SETUP_PASSWORD: "setup-secret" });
    const inner = runner.run.bind(runner);
    runner.run = async (args: string[], stdin?: string) => {
      if (args[0] === "redeploy") {
        throw new Error("railway exploded");
      }
      return inner(args, stdin);
    };

    await expect(
      updateClientOpenClawRef(
        { service: SERVICE, openclawRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
        { runner, ...READY }
      )
    ).rejects.toThrow(/WAS updated to '.*', but the instance is not confirmed healthy.*railway exploded/s);
  });

  it("reports the change but flags unverifiable readiness when the service has no SETUP_PASSWORD", async () => {
    const runner = runnerWith({ OPENCLAW_GIT_REF: OLD_REF });

    await expect(
      updateClientOpenClawRef(
        { service: SERVICE, openclawRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
        { runner, ...READY }
      )
    ).rejects.toThrow(/WAS updated to '.*', but the instance is not confirmed healthy/);
  });
});
