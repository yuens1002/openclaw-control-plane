import { describe, expect, it } from "vitest";

import { parseArgs } from "@openclaw-control-plane/openclaw-setup-applier/cli";

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
