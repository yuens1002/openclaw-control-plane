import { describe, expect, it } from "vitest";

import { installOpenClawOnRailway, mergeEnv } from "@openclaw-control-plane/openclaw-railway-installer";
import { FakeRailwayRunner } from "./fixtures/fake-railway-runner.js";

describe("OpenClaw Railway installer", () => {
  it("deploys a fresh template, fixes the domain port, verifies health, and writes local outputs", async () => {
    const runner = new FakeRailwayRunner([
      [],
      [service("BUILDING")],
      [service("SUCCESS")]
    ]);
    // This test's expected URLs use this file's own "example-openclaw..."
    // domain fixture, distinct from the shared fixture's generic default —
    // pin it explicitly rather than relying on an implicit default.
    runner.setDomainList(domainList(3000));
    runner.setDomainUpdate({ domain: serviceDomain(8080) });
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
        checkSetupStatus: async (url) => (url.endsWith("/setup/api/status") ? 200 : 500),
        getConfigRaw: async () => ({ ok: true, content: "{}" }),
        postConfigRaw: async () => ({ ok: true }),
        getPendingDevices: async () => ({ ok: true, requestIds: [] }),
        approveDevice: async () => ({ ok: true }),
        readText: async () => "",
        writeText: async (path, contents) => {
          writes.set(path, contents);
        }
      }
    );

    expect(result.reusedExistingService).toBe(false);
    expect(result.setupUrl).toBe("https://example-openclaw.example.com/setup");
    expect(result.openclawUrl).toBe("https://example-openclaw.example.com/openclaw");
    expect(result.wroteEnvLocal).toBe(true);
    expect(result.wroteHandoff).toBe(true);
    expect(runner.calls.some((call) => call.args[0] === "deploy")).toBe(true);
    expect(runner.calls.some((call) => call.args[0] === "domain" && call.args[1] === "update")).toBe(true);
    expect(writes.get(".env.local")).toContain("OPENCLAW_RAILWAY_SETUP_PASSWORD=setup-secret");
    expect(writes.get("handoff.local.md")).toContain("Password: setup-secret");
    expect(writes.get("handoff.local.md")).toContain(
      "Attach client-specific tools, connectors, and workflows only after the shell install is healthy."
    );
  });

  it("generates a domain when the service has none yet, then proceeds normally", async () => {
    // Confirmed live (first-ever smoke of provisionClientInstance,
    // 2026-08-16): a freshly-deployed service can have zero domains --
    // `domain list` returning empty isn't a Railway-side propagation delay,
    // it means no domain was ever created and one must be generated
    // explicitly.
    const runner = new FakeRailwayRunner([[], [service("BUILDING")], [service("SUCCESS")]]);
    runner.setNoDomainUntilGenerated(8080);

    const result = await installOpenClawOnRailway(
      {
        setupPassword: "setup-secret",
        gatewayToken: "gateway-secret",
        pollSeconds: 0,
        writeLocalFiles: false
      },
      {
        runner,
        sleep: async () => {},
        checkSetupStatus: async (url) => (url.endsWith("/setup/api/status") ? 200 : 500),
        getConfigRaw: async () => ({ ok: true, content: "{}" }),
        postConfigRaw: async () => ({ ok: true }),
        getPendingDevices: async () => ({ ok: true, requestIds: [] }),
        approveDevice: async () => ({ ok: true })
      }
    );

    expect(result.setupUrl).toBe("https://example-openclaw.example.com/setup");
    expect(runner.calls.some((call) => call.args[0] === "domain" && call.args[1] === "--service")).toBe(true);
    // Already generated at the requested port -- no separate `domain
    // update` call needed on top of the generate call.
    expect(runner.calls.some((call) => call.args[0] === "domain" && call.args[1] === "update")).toBe(false);
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
        checkSetupStatus: async () => 200,
        getConfigRaw: async () => ({ ok: true, content: "{}" }),
        postConfigRaw: async () => ({ ok: true }),
        getPendingDevices: async () => ({ ok: true, requestIds: [] }),
        approveDevice: async () => ({ ok: true })
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
          sleep: async () => {}
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
          runner
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
    url: "https://example-openclaw.example.com"
  };
}

function serviceDomain(targetPort: number) {
  return {
    domain: "example-openclaw.example.com",
    type: "service",
    targetPort
  };
}

function domainList(targetPort: number) {
  return {
    domains: [serviceDomain(targetPort)]
  };
}
