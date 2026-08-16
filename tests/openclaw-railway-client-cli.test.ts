import { describe, expect, it, vi } from "vitest";

import {
  parseProvisionArgs,
  parseUpdateRefArgs,
  runCommand
} from "@openclaw-control-plane/openclaw-railway-installer/client-cli";

describe("client-cli provision arg parsing", () => {
  it("parses documented flags", () => {
    expect(
      parseProvisionArgs([
        "--client-name",
        "acme",
        "--project-id",
        "proj_123",
        "--target-port",
        "8080",
        "--template-ref",
        "abc123",
        "--force-new",
        "--no-local-files"
      ])
    ).toMatchObject({
      clientName: "acme",
      projectId: "proj_123",
      targetPort: 8080,
      templateRef: "abc123",
      forceNew: true,
      writeLocalFiles: false
    });
  });

  it("requires --client-name", () => {
    expect(() => parseProvisionArgs(["--target-port", "8080"])).toThrow("Missing required --client-name");
  });

  it("rejects unknown flags", () => {
    expect(() => parseProvisionArgs(["--client-name", "acme", "--bogus"])).toThrow("Unknown argument: --bogus");
  });
});

describe("client-cli runCommand — real subprocess, no fake runner", () => {
  // This CLI's command set includes `railway variable list`, which Railway's
  // own docs confirm prints raw secret values with --json/--kv. A prior
  // incident in this repo (see openclaw-setup-applier/src/cli.ts's runCommand
  // comment) happened because a sibling wrapper's stdout-echo was copied
  // verbatim into a new call site without re-checking the new command set —
  // and no test caught it, because every test used a fake runner that never
  // exercised the real spawn path. This test exercises the real spawn path
  // directly, with no fake runner in between.
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

describe("client-cli update-ref arg parsing", () => {
  it("parses documented flags", () => {
    expect(parseUpdateRefArgs(["--service", "acme-openclaw", "--template-ref", "def456"])).toEqual({
      service: "acme-openclaw",
      templateRef: "def456"
    });
  });

  it("requires --service and --template-ref", () => {
    expect(() => parseUpdateRefArgs(["--template-ref", "def456"])).toThrow("Missing required --service");
    expect(() => parseUpdateRefArgs(["--service", "acme-openclaw"])).toThrow("Missing required --template-ref");
  });

  it("rejects unknown flags", () => {
    expect(() =>
      parseUpdateRefArgs(["--service", "acme-openclaw", "--template-ref", "def456", "--bogus"])
    ).toThrow("Unknown argument: --bogus");
  });
});
