import { describe, expect, it } from "vitest";

import {
  installOpenClawOnRailway,
  type CommandResult,
  type RailwayRunner
} from "@openclaw-control-plane/openclaw-railway-installer";

class FakeRailwayRunner implements RailwayRunner {
  private serviceListResponses: unknown[];

  constructor(serviceListResponses: unknown[]) {
    this.serviceListResponses = [...serviceListResponses];
  }

  async run(args: string[]): Promise<CommandResult> {
    const key = args.slice(0, 2).join(" ");
    if (args[0] === "deploy") {
      return { stdout: "" };
    }
    if (key === "service list") {
      return { stdout: JSON.stringify(this.serviceListResponses.shift() ?? []) };
    }
    if (key === "domain list") {
      return {
        stdout: JSON.stringify({
          domains: [{ domain: "example-openclaw.example.com", type: "service", targetPort: 8080 }]
        })
      };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  }
}

function service(status: "BUILDING" | "SUCCESS") {
  return {
    id: "svc_client",
    name: "clawdbot-railway-template",
    latestDeployment: { id: "dep_client", status }
  };
}

describe("installOpenClawOnRailway readiness check", () => {
  it("polls the authenticated /setup/api/status endpoint with the resolved credentials, not /setup/healthz", async () => {
    const runner = new FakeRailwayRunner([[], [service("BUILDING")], [service("SUCCESS")]]);
    const readinessCalls: { url: string; auth: { username: string; password: string } }[] = [];
    let unauthenticatedHealthzCalled = false;

    await installOpenClawOnRailway(
      {
        setupPassword: "setup-secret-123",
        setupUsername: "openclaw-admin",
        gatewayToken: "gateway-secret",
        pollSeconds: 0,
        writeLocalFiles: false
      },
      {
        runner,
        sleep: async () => {},
        healthCheck: async () => {
          unauthenticatedHealthzCalled = true;
          return 200;
        },
        checkSetupStatus: async (url, auth) => {
          readinessCalls.push({ url, auth });
          return 200;
        },
        getConfigRaw: async () => ({ ok: true, content: "{}" }),
        postConfigRaw: async () => ({ ok: true }),
        getPendingDevices: async () => ({ ok: true, requestIds: [] }),
        approveDevice: async () => ({ ok: true })
      }
    );

    expect(unauthenticatedHealthzCalled).toBe(false);
    expect(readinessCalls).toHaveLength(1);
    expect(readinessCalls[0]?.url).toBe("https://example-openclaw.example.com/setup/api/status");
    expect(readinessCalls[0]?.auth).toEqual({ username: "openclaw-admin", password: "setup-secret-123" });
  });

  it("fails the install when the authenticated readiness check does not return 200", async () => {
    const runner = new FakeRailwayRunner([[], [service("SUCCESS")]]);

    await expect(
      installOpenClawOnRailway(
        {
          setupPassword: "setup-secret",
          gatewayToken: "gateway-secret",
          pollSeconds: 0,
          writeLocalFiles: false
        },
        {
          runner,
          sleep: async () => {},
          healthCheck: async () => 200,
          checkSetupStatus: async () => 401
        }
      )
    ).rejects.toThrow("Setup readiness check");
  });
});
