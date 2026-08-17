import { describe, expect, it } from "vitest";

import { updateClientOpenClawRef } from "@openclaw-control-plane/openclaw-railway-installer/provision-client";
import { FakeRailwayRunner } from "./fixtures/fake-railway-runner.js";

describe("updateClientOpenClawRef", () => {
  it("emits exactly a variable set and a redeploy scoped to the named service, nothing else", async () => {
    const runner = new FakeRailwayRunner([
      [
        {
          id: "svc_acme",
          name: "acme-openclaw",
          latestDeployment: { id: "dep_new", status: "SUCCESS" }
        }
      ]
    ]);

    const result = await updateClientOpenClawRef(
      { service: "acme-openclaw", openclawRef: "v2026.7.1-2", pollSeconds: 0 },
      { runner, sleep: async () => {} }
    );

    expect(result).toEqual({ serviceName: "acme-openclaw", openclawRef: "v2026.7.1-2" });

    const mutatingCalls = runner.calls.filter((c) => !(c.args[0] === "service" && c.args[1] === "list"));
    expect(mutatingCalls).toHaveLength(2);
    expect(mutatingCalls[0]?.args).toEqual([
      "variable",
      "set",
      "OPENCLAW_GIT_REF",
      "--service",
      "acme-openclaw",
      "--skip-deploys",
      "--stdin",
      "--json"
    ]);
    expect(mutatingCalls[0]?.stdin).toBe("v2026.7.1-2");
    expect(mutatingCalls[1]?.args).toEqual(["redeploy", "--service", "acme-openclaw", "--yes", "--json"]);

    for (const call of runner.calls) {
      const serviceFlagIndex = call.args.indexOf("--service");
      if (serviceFlagIndex >= 0) {
        expect(call.args[serviceFlagIndex + 1]).toBe("acme-openclaw");
      }
    }
  });
});
