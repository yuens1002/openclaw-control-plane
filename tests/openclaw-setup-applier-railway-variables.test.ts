import { describe, expect, it } from "vitest";

import type { CommandResult, RailwayRunner } from "@openclaw-control-plane/openclaw-railway-installer";
import {
  listRailwayVariables,
  readRailwayVariable
} from "@openclaw-control-plane/openclaw-setup-applier/railway-variables";

class FakeRailwayRunner implements RailwayRunner {
  readonly calls: string[][] = [];
  constructor(private readonly variables: Record<string, string>) {}

  async run(args: string[]): Promise<CommandResult> {
    this.calls.push(args);
    if (args[0] === "variable" && args[1] === "list") {
      return { stdout: JSON.stringify(this.variables) };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  }
}

describe("Railway variable read path", () => {
  it("lists variables for the target service via `railway variable list --json`", async () => {
    const runner = new FakeRailwayRunner({ EXAMPLE_OPENROUTER_API_KEY: "sk-test-DO-NOT-LOG-1a2b3c" });

    const variables = await listRailwayVariables("example-service", { runner });

    expect(variables).toEqual({ EXAMPLE_OPENROUTER_API_KEY: "sk-test-DO-NOT-LOG-1a2b3c" });
    expect(runner.calls).toEqual([["variable", "list", "--service", "example-service", "--json"]]);
  });

  it("resolves a named variable's value", async () => {
    const runner = new FakeRailwayRunner({ EXAMPLE_TELEGRAM_BOT_TOKEN: "sk-test-DO-NOT-LOG-telegram" });

    const value = await readRailwayVariable("EXAMPLE_TELEGRAM_BOT_TOKEN", "example-service", { runner });

    expect(value).toBe("sk-test-DO-NOT-LOG-telegram");
  });

  it("returns undefined for a variable that isn't set", async () => {
    const runner = new FakeRailwayRunner({});

    const value = await readRailwayVariable("MISSING_SECRET", "example-service", { runner });

    expect(value).toBeUndefined();
  });
});
