import { describe, expect, it, vi } from "vitest";

import { parseArgs, requireEnv, runCommand } from "@openclaw-control-plane/openclaw-setup-applier/cli";

describe("setup-profile-applier CLI argument parsing", () => {
  it("parses required flags", () => {
    const options = parseArgs([
      "--profile",
      "./profile.json",
      "--service",
      "example-service",
      "--instance-url",
      "https://example-openclaw.example.com"
    ]);

    expect(options).toEqual({
      profilePath: "./profile.json",
      service: "example-service",
      instanceUrl: "https://example-openclaw.example.com",
      dryRun: false
    });
  });

  it("sets dryRun when --dry-run is passed", () => {
    const options = parseArgs([
      "--profile",
      "./profile.json",
      "--service",
      "example-service",
      "--instance-url",
      "https://example-openclaw.example.com",
      "--dry-run"
    ]);

    expect(options.dryRun).toBe(true);
  });

  it("throws on an unknown argument", () => {
    expect(() => parseArgs(["--bogus"])).toThrow("Unknown argument: --bogus");
  });

  it("throws when a flag's value is missing", () => {
    expect(() => parseArgs(["--profile"])).toThrow("Missing value for --profile");
  });
});

describe("requireEnv", () => {
  const testVar = "OPENCLAW_SETUP_APPLIER_TEST_VAR_DOES_NOT_EXIST_ELSEWHERE";

  it("returns the value when the env var is set", () => {
    const previous = process.env[testVar];
    process.env[testVar] = "example-value";

    try {
      expect(requireEnv(testVar)).toBe("example-value");
    } finally {
      restoreEnv(testVar, previous);
    }
  });

  it("throws Missing required env var: <name> when unset", () => {
    const previous = process.env[testVar];
    delete process.env[testVar];

    try {
      expect(() => requireEnv(testVar)).toThrow(`Missing required env var: ${testVar}`);
    } finally {
      restoreEnv(testVar, previous);
    }
  });
});

describe("cli runCommand — real subprocess, no fake runner", () => {
  // This is the runner applyProfile/dryRunApplyProfile actually spawn
  // through when invoked directly from this CLI (as opposed to via
  // onboarding-cycle-cli.ts's bootstrap/regression-check paths, which use
  // their own separate runCommand, already pinned by
  // tests/openclaw-setup-applier-onboarding-cycle-cli.test.ts). This CLI's
  // own runCommand had no real-spawn coverage of any kind prior to this
  // test, discovered during gap G4's disposition review
  // (docs/live-instance-operations.md §7) when a review comment on that
  // closure's "two runners are tested" claim turned out to name the wrong
  // file for one of them.
  it("never writes the spawned process's stdout to this process's own stdout, even though it's still captured for parsing", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const result = await runCommand(process.execPath, ["-e", "process.stdout.write('leaked-secret-value')"]);
      expect(result.stdout).toBe("leaked-secret-value");
      expect(writeSpy.mock.calls.map((call) => call[0]).join("")).not.toContain("leaked-secret-value");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("rejects with the real captured stderr on a non-zero exit code", async () => {
    await expect(
      runCommand(process.execPath, ["-e", "process.stderr.write('boom'); process.exit(3);"])
    ).rejects.toThrow("failed with exit code 3: boom");
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
