import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { CommandResult, RailwayRunner } from "@openclaw-control-plane/openclaw-railway-installer";
import { dryRunApplyProfile, printDryRunResult } from "@openclaw-control-plane/openclaw-setup-applier/apply-profile";

const SENTINEL_SECRET = "sk-test-DO-NOT-LOG-9f8e7d";

class FakeRailwayRunner implements RailwayRunner {
  constructor(private readonly variables: Record<string, string>) {}

  async run(args: string[]): Promise<CommandResult> {
    if (args[0] === "variable" && args[1] === "list") {
      return { stdout: JSON.stringify(this.variables) };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  }
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

function readFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/setup-profile/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}
