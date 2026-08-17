import { describe, expect, it, vi } from "vitest";

import { parseArgs, runCommand } from "@openclaw-control-plane/openclaw-railway-installer/cli";

describe("OpenClaw Railway installer CLI", () => {
  it("parses positive integer flags", () => {
    expect(
      parseArgs([
        "--target-port",
        "8080",
        "--poll-seconds",
        "5",
        "--timeout-minutes",
        "10"
      ])
    ).toMatchObject({
      targetPort: 8080,
      pollSeconds: 5,
      timeoutMinutes: 10
    });
  });

  it("rejects non-numeric integer flags before installer execution", () => {
    expect(() => parseArgs(["--target-port", "abc"])).toThrow("--target-port must be a positive integer");
    expect(() => parseArgs(["--poll-seconds", "1.5"])).toThrow("--poll-seconds must be a positive integer");
    expect(() => parseArgs(["--timeout-minutes", "0"])).toThrow(
      "--timeout-minutes must be a positive integer"
    );
  });
});

describe("cli runCommand — real subprocess, no fake runner", () => {
  // No test previously exercised the real spawn+stdin path for byte
  // fidelity: the "issue #18: no PowerShell-pipe BOM/CRLF corruption" claim
  // in provision-client.test.ts only checks the string handed to a *fake*
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

  // Marketplace-install CLI's runCommand deliberately echoes stdout to this
  // process's own stdout, unlike client-cli.ts's runCommand (see that file's
  // comment: its command set includes `railway variable list`, which can
  // leak secrets if echoed). This asserts the echo is real and both sinks
  // receive the same real subprocess output, so a future accidental removal
  // of the echo — or an accidental copy of client-cli.ts's no-echo variant
  // over this one — fails a test instead of shipping silently.
  it("captures stdout for parsing and also echoes it to this process's own stdout", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const result = await runCommand(process.execPath, ["-e", "process.stdout.write('marketplace-output')"]);

      expect(result.stdout).toBe("marketplace-output");
      expect(writeSpy.mock.calls.map((call) => call[0]).join("")).toContain("marketplace-output");
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
