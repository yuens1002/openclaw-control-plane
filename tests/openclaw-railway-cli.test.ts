import { describe, expect, it } from "vitest";

import { parseArgs } from "@openclaw-control-plane/openclaw-railway-installer/cli";

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
