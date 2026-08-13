import { describe, expect, it } from "vitest";

import {
  installOpenClawOnRailway,
  mergeEnv,
  type CommandResult,
  type RailwayRunner
} from "@openclaw-control-plane/openclaw-railway-installer";

interface RecordedCommand {
  args: string[];
}

class FakeRailwayRunner implements RailwayRunner {
  readonly calls: RecordedCommand[] = [];
  private serviceListResponses: unknown[] = [];
  private domainListResponse: unknown = domainList(3000);
  private domainUpdateResponse: unknown = { domain: serviceDomain(8080) };

  constructor(serviceListResponses: unknown[]) {
    this.serviceListResponses = [...serviceListResponses];
  }

  setDomainList(response: unknown): void {
    this.domainListResponse = response;
  }

  setDomainUpdate(response: unknown): void {
    this.domainUpdateResponse = response;
  }

  async run(args: string[]): Promise<CommandResult> {
    this.calls.push({ args });
    const key = args.slice(0, 2).join(" ");

    if (args[0] === "deploy") {
      return { stdout: "Creating clawdbot-railway-template...\n" };
    }
    if (key === "service list") {
      const next = this.serviceListResponses.shift() ?? [];
      return { stdout: JSON.stringify(next) };
    }
    if (key === "domain list") {
      return { stdout: JSON.stringify(this.domainListResponse) };
    }
    if (key === "domain update") {
      return { stdout: JSON.stringify(this.domainUpdateResponse) };
    }

    throw new Error(`Unexpected command: ${args.join(" ")}`);
  }
}

describe("OpenClaw Railway installer", () => {
  it("deploys a fresh template, fixes the domain port, verifies health, and writes local outputs", async () => {
    const runner = new FakeRailwayRunner([
      [],
      [service("BUILDING")],
      [service("SUCCESS")]
    ]);
    const writes = new Map<string, string>();

    const result = await installOpenClawOnRailway(
      {
        setupPassword: "setup-secret",
        gatewayToken: "gateway-secret",
        pollSeconds: 0,
        envLocalPath: ".env.local",
        handoffPath: "handoff.local.md"
      },
      {
        runner,
        sleep: async () => {},
        healthCheck: async (url) => (url.endsWith("/setup/healthz") ? 200 : 500),
        readText: async () => "",
        writeText: async (path, contents) => {
          writes.set(path, contents);
        }
      }
    );

    expect(result.reusedExistingService).toBe(false);
    expect(result.setupUrl).toBe("https://client-openclaw.up.railway.app/setup");
    expect(result.openclawUrl).toBe("https://client-openclaw.up.railway.app/openclaw");
    expect(result.wroteEnvLocal).toBe(true);
    expect(result.wroteHandoff).toBe(true);
    expect(runner.calls.some((call) => call.args[0] === "deploy")).toBe(true);
    expect(runner.calls.some((call) => call.args[0] === "domain" && call.args[1] === "update")).toBe(true);
    expect(writes.get(".env.local")).toContain("OPENCLAW_RAILWAY_SETUP_PASSWORD=setup-secret");
    expect(writes.get("handoff.local.md")).toContain("Password: setup-secret");
  });

  it("reuses an existing successful service without deploying a duplicate", async () => {
    const runner = new FakeRailwayRunner([[service("SUCCESS")]]);
    runner.setDomainList(domainList(8080));

    const result = await installOpenClawOnRailway(
      {
        setupPassword: "setup-secret",
        gatewayToken: "gateway-secret",
        writeLocalFiles: false
      },
      {
        runner,
        healthCheck: async () => 200
      }
    );

    expect(result.reusedExistingService).toBe(true);
    expect(result.wroteEnvLocal).toBe(false);
    expect(runner.calls.some((call) => call.args[0] === "deploy")).toBe(false);
    expect(runner.calls.some((call) => call.args[0] === "domain" && call.args[1] === "update")).toBe(false);
  });

  it("fails with an actionable message when deployment reaches a terminal failure", async () => {
    const runner = new FakeRailwayRunner([[], [service("FAILED")]]);

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
          healthCheck: async () => 200
        }
      )
    ).rejects.toThrow("railway logs --service clawdbot-railway-template --lines 200");
  });

  it("refuses to reuse an existing unhealthy service without force", async () => {
    const runner = new FakeRailwayRunner([[service("CRASHED")]]);

    await expect(
      installOpenClawOnRailway(
        {
          setupPassword: "setup-secret",
          gatewayToken: "gateway-secret",
          writeLocalFiles: false
        },
        {
          runner,
          healthCheck: async () => 200
        }
      )
    ).rejects.toThrow("already exists with status 'CRASHED'");
  });

  it("preserves unrelated env vars while replacing managed local keys", () => {
    const merged = mergeEnv("KEEP_ME=true\nOPENCLAW_RAILWAY_SETUP_PASSWORD=old\n", {
      OPENCLAW_RAILWAY_SETUP_PASSWORD: "new",
      OPENCLAW_RAILWAY_SETUP_URL: "https://example.test/setup"
    });

    expect(merged).toContain("KEEP_ME=true");
    expect(merged).toContain("OPENCLAW_RAILWAY_SETUP_PASSWORD=new");
    expect(merged).toContain("OPENCLAW_RAILWAY_SETUP_URL=https://example.test/setup");
    expect(merged).not.toContain("OPENCLAW_RAILWAY_SETUP_PASSWORD=old");
  });
});

function service(status: "BUILDING" | "CRASHED" | "FAILED" | "SUCCESS") {
  return {
    id: "svc_client",
    name: "clawdbot-railway-template",
    source: {
      repo: "vignesh07/clawdbot-railway-template",
      image: null
    },
    latestDeployment: {
      id: "dep_client",
      status
    },
    url: "https://client-openclaw.up.railway.app"
  };
}

function serviceDomain(targetPort: number) {
  return {
    domain: "client-openclaw.up.railway.app",
    type: "service",
    targetPort
  };
}

function domainList(targetPort: number) {
  return {
    domains: [serviceDomain(targetPort)]
  };
}
