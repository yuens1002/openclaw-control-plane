import { describe, expect, it } from "vitest";

import type { CommandResult, RailwayRunner } from "@openclaw-control-plane/openclaw-railway-installer";
import {
  listRailwayVariables,
  readRailwayVariable,
  writeRailwayVariable
} from "@openclaw-control-plane/openclaw-setup-applier/railway-variables";

class FakeRailwayRunner implements RailwayRunner {
  readonly calls: Array<{ args: string[]; stdin?: string }> = [];
  constructor(private readonly variables: Record<string, string>) {}

  async run(args: string[], stdin?: string): Promise<CommandResult> {
    this.calls.push(stdin === undefined ? { args } : { args, stdin });
    if (args[0] === "variable" && args[1] === "list") {
      return { stdout: JSON.stringify(this.variables) };
    }
    if (args[0] === "variable" && args[1] === "set") {
      return { stdout: JSON.stringify({ ok: true }) };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  }
}

describe("Railway variable read path", () => {
  it("lists variables for the target service via `railway variable list --json`", async () => {
    const runner = new FakeRailwayRunner({ EXAMPLE_OPENROUTER_API_KEY: "sk-test-DO-NOT-LOG-1a2b3c" });

    const variables = await listRailwayVariables("example-service", { runner });

    expect(variables).toEqual({ EXAMPLE_OPENROUTER_API_KEY: "sk-test-DO-NOT-LOG-1a2b3c" });
    expect(runner.calls).toEqual([{ args: ["variable", "list", "--service", "example-service", "--json"] }]);
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

describe("Railway variable write path", () => {
  const SENTINEL_SECRET = "sk-test-DO-NOT-LOG-write-9f8e7d";

  it("writes via --stdin with --skip-deploys by default, never putting the value in args", async () => {
    const runner = new FakeRailwayRunner({});

    await writeRailwayVariable(
      { name: "EXAMPLE_OPENROUTER_API_KEY", value: SENTINEL_SECRET, service: "example-service" },
      { runner }
    );

    expect(runner.calls).toEqual([
      {
        args: [
          "variable",
          "set",
          "EXAMPLE_OPENROUTER_API_KEY",
          "--service",
          "example-service",
          "--skip-deploys",
          "--stdin",
          "--json"
        ],
        stdin: SENTINEL_SECRET
      }
    ]);
    expect(runner.calls[0]?.args.join(" ")).not.toContain(SENTINEL_SECRET);
  });

  it("omits --skip-deploys when skipDeploys is explicitly false", async () => {
    const runner = new FakeRailwayRunner({});

    await writeRailwayVariable(
      {
        name: "EXAMPLE_CUSTOM_PROVIDER_KEY",
        value: SENTINEL_SECRET,
        service: "example-service",
        skipDeploys: false
      },
      { runner }
    );

    expect(runner.calls[0]?.args).toEqual([
      "variable",
      "set",
      "EXAMPLE_CUSTOM_PROVIDER_KEY",
      "--service",
      "example-service",
      "--stdin",
      "--json"
    ]);
  });
});
