import { describe, expect, it } from "vitest";

import {
  parseProvisionArgs,
  parseUpdateRefArgs
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
