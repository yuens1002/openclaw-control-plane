import { readFile } from "node:fs/promises";

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

describe("marketplace-install path never reads Railway variables", () => {
  // Gap G4's disposition (docs/live-instance-operations.md §7, narrowed
  // rather than a shared guard) rests on this CLI's runCommand echoing
  // stdout (see the test above) never being reachable from a call that
  // reads a secret-bearing variable: railway-variables.ts's
  // listRailwayVariables/readRailwayVariable are only ever routed through
  // the non-echoing runners in client-cli.ts and openclaw-setup-applier's
  // cli.ts. That was true when traced, but nothing previously made it
  // observable if it stopped being true. A source-text check is a coarser
  // signal than an import-graph check, but it fails loudly the day either
  // file starts importing railway-variables.js directly, or starts
  // importing provision-client.js/apply-profile.js — the two modules that
  // already call the reader functions, so wiring either of *those* in here
  // would reintroduce the exposure without this file's own source ever
  // mentioning "railway-variables" — which is exactly the moment this
  // closed gap needs re-examining. Matches only actual import specifiers
  // (`from "...name..."`), not prose mentions of a sibling module's
  // filename in a doc comment — index.ts's waitForSetupReady comment
  // legitimately references provision-client.ts as one of its callers.
  const forbiddenImportPattern = /from\s+["'][^"']*(?:railway-variables|provision-client|apply-profile)[^"']*["']/;

  it("cli.ts never imports railway-variables.js, provision-client.js, or apply-profile.js", async () => {
    const source = await readFile("packages/openclaw-railway-installer/src/cli.ts", "utf8");
    expect(source).not.toMatch(forbiddenImportPattern);
  });

  it("index.ts never imports railway-variables.js, provision-client.js, or apply-profile.js", async () => {
    const source = await readFile("packages/openclaw-railway-installer/src/index.ts", "utf8");
    expect(source).not.toMatch(forbiddenImportPattern);
  });
});
