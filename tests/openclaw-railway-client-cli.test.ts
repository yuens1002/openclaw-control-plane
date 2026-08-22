import { describe, expect, it, vi } from "vitest";

import {
  parseProvisionArgs,
  parseUpdateOpenClawRefArgs,
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

  // No test previously exercised the real spawn+stdin path for byte
  // fidelity: provision-client.test.ts's "issue #18: no PowerShell-pipe
  // BOM/CRLF corruption" test only checks the string handed to a *fake*
  // RailwayRunner. This spawns a real child and round-trips a payload that
  // would reveal BOM/CRLF corruption if the spawn+stdin.end() path ever
  // introduced any.
  it("round-trips stdin byte-identical through a real spawned child", async () => {
    const payload = " \tleading/trailing space, a unicode glyph (☂), and\nan embedded newline ";
    const result = await runCommand(process.execPath, [
      "-e",
      "let s = ''; process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => process.stdout.write(s));"
    ], payload);

    expect(result.stdout).toBe(payload);
    expect(result.stdout).not.toMatch(/﻿/);
    expect(result.stdout).not.toMatch(/\r\n/);
  });

  it("rejects with the real captured stderr on a non-zero exit code", async () => {
    await expect(
      runCommand(process.execPath, ["-e", "process.stderr.write('boom'); process.exit(3);"])
    ).rejects.toThrow("failed with exit code 3: boom");
  });
});

describe("client-cli update-ref arg parsing", () => {
  it("parses documented flags", () => {
    expect(
      parseUpdateRefArgs([
        "--service",
        "acme-openclaw",
        "--template-ref",
        "def456",
        "--expected-current-ref",
        "abc123"
      ])
    ).toEqual({
      service: "acme-openclaw",
      templateRef: "def456",
      expectedCurrentRef: "abc123"
    });
  });

  it("requires --service and --template-ref", () => {
    expect(() => parseUpdateRefArgs(["--template-ref", "def456"])).toThrow("Missing required --service");
    expect(() => parseUpdateRefArgs(["--service", "acme-openclaw"])).toThrow("Missing required --template-ref");
  });


  it("parses --setup-username and --force-redeploy", () => {
    // Library-level tests never touch the parser, so a missing case here
    // would leave custom-auth clients and the documented recovery path
    // unusable while every other test still passed.
    expect(
      parseUpdateRefArgs([
        "--service",
        "acme-openclaw",
        "--template-ref",
        "def456",
        "--expected-current-ref",
        "abc123",
        "--setup-username",
        "custom-admin",
        "--force-redeploy"
      ])
    ).toEqual({
      service: "acme-openclaw",
      templateRef: "def456",
      expectedCurrentRef: "abc123",
      setupUsername: "custom-admin",
      forceRedeploy: true
    });
  });
  it("requires --expected-current-ref so an update cannot run without stating what it replaces", () => {
    expect(() => parseUpdateRefArgs(["--service", "acme-openclaw", "--template-ref", "def456"])).toThrow(
      "Missing required --expected-current-ref"
    );
  });

  it("rejects unknown flags", () => {
    expect(() =>
      parseUpdateRefArgs(["--service", "acme-openclaw", "--template-ref", "def456", "--bogus"])
    ).toThrow("Unknown argument: --bogus");
  });
});

describe("client-cli update-openclaw-ref arg parsing", () => {
  it("parses documented flags", () => {
    expect(
      parseUpdateOpenClawRefArgs([
        "--service",
        "acme-openclaw",
        "--openclaw-ref",
        "v2026.7.1-2",
        "--expected-current-ref",
        "v2026.6.0-1"
      ])
    ).toEqual({
      service: "acme-openclaw",
      openclawRef: "v2026.7.1-2",
      expectedCurrentRef: "v2026.6.0-1"
    });
  });


  it("parses --setup-username and --force-redeploy", () => {
    expect(
      parseUpdateOpenClawRefArgs([
        "--service",
        "acme-openclaw",
        "--openclaw-ref",
        "v2026.7.1-2",
        "--expected-current-ref",
        "v2026.6.0-1",
        "--setup-username",
        "custom-admin",
        "--force-redeploy"
      ])
    ).toEqual({
      service: "acme-openclaw",
      openclawRef: "v2026.7.1-2",
      expectedCurrentRef: "v2026.6.0-1",
      setupUsername: "custom-admin",
      forceRedeploy: true
    });
  });
  it("requires --expected-current-ref so an update cannot run without stating what it replaces", () => {
    expect(() =>
      parseUpdateOpenClawRefArgs(["--service", "acme-openclaw", "--openclaw-ref", "v2026.7.1-2"])
    ).toThrow("Missing required --expected-current-ref");
  });

  it("requires --service and --openclaw-ref", () => {
    expect(() => parseUpdateOpenClawRefArgs(["--openclaw-ref", "v2026.7.1-2"])).toThrow("Missing required --service");
    expect(() => parseUpdateOpenClawRefArgs(["--service", "acme-openclaw"])).toThrow(
      "Missing required --openclaw-ref"
    );
  });

  it("rejects unknown flags", () => {
    expect(() =>
      parseUpdateOpenClawRefArgs(["--service", "acme-openclaw", "--openclaw-ref", "v2026.7.1-2", "--bogus"])
    ).toThrow("Unknown argument: --bogus");
  });
});
