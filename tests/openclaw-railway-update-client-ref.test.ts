import { describe, expect, it } from "vitest";

import { updateClientTemplateRef } from "@openclaw-control-plane/openclaw-railway-installer/provision-client";
import type { CommandResult, RailwayRunner } from "@openclaw-control-plane/openclaw-railway-installer";

interface RecordedCommand {
  args: string[];
  stdin?: string;
}

class FakeRailwayRunner implements RailwayRunner {
  readonly calls: RecordedCommand[] = [];

  async run(args: string[], stdin?: string): Promise<CommandResult> {
    this.calls.push(stdin === undefined ? { args } : { args, stdin });
    const key = args.slice(0, 2).join(" ");

    if (key === "variable set") {
      return { stdout: JSON.stringify([args[2]]) };
    }
    if (args[0] === "redeploy") {
      return { stdout: "{}" };
    }
    if (key === "service list") {
      return {
        stdout: JSON.stringify([
          {
            id: "svc_acme",
            name: "acme-openclaw",
            latestDeployment: { id: "dep_new", status: "SUCCESS" }
          }
        ])
      };
    }

    throw new Error(`Unexpected command: ${args.join(" ")}`);
  }
}

describe("updateClientTemplateRef", () => {
  it("emits exactly a variable set and a redeploy scoped to the named service, nothing else", async () => {
    const runner = new FakeRailwayRunner();

    const result = await updateClientTemplateRef(
      { service: "acme-openclaw", templateRef: "new-ref-1234", pollSeconds: 0 },
      { runner, sleep: async () => {} }
    );

    expect(result).toEqual({ serviceName: "acme-openclaw", templateRef: "new-ref-1234" });

    const mutatingCalls = runner.calls.filter((c) => !(c.args[0] === "service" && c.args[1] === "list"));
    expect(mutatingCalls).toHaveLength(2);
    expect(mutatingCalls[0]?.args).toEqual([
      "variable",
      "set",
      "OPENCLAW_TEMPLATE_REF",
      "--service",
      "acme-openclaw",
      "--skip-deploys",
      "--stdin",
      "--json"
    ]);
    expect(mutatingCalls[0]?.stdin).toBe("new-ref-1234");
    expect(mutatingCalls[1]?.args).toEqual(["redeploy", "--service", "acme-openclaw", "--yes", "--json"]);

    for (const call of runner.calls) {
      const serviceFlagIndex = call.args.indexOf("--service");
      if (serviceFlagIndex >= 0) {
        expect(call.args[serviceFlagIndex + 1]).toBe("acme-openclaw");
      }
    }
  });
});
