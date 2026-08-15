import { describe, expect, it } from "vitest";

import { parseArgs, requireEnv } from "@openclaw-control-plane/openclaw-setup-applier/cli";

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

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
