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

// Counts calls that change live state. Only the exact read-only shapes are
// excluded -- notably `domain list` rather than every `domain` command, so a
// regression that mutated domain routing (`domain update`, domain generation)
// still shows up in the "zero mutating calls" assertions instead of being
// filtered away with the reads.
const READ_ONLY_CALLS = [
  ["service", "list"],
  ["variable", "list"],
  ["domain", "list"]
];

function mutating(runner: FakeRailwayRunner) {
  return runner.calls.filter(
    (c) => !READ_ONLY_CALLS.some(([a, b]) => c.args[0] === a && c.args[1] === b)
  );
}

describe("updateClientTemplateRef", () => {
  it("writes and redeploys when the current ref matches what the caller expected", async () => {
    const runner = runnerWith({ OPENCLAW_TEMPLATE_REF: OLD_REF, SETUP_PASSWORD: "setup-secret" });

    const result = await updateClientTemplateRef(
      { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
      { runner, ...READY }
    );

    expect(result).toEqual({
      serviceName: SERVICE,
      templateRef: NEW_REF,
      changed: true,
      // A new deployment was observed reaching SUCCESS, then serving, and
      // the variable read back as the requested ref. That is all this flag
      // claims -- not that the running build was made from it.
      newDeploymentReady: true
    });

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
    // ...and must not claim a new deployment was verified, because none
    // was: no redeploy happened on this path.
    expect(result.newDeploymentReady).toBe(false);
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

  it("recovers a client whose existing deployment is already in a terminal state", async () => {
    // The guard must ignore a terminal status on the *pre-redeploy*
    // deployment, or a broken client could never be fixed by bumping its ref.
    const runner = new FakeRailwayRunner([
      [{ id: "svc_acme", name: SERVICE, latestDeployment: { id: "dep_before", status: "CRASHED" } }],
      [{ id: "svc_acme", name: SERVICE, latestDeployment: { id: "dep_after", status: "SUCCESS" } }]
    ]);
    runner.setVariableListResponse({ OPENCLAW_TEMPLATE_REF: OLD_REF, SETUP_PASSWORD: "setup-secret" });

    const result = await updateClientTemplateRef(
      { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
      { runner, ...READY }
    );

    expect(result.changed).toBe(true);
  });

  it("still surfaces a terminal failure on the new deployment", async () => {
    // The recovery allowance must not swallow a genuine new-build failure.
    const runner = new FakeRailwayRunner([
      [{ id: "svc_acme", name: SERVICE, latestDeployment: { id: "dep_before", status: "SUCCESS" } }],
      [{ id: "svc_acme", name: SERVICE, latestDeployment: { id: "dep_after", status: "CRASHED" } }]
    ]);
    runner.setVariableListResponse({ OPENCLAW_TEMPLATE_REF: OLD_REF, SETUP_PASSWORD: "setup-secret" });

    await expect(
      updateClientTemplateRef(
        { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
        { runner, ...READY }
      )
    ).rejects.toThrow(/terminal state 'CRASHED'/);
  });

  it("refuses a no-op when the caller's expected ref is stale, even though the value already matches", async () => {
    // Reaching the already-up-to-date branch with a wrong expectation must
    // not report success -- the README's recovery guidance depends on this.
    const runner = runnerWith({ OPENCLAW_TEMPLATE_REF: NEW_REF, SETUP_PASSWORD: "setup-secret" });

    await expect(
      updateClientTemplateRef(
        { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
        { runner, ...READY }
      )
    ).rejects.toThrow(/already up to date.*caller expected/s);
    expect(mutating(runner)).toHaveLength(0);
  });

  it("authenticates readiness with a custom setup username when one is given", async () => {
    // Every other test here uses a stub that discards the auth object, so a
    // regression to the default username would silently break custom-auth
    // clients while the suite stayed green.
    const runner = runnerWith({ OPENCLAW_TEMPLATE_REF: OLD_REF, SETUP_PASSWORD: "setup-secret" });
    const seen: Array<{ username: string; password: string }> = [];

    await updateClientTemplateRef(
      {
        service: SERVICE,
        templateRef: NEW_REF,
        expectedCurrentRef: OLD_REF,
        setupUsername: "custom-admin",
        pollSeconds: 0
      },
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
    expect(seen[0]?.password).toBe("setup-secret");
  });

  it("falls back to the default setup username when none is given", async () => {
    const runner = runnerWith({ OPENCLAW_TEMPLATE_REF: OLD_REF, SETUP_PASSWORD: "setup-secret" });
    const seen: Array<{ username: string; password: string }> = [];

    await updateClientTemplateRef(
      { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
      {
        runner,
        sleep: async () => {},
        checkSetupStatus: async (_url, auth) => {
          seen.push(auth);
          return 200;
        }
      }
    );

    expect(seen[0]?.username).toBe("openclaw-admin");
  });

  it("treats a failed verification read as a ref problem, not an unhealthy instance", async () => {
    // Readiness already passed; only the confirming read failed. Reporting
    // that as a health problem would misdirect recovery.
    const runner = runnerWith({ OPENCLAW_TEMPLATE_REF: OLD_REF, SETUP_PASSWORD: "setup-secret" });
    const inner = runner.run.bind(runner);
    let listCalls = 0;
    runner.run = async (args: string[], stdin?: string) => {
      if (args[0] === "variable" && args[1] === "list") {
        listCalls += 1;
        // Three variable-list reads happen: the current ref, SETUP_PASSWORD
        // for readiness, then the confirming readback. Fail only the last.
        if (listCalls >= 3) {
          throw new Error("transient variable-list failure");
        }
      }
      return inner(args, stdin);
    };

    const error = await updateClientTemplateRef(
      { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
      { runner, ...READY }
    ).catch((caught: unknown) => caught);

    expect(String(error)).toMatch(/reading the variable back to confirm it failed/);
    expect(String(error)).not.toMatch(/not confirmed healthy/);
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
    // Unlike OPENCLAW_GIT_REF, provisioning *does* write this variable, so a
    // client that reaches here is one where it was never set or was removed
    // -- an externally managed or hand-built service. The declare-unset path
    // still has to work for it.
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
    ).rejects.toThrow(/reads back as '.*', not the requested '.*'/);
  });

  it("diagnoses a wrong ref as a ref problem, not as an unhealthy instance", async () => {
    // Readiness passed here, so telling the operator the instance is "not
    // confirmed healthy" would point them at entirely the wrong recovery.
    const runner = runnerWith({ OPENCLAW_TEMPLATE_REF: OLD_REF, SETUP_PASSWORD: "setup-secret" });
    const inner = runner.run.bind(runner);
    runner.run = async (args: string[], stdin?: string) => {
      if (args[0] === "variable" && args[1] === "set") {
        return { stdout: "[]" };
      }
      return inner(args, stdin);
    };

    const error = await updateClientTemplateRef(
      { service: SERVICE, templateRef: NEW_REF, expectedCurrentRef: OLD_REF, pollSeconds: 0 },
      { runner, ...READY }
    ).catch((caught: unknown) => caught);

    expect(String(error)).toMatch(/it is the ref that is wrong/);
    expect(String(error)).not.toMatch(/not confirmed healthy/);
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
