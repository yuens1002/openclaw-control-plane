import { describe, expect, it } from "vitest";

import { installOpenClawOnRailway } from "@openclaw-control-plane/openclaw-railway-installer";
import { createFakeConfigStore } from "./fixtures/fake-config-store.js";
import { FakeRailwayRunner } from "./fixtures/fake-railway-runner.js";

function newRunner(serviceListResponses: unknown[][]): FakeRailwayRunner {
  const runner = new FakeRailwayRunner(serviceListResponses);
  runner.setDomainList({
    domains: [{ domain: "example-openclaw.example.com", type: "service", targetPort: 8080 }]
  });
  return runner;
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
    const runner = newRunner([[], [service("BUILDING")], [service("SUCCESS")]]);
    const readinessCalls: { url: string; auth: { username: string; password: string } }[] = [];

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
        checkSetupStatus: async (url, auth) => {
          readinessCalls.push({ url, auth });
          return 200;
        },
        ...createFakeConfigStore().deps,
        getPendingDevices: async () => ({ ok: true, requestIds: [] }),
        approveDevice: async () => ({ ok: true })
      }
    );

    // `InstallerDependencies` has no `healthCheck` field to spy on any more --
    // its removal is itself the guarantee that /setup/healthz can't gate
    // readiness. This test only has to confirm the real gate's shape.
    expect(readinessCalls).toHaveLength(1);
    expect(readinessCalls[0]?.url).toBe("https://example-openclaw.example.com/setup/api/status");
    expect(readinessCalls[0]?.auth).toEqual({ username: "openclaw-admin", password: "setup-secret-123" });
  });

  it("fails the install when the authenticated readiness check does not return 200", async () => {
    const runner = newRunner([[], [service("SUCCESS")]]);

    await expect(
      installOpenClawOnRailway(
        {
          setupPassword: "setup-secret",
          gatewayToken: "gateway-secret",
          pollSeconds: 0,
          // A do-while poll always attempts at least once regardless of
          // timeout, so timeoutMinutes: 0 exercises exactly one attempt
          // (matching this test's intent) without spinning against real
          // wall-clock time for the production default (25 minutes).
          timeoutMinutes: 0,
          writeLocalFiles: false
        },
        {
          runner,
          sleep: async () => {},
          checkSetupStatus: async () => 401
        }
      )
    ).rejects.toThrow("Setup readiness check");
  });

  it("retries the readiness check on transient non-200 responses until it succeeds", async () => {
    const runner = newRunner([[], [service("SUCCESS")]]);
    let attempts = 0;

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
        checkSetupStatus: async () => {
          attempts += 1;
          return attempts < 3 ? 401 : 200;
        },
        ...createFakeConfigStore().deps,
        getPendingDevices: async () => ({ ok: true, requestIds: [] }),
        approveDevice: async () => ({ ok: true })
      }
    );

    expect(attempts).toBe(3);
    expect(result.reusedExistingService).toBe(false);
  });
});

describe("installOpenClawOnRailway post-deploy step order and result reporting", () => {
  it("runs readiness -> allowedOrigins patch -> device approve in order and reports what happened", async () => {
    const runner = newRunner([[], [service("SUCCESS")]]);
    const order: string[] = [];

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
        checkSetupStatus: async () => {
          order.push("readiness");
          return 200;
        },
        // A baseline `gateway.mode` is present here -- this test is about the
        // patch/approve mechanics, not the missing-baseline case issue #77
        // covers below.
        ...createFakeConfigStore({
          initialContent: JSON.stringify({ gateway: { mode: "local" } }),
          onCall: (c) => order.push(c)
        }).deps,
        getPendingDevices: async () => {
          order.push("getPendingDevices");
          return { ok: true, requestIds: ["req_xyz789"] };
        },
        approveDevice: async () => {
          order.push("approveDevice");
          return { ok: true };
        }
      }
    );

    // The second getConfigRaw is patchAllowedOrigins' post-write verification
    // read -- it re-reads the config to confirm the origin actually landed
    // before reporting success. A single read here would mean the write was
    // never confirmed.
    expect(order).toEqual([
      "readiness",
      "getConfigRaw",
      "postConfigRaw",
      "getConfigRaw",
      "getPendingDevices",
      "approveDevice"
    ]);
    expect(result.patchedAllowedOrigins).toBe(true);
    expect(result.allowedOriginsStatus).toBe("patched");
    expect(result.approvedDeviceRequestId).toBe("req_xyz789");
  });

  it("does not POST an origin patch when the read-back config has no gateway.mode yet (issue #77)", async () => {
    const runner = newRunner([[], [service("SUCCESS")]]);

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
        checkSetupStatus: async () => 200,
        // Default createFakeConfigStore() content ("{}") has no gateway.mode.
        ...createFakeConfigStore().deps,
        postConfigRaw: async () => {
          throw new Error("must not POST an origin patch before a baseline config exists");
        },
        getPendingDevices: async () => ({ ok: true, requestIds: [] })
      }
    );

    expect(result.patchedAllowedOrigins).toBe(false);
    expect(result.allowedOriginsStatus).toBe("refused-missing-baseline");
  });

  it("reports no patch and no approval when there's nothing to do", async () => {
    const runner = newRunner([[], [service("SUCCESS")]]);

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
        checkSetupStatus: async () => 200,
        getConfigRaw: async () => ({
          ok: true,
          content: JSON.stringify({ gateway: { controlUi: { allowedOrigins: ["https://example-openclaw.example.com"] } } })
        }),
        postConfigRaw: async () => {
          throw new Error("should not be called when the origin is already present");
        },
        getPendingDevices: async () => ({ ok: true, requestIds: [] }),
        approveDevice: async () => {
          throw new Error("should not be called when nothing is pending");
        }
      }
    );

    expect(result.patchedAllowedOrigins).toBe(false);
    expect(result.allowedOriginsStatus).toBe("already-present");
    expect(result.approvedDeviceRequestId).toBeUndefined();
  });
});
