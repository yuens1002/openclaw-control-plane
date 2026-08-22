import { describe, expect, it } from "vitest";

import {
  EXPECTED_REF_UNSET,
  updateClientTemplateRef
} from "@openclaw-control-plane/openclaw-railway-installer/provision-client";
import { FakeRailwayRunner } from "./fixtures/fake-railway-runner.js";

const SERVICE = "acme-openclaw";
const OLD_REF = "b9e2467189d02dfe51a80173c40bad650a58eaf2";
const NEW_REF = "c1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4";

function runnerWith(vars: Record<string, string>) {
  // Two service-list responses, in order: the pre-redeploy read that captures
  // the current deployment id, then the post-redeploy poll. They must differ,
  // because the poll now refuses to accept the pre-redeploy deployment as
  // this redeploy's success -- a fake that reports one unchanging id would
  // model a platform that never rolls over.
  const runner = new FakeRailwayRunner([
    [{ id: "svc_acme", name: SERVICE, latestDeployment: { id: "dep_before", status: "SUCCESS" } }],
    [{ id: "svc_acme", name: SERVICE, latestDeployment: { id: "dep_after", status: "SUCCESS" } }]
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

describe("updateClientTemplateRef", () => {
  it("writes and redeploys when the current ref matches what the caller expected", async () => {
    const runner = runnerWith({ OPENCLAW_TEMPLATE_REF: OLD_REF, SETUP_PASSWORD: "setup-secret" });

    const result = await updateClientTemplateRef(
      { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
      { runner, ...READY }
    );

    expect(result).toEqual({ serviceName: SERVICE, templateRef: NEW_REF, changed: true });

    const calls = mutating(runner);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual([
      "variable",
      "set",
      "OPENCLAW_TEMPLATE_REF",
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
    const runner = runnerWith({ OPENCLAW_TEMPLATE_REF: NEW_REF, SETUP_PASSWORD: "setup-secret" });

    const result = await updateClientTemplateRef(
      { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: NEW_REF, pollSeconds: 0 },
      { runner, ...READY }
    );

    // A redeploy is live downtime; a no-op must not buy one.
    expect(result.changed).toBe(false);
    expect(mutating(runner)).toHaveLength(0);
  });

  it("does not report a no-op success when the ref matches but the instance is unhealthy", async () => {
    // The retry-after-failure case: a previous attempt wrote the variable and
    // then failed before the redeploy landed. The variable now matches, but
    // the running deployment may still be the old one -- reporting
    // changed:false here would claim success for an unverified instance.
    const runner = runnerWith({ OPENCLAW_TEMPLATE_REF: NEW_REF, SETUP_PASSWORD: "setup-secret" });

    await expect(
      updateClientTemplateRef(
        { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: NEW_REF, pollSeconds: 0, timeoutMinutes: 0 },
        { runner, sleep: async () => {}, checkSetupStatus: async () => 401 }
      )
    ).rejects.toThrow(/not answering authenticated requests.*forceRedeploy/s);
  });

  it("forceRedeploy redeploys even when the variable already reads as the requested ref", async () => {
    const runner = runnerWith({ OPENCLAW_TEMPLATE_REF: NEW_REF, SETUP_PASSWORD: "setup-secret" });

    const result = await updateClientTemplateRef(
      {
        service: SERVICE,
        templateRef: NEW_REF,
        expectedCurrentRef: NEW_REF,
        forceRedeploy: true,
        pollSeconds: 0
      },
      { runner, ...READY }
    );

    expect(result.changed).toBe(true);
    expect(mutating(runner).some((c) => c.args[0] === "redeploy")).toBe(true);
  });

  it("the documented recovery invocation succeeds: force plus the already-written ref as expected", async () => {
    // Mirrors the README exactly. A previous attempt wrote NEW_REF and then
    // failed, so the live value is already the target.
    const runner = runnerWith({ OPENCLAW_TEMPLATE_REF: NEW_REF, SETUP_PASSWORD: "setup-secret" });

    const result = await updateClientTemplateRef(
      {
        service: SERVICE,
        templateRef: NEW_REF,
        expectedCurrentRef: NEW_REF,
        forceRedeploy: true,
        pollSeconds: 0
      },
      { runner, ...READY }
    );

    expect(result.changed).toBe(true);
  });

  it("force does not disable the expected-ref check", async () => {
    // Passing the pre-failure value with force must still be refused -- the
    // variable now holds the target, so that expectation is simply false.
    const runner = runnerWith({ OPENCLAW_TEMPLATE_REF: NEW_REF, SETUP_PASSWORD: "setup-secret" });

    await expect(
      updateClientTemplateRef(
        {
          service: SERVICE,
          templateRef: NEW_REF,
          expectedCurrentRef: OLD_REF,
          forceRedeploy: true,
          pollSeconds: 0
        },
        { runner, ...READY }
      )
    ).rejects.toThrow(/expected it to currently be/);
  });

  it("refuses to overwrite when the current ref is not what the caller expected", async () => {
    const runner = runnerWith({ OPENCLAW_TEMPLATE_REF: "v-something-else", SETUP_PASSWORD: "setup-secret" });

    await expect(
      updateClientTemplateRef(
        { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
        { runner, ...READY }
      )
    ).rejects.toThrow(/expected it to currently be/);

    // Nothing was written and nothing was redeployed.
    expect(mutating(runner)).toHaveLength(0);
  });

  it("refuses when the variable is unset but the caller expected a concrete ref", async () => {
    const runner = runnerWith({ SETUP_PASSWORD: "setup-secret" });

    await expect(
      updateClientTemplateRef(
        { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
        { runner, ...READY }
      )
    ).rejects.toThrow(/the variable is not set at all/);
    expect(mutating(runner)).toHaveLength(0);
  });

  it("bootstraps a client that has no OPENCLAW_TEMPLATE_REF yet when the caller declares it unset", async () => {
    // provisionClientInstance never writes this variable, so every freshly
    // provisioned client starts here. Refusing outright would make the first
    // version bump impossible.
    const runner = runnerWith({ SETUP_PASSWORD: "setup-secret" });

    const result = await updateClientTemplateRef(
      { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: EXPECTED_REF_UNSET, pollSeconds: 0 },
      { runner, ...READY }
    );

    expect(result.changed).toBe(true);
    expect(mutating(runner)).toHaveLength(2);
  });

  it("refuses when the caller declared it unset but it actually has a value", async () => {
    const runner = runnerWith({ OPENCLAW_TEMPLATE_REF: OLD_REF, SETUP_PASSWORD: "setup-secret" });

    await expect(
      updateClientTemplateRef(
        { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: EXPECTED_REF_UNSET, pollSeconds: 0 },
        { runner, ...READY }
      )
    ).rejects.toThrow(/caller expected it to be unset/);
    expect(mutating(runner)).toHaveLength(0);
  });

  it("fails loudly, naming the completed change, when the instance never becomes ready", async () => {
    const runner = runnerWith({ OPENCLAW_TEMPLATE_REF: OLD_REF, SETUP_PASSWORD: "setup-secret" });

    // Deployment reports SUCCESS but the instance never answers an
    // authenticated request -- the exact case a status-only poll misses.
    await expect(
      updateClientTemplateRef(
        { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0, timeoutMinutes: 0 },
        { runner, sleep: async () => {}, checkSetupStatus: async () => 401 }
      )
    ).rejects.toThrow(/Setup readiness check/);

    // The write and redeploy did happen, so the operator must be able to
    // tell that the instance was changed and is unverified, not untouched.
    expect(mutating(runner)).toHaveLength(2);
  });

  it("refuses before writing when the current deployment id cannot be read", async () => {
    // Without it the poll cannot tell this redeploy apart from the one
    // already running, so it would accept the old deployment's success.
    const runner = new FakeRailwayRunner([[{ id: "svc_acme", name: SERVICE }]]);
    runner.setVariableListResponse({ OPENCLAW_TEMPLATE_REF: OLD_REF, SETUP_PASSWORD: "setup-secret" });

    await expect(
      updateClientTemplateRef(
        { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
        { runner, ...READY }
      )
    ).rejects.toThrow(/current deployment id could not be read/);
    // Crucially: nothing was changed before refusing.
    expect(mutating(runner)).toHaveLength(0);
  });

  it("fails when readiness passes but the ref did not actually land", async () => {
    const runner = runnerWith({ OPENCLAW_TEMPLATE_REF: OLD_REF, SETUP_PASSWORD: "setup-secret" });
    const inner = runner.run.bind(runner);
    // Accept the write, but never let it take effect -- a healthy instance
    // running the wrong ref must not be reported as a successful update.
    runner.run = async (args: string[], stdin?: string) => {
      if (args[0] === "variable" && args[1] === "set") {
        return { stdout: "[]" };
      }
      return inner(args, stdin);
    };

    await expect(
      updateClientTemplateRef(
        { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
        { runner, ...READY }
      )
    ).rejects.toThrow(/reads back as '.*', not '.*'/);
  });

  it("still reports the change as live when the redeploy itself fails", async () => {
    const runner = runnerWith({ OPENCLAW_TEMPLATE_REF: OLD_REF, SETUP_PASSWORD: "setup-secret" });
    const inner = runner.run.bind(runner);
    runner.run = async (args: string[], stdin?: string) => {
      if (args[0] === "redeploy") {
        throw new Error("railway exploded");
      }
      return inner(args, stdin);
    };

    await expect(
      updateClientTemplateRef(
        { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
        { runner, ...READY }
      )
    ).rejects.toThrow(/WAS updated to '.*', but the instance is not confirmed healthy.*railway exploded/s);
  });

  it("reports the change but flags unverifiable readiness when the service has no SETUP_PASSWORD", async () => {
    const runner = runnerWith({ OPENCLAW_TEMPLATE_REF: OLD_REF });

    await expect(
      updateClientTemplateRef(
        { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
        { runner, ...READY }
      )
    ).rejects.toThrow(/WAS updated to '.*', but the instance is not confirmed healthy/);
  });
});
