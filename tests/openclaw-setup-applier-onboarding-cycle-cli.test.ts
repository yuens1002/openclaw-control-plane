import { describe, expect, it, vi } from "vitest";

import {
  parseBootstrapArgs,
  parseDeleteKeyArgs,
  parseRegressionCheckArgs,
  runCommand
} from "@openclaw-control-plane/openclaw-setup-applier/onboarding-cycle-cli";

describe("onboarding-cycle-cli bootstrap arg parsing", () => {
  it("parses documented flags", () => {
    expect(
      parseBootstrapArgs([
        "--client-name",
        "fixture-onboard",
        "--profile",
        "profiles/clients/fixture-onboard.json",
        "--workspace",
        "ws_123",
        "--project-id",
        "proj_123"
      ])
    ).toEqual({
      clientName: "fixture-onboard",
      profilePath: "profiles/clients/fixture-onboard.json",
      workspace: "ws_123",
      projectId: "proj_123"
    });
  });

  it("requires --client-name and --profile", () => {
    expect(() => parseBootstrapArgs(["--profile", "p.json"])).toThrow("Missing required --client-name");
    expect(() => parseBootstrapArgs(["--client-name", "fixture"])).toThrow("Missing required --profile");
  });

  it("rejects unknown flags", () => {
    expect(() =>
      parseBootstrapArgs(["--client-name", "fixture", "--profile", "p.json", "--bogus"])
    ).toThrow("Unknown argument: --bogus");
  });
});

describe("onboarding-cycle-cli regression-check arg parsing", () => {
  it("parses documented flags", () => {
    expect(
      parseRegressionCheckArgs([
        "--service",
        "fixture-onboard",
        "--instance-url",
        "https://fixture.example.up.railway.app",
        "--profile",
        "profiles/clients/fixture-onboard.json"
      ])
    ).toEqual({
      service: "fixture-onboard",
      instanceUrl: "https://fixture.example.up.railway.app",
      profilePath: "profiles/clients/fixture-onboard.json"
    });
  });

  it("requires --service, --instance-url, and --profile", () => {
    expect(() => parseRegressionCheckArgs(["--instance-url", "u", "--profile", "p"])).toThrow(
      "Missing required --service"
    );
    expect(() => parseRegressionCheckArgs(["--service", "s", "--profile", "p"])).toThrow(
      "Missing required --instance-url"
    );
    expect(() => parseRegressionCheckArgs(["--service", "s", "--instance-url", "u"])).toThrow(
      "Missing required --profile"
    );
  });
});

describe("onboarding-cycle-cli delete-key arg parsing", () => {
  it("parses --hash", () => {
    expect(parseDeleteKeyArgs(["--hash", "hash-abc123"])).toEqual({ hash: "hash-abc123" });
  });

  it("requires --hash", () => {
    expect(() => parseDeleteKeyArgs([])).toThrow("Missing required --hash");
  });

  it("rejects unknown flags", () => {
    expect(() => parseDeleteKeyArgs(["--hash", "h", "--bogus"])).toThrow("Unknown argument: --bogus");
  });
});

describe("onboarding-cycle-cli runCommand — real subprocess, no fake runner", () => {
  // Same discipline as client-cli.test.ts and cli.ts's own runCommand: this
  // CLI's command set includes `railway variable list`, which prints raw
  // secret values with --json/--kv. Exercise the real spawn path directly to
  // prove captured stdout is never echoed to this process's own stdout.
  it("never writes the spawned process's stdout to this process's own stdout, even though it's still captured for parsing", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const result = await runCommand(process.execPath, ["-e", "process.stdout.write('leaked-secret-value')"]);
      expect(result.stdout).toBe("leaked-secret-value");
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });
});
