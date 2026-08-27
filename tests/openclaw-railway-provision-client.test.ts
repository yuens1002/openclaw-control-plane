import { describe, expect, it } from "vitest";

import {
  provisionClientInstance,
  type ProvisionClientDependencies
} from "@openclaw-control-plane/openclaw-railway-installer/provision-client";
import type { RailwayRunner } from "@openclaw-control-plane/openclaw-railway-installer";
import { FakeRailwayRunner, domainList } from "./fixtures/fake-railway-runner.js";
import { createFakeConfigStore } from "./fixtures/fake-config-store.js";

// A deliberately fake, non-Dockerfile-default ref: this feature must never
// pin the repo's real pinnedCommit SHA as a test literal (that's the Gate
// 2 brittle-literal trap) — the default-resolution path is exercised via
// an injected fixture instead.
const FIXTURE_PINNED_COMMIT = "0000000000000000000000000000000000face";

function baseDependencies(runner: RailwayRunner, overrides: Partial<ProvisionClientDependencies> = {}) {
  return {
    runner,
    sleep: async () => {},
    checkSetupStatus: async (url: string) => (url.endsWith("/setup/api/status") ? 200 : 500),
    ...createFakeConfigStore().deps,
    getPendingDevices: async () => ({ ok: true, requestIds: [] }),
    approveDevice: async () => ({ ok: true }),
    readText: async () => "",
    writeText: async () => {},
    readTemplateLock: async () => ({ pinnedCommit: FIXTURE_PINNED_COMMIT }),
    ...overrides
  } satisfies ProvisionClientDependencies;
}

describe("provisionClientInstance — fresh provision", () => {
  it("emits the bootstrap sequence in order: link/init, up, service-link, volume add (no -s), variable sets, redeploy", async () => {
    const runner = new FakeRailwayRunner([[], [freshService("BUILDING")], [freshService("SUCCESS")]]);
    runner.setDomainList(domainList(8080));
    const writes = new Map<string, string>();

    const result = await provisionClientInstance(
      { clientName: "acme", pollSeconds: 0, writeLocalFiles: true, envLocalPath: ".env.local", handoffPath: "handoff.local.md" },
      baseDependencies(runner, {
        writeText: async (path, contents) => {
          writes.set(path, contents);
        }
      })
    );

    const argsList = runner.calls.map((call) => call.args);
    const initIndex = argsList.findIndex((a) => a[0] === "init");
    const upIndex = argsList.findIndex((a) => a[0] === "up");
    const serviceLinkIndex = argsList.findIndex((a) => a[0] === "service" && a[1] === "acme-openclaw");
    const volumeIndex = argsList.findIndex((a) => a[0] === "volume");
    const variableIndices = argsList
      .map((a, i) => (a[0] === "variable" && a[1] === "set" ? i : -1))
      .filter((i) => i >= 0);
    const redeployIndex = argsList.findIndex((a) => a[0] === "redeploy");

    expect(initIndex).toBe(0);
    expect(upIndex).toBeGreaterThan(initIndex);
    expect(serviceLinkIndex).toBeGreaterThan(upIndex);
    expect(volumeIndex).toBeGreaterThan(serviceLinkIndex);
    expect(argsList[volumeIndex]).toEqual(["volume", "add", "--mount-path", "/data"]);
    expect(Math.min(...variableIndices)).toBeGreaterThan(volumeIndex);
    expect(redeployIndex).toBeGreaterThan(Math.max(...variableIndices));
    expect(argsList[redeployIndex]).toEqual(["redeploy", "--service", "acme-openclaw", "--yes", "--json"]);

    const variableNames = variableIndices.map((i) => argsList[i]?.[2]);
    expect(variableNames).toEqual([
      "OPENCLAW_TEMPLATE_REF",
      "PORT",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_WORKSPACE_DIR",
      "SETUP_PASSWORD",
      "OPENCLAW_GATEWAY_TOKEN"
    ]);
    variableIndices.forEach((i) => {
      expect(argsList[i]).toContain("--skip-deploys");
      expect(argsList[i]).toContain("--stdin");
    });

    expect(result.reusedExistingService).toBe(false);
    expect(result.templateRef).toBe(FIXTURE_PINNED_COMMIT);
    expect(writes.get("handoff.local.md")).toContain(`Template ref: ${FIXTURE_PINNED_COMMIT}`);
    expect(writes.get(".env.local")).toContain(`OPENCLAW_CLIENT_TEMPLATE_REF=${FIXTURE_PINNED_COMMIT}`);

    // Client handoff link: constructed from the freshly generated gateway
    // token, not a separate value -- and it's the one artifact both output
    // files actually surface (unlike the raw token/password, which a client
    // shouldn't need to type in manually at all).
    expect(result.dashboardUrl).toBe(`${result.openclawUrl}#token=${result.gatewayToken}`);
    expect(writes.get("handoff.local.md")).toContain(`- ${result.dashboardUrl}`);
    expect(writes.get(".env.local")).toContain(`OPENCLAW_CLIENT_DASHBOARD_URL=${result.dashboardUrl}`);
  });

  it("patches allowedOrigins and approves device pairing after the readiness check (issue #23)", async () => {
    const runner = new FakeRailwayRunner([[], [freshService("BUILDING")], [freshService("SUCCESS")]]);
    runner.setDomainList(domainList(8080));
    const calls: string[] = [];

    const result = await provisionClientInstance(
      { clientName: "acme", pollSeconds: 0, writeLocalFiles: false },
      baseDependencies(runner, {
        checkSetupStatus: async () => {
          calls.push("status");
          return 200;
        },
        // A baseline `gateway.mode` is present here -- this test is about the
        // patch/approve mechanics against an already-onboarded (or reused)
        // instance, not the missing-baseline case issue #77 covers below.
        ...createFakeConfigStore({
          initialContent: JSON.stringify({ gateway: { mode: "local" } }),
          onCall: (c) => calls.push(c)
        }).deps,
        getPendingDevices: async () => {
          calls.push("getPendingDevices");
          return { ok: true, requestIds: ["req_1"] };
        },
        approveDevice: async () => {
          calls.push("approveDevice");
          return { ok: true };
        }
      })
    );

    // The second getConfigRaw is patchAllowedOrigins' post-write verification
    // read (see the same assertion in the readiness suite).
    expect(calls).toEqual([
      "status",
      "getConfigRaw",
      "postConfigRaw",
      "getConfigRaw",
      "getPendingDevices",
      "approveDevice"
    ]);
    expect(result.patchedAllowedOrigins).toBe(true);
    expect(result.allowedOriginsStatus).toBe("patched");
    expect(result.approvedDeviceRequestId).toBe("req_1");
  });

  it("does not POST an origin patch against a genuinely fresh instance with no gateway.mode yet (issue #77)", async () => {
    const runner = new FakeRailwayRunner([[], [freshService("BUILDING")], [freshService("SUCCESS")]]);
    runner.setDomainList(domainList(8080));

    const result = await provisionClientInstance(
      { clientName: "acme", pollSeconds: 0, writeLocalFiles: false },
      baseDependencies(runner, {
        // Default createFakeConfigStore() content ("{}") models exactly what
        // a never-onboarded instance's /setup/api/config/raw returns: no
        // gateway.mode at all. Writing allowedOrigins into it would produce
        // a config the gateway refuses to start against.
        ...createFakeConfigStore().deps,
        postConfigRaw: async () => {
          throw new Error("must not POST an origin patch before a baseline config exists");
        },
        getPendingDevices: async () => ({ ok: true, requestIds: [] })
      })
    );

    expect(result.patchedAllowedOrigins).toBe(false);
    expect(result.allowedOriginsStatus).toBe("refused-missing-baseline");
  });

  it("does not POST a config patch or approve anything when there's nothing to do", async () => {
    const runner = new FakeRailwayRunner([[], [freshService("SUCCESS")]]);
    runner.setDomainList(domainList(8080));

    const result = await provisionClientInstance(
      { clientName: "acme", pollSeconds: 0, writeLocalFiles: false },
      baseDependencies(runner, {
        getConfigRaw: async () => ({ ok: true, content: JSON.stringify({ gateway: { controlUi: { allowedOrigins: ["https://acme-openclaw.example.com"] } } }) }),
        postConfigRaw: async () => {
          throw new Error("must not be called");
        },
        getPendingDevices: async () => ({ ok: true, requestIds: [] })
      })
    );

    expect(result.patchedAllowedOrigins).toBe(false);
    expect(result.allowedOriginsStatus).toBe("already-present");
    expect(result.approvedDeviceRequestId).toBeUndefined();
  });

  it("defaults OPENCLAW_TEMPLATE_REF from the injected template-lock reader but allows an explicit override", async () => {
    const runner = new FakeRailwayRunner([[], [freshService("SUCCESS")]]);

    const result = await provisionClientInstance(
      { clientName: "acme", templateRef: "override-ref", pollSeconds: 0, writeLocalFiles: false },
      baseDependencies(runner)
    );

    expect(result.templateRef).toBe("override-ref");
    const templateRefCall = runner.calls.find((c) => c.args[0] === "variable" && c.args[2] === "OPENCLAW_TEMPLATE_REF");
    expect(templateRefCall?.stdin).toBe("override-ref");
  });

  it("raises an actionable error on a terminal deployment failure", async () => {
    const runner = new FakeRailwayRunner([[], [freshService("FAILED")]]);

    await expect(
      provisionClientInstance(
        { clientName: "acme", pollSeconds: 0, writeLocalFiles: false },
        baseDependencies(runner)
      )
    ).rejects.toThrow("railway logs --service acme-openclaw --lines 200");
  });

  it("passes SETUP_PASSWORD and OPENCLAW_GATEWAY_TOKEN to the runner byte-identical to the generated value (issue #18: no PowerShell-pipe BOM/CRLF corruption)", async () => {
    const runner = new FakeRailwayRunner([[], [freshService("BUILDING")], [freshService("SUCCESS")]]);
    runner.setDomainList(domainList(8080));

    const result = await provisionClientInstance(
      { clientName: "acme", pollSeconds: 0, writeLocalFiles: false },
      baseDependencies(runner)
    );

    const setupPasswordCall = runner.calls.find((c) => c.args[0] === "variable" && c.args[2] === "SETUP_PASSWORD");
    const gatewayTokenCall = runner.calls.find(
      (c) => c.args[0] === "variable" && c.args[2] === "OPENCLAW_GATEWAY_TOKEN"
    );

    expect(setupPasswordCall?.stdin).toBe(result.setupPassword);
    expect(gatewayTokenCall?.stdin).toBeDefined();
    for (const stdin of [setupPasswordCall?.stdin, gatewayTokenCall?.stdin]) {
      expect(stdin).not.toMatch(/﻿/);
      expect(stdin).not.toMatch(/\r\n$/);
    }
  });

  it("corrects the domain's target port before health-checking", async () => {
    const runner = new FakeRailwayRunner([[], [freshService("SUCCESS")]]);
    runner.setDomainList(domainList(3000));

    await provisionClientInstance(
      { clientName: "acme", pollSeconds: 0, targetPort: 8080, writeLocalFiles: false },
      baseDependencies(runner)
    );

    expect(runner.calls.some((call) => call.args[0] === "domain" && call.args[1] === "update")).toBe(true);
  });
});

describe("provisionClientInstance — forceNew against a project with an existing service", () => {
  it("identifies the newly created service by ID diff, not list position (PR #21 review comment)", async () => {
    const oldService = serviceFixture({ id: "svc_old", name: "acme-openclaw-old", status: "SUCCESS" });
    const newService = serviceFixture({ id: "svc_new", name: "acme-openclaw-new", status: "SUCCESS" });
    // Deliberately listed with the pre-existing service AFTER the new one,
    // so a naive `[0]` pick after `up` would grab the wrong service.
    const runner = new FakeRailwayRunner([
      [oldService],
      [newService, oldService],
      [newService, oldService]
    ]);
    runner.setDomainList(domainList(8080));

    await provisionClientInstance(
      { clientName: "acme", projectId: "proj_123", forceNew: true, pollSeconds: 0, writeLocalFiles: false },
      baseDependencies(runner)
    );

    expect(runner.calls.some((call) => call.args[0] === "service" && call.args[1] === "acme-openclaw-new")).toBe(
      true
    );
    expect(runner.calls.some((call) => call.args[0] === "service" && call.args[1] === "acme-openclaw-old")).toBe(
      false
    );
  });
});

describe("provisionClientInstance — idempotent rerun", () => {
  it("skips up/service-link/volume/variable-set/redeploy when a service already exists for the linked project", async () => {
    const runner = new FakeRailwayRunner([[freshService("SUCCESS")]]);
    runner.setVariableListResponse({
      SETUP_PASSWORD: "already-handed-off-secret",
      OPENCLAW_GATEWAY_TOKEN: "already-handed-off-token"
    });
    runner.setDomainList(domainList(8080));

    const result = await provisionClientInstance(
      { clientName: "acme", projectId: "proj_123", pollSeconds: 0, writeLocalFiles: false },
      baseDependencies(runner)
    );

    expect(result.reusedExistingService).toBe(true);
    expect(runner.calls.some((call) => call.args[0] === "up")).toBe(false);
    expect(runner.calls.some((call) => call.args[0] === "volume")).toBe(false);
    expect(runner.calls.some((call) => call.args[0] === "variable" && call.args[1] === "set")).toBe(false);
    expect(runner.calls.some((call) => call.args[0] === "redeploy")).toBe(false);
    expect(runner.calls.some((call) => call.args[0] === "link" && call.args[2] === "proj_123")).toBe(true);
  });

  it("reuses the service's actual SETUP_PASSWORD instead of generating a fresh one", async () => {
    const runner = new FakeRailwayRunner([[freshService("SUCCESS")]]);
    runner.setVariableListResponse({
      SETUP_PASSWORD: "already-handed-off-secret",
      OPENCLAW_GATEWAY_TOKEN: "already-handed-off-token"
    });
    runner.setDomainList(domainList(8080));

    const result = await provisionClientInstance(
      { clientName: "acme", projectId: "proj_123", pollSeconds: 0, writeLocalFiles: false },
      baseDependencies(runner)
    );

    expect(result.setupPassword).toBe("already-handed-off-secret");
  });

  it("refuses to reuse an existing unhealthy service without forceNew (PR #21 review comment)", async () => {
    const runner = new FakeRailwayRunner([[freshService("CRASHED")]]);

    await expect(
      provisionClientInstance(
        { clientName: "acme", projectId: "proj_123", pollSeconds: 0, writeLocalFiles: false },
        baseDependencies(runner)
      )
    ).rejects.toThrow("already exists in this project with status 'CRASHED'");
  });

  it("throws instead of silently generating a fresh password when the existing service has no SETUP_PASSWORD set (PR #21 review comment)", async () => {
    const runner = new FakeRailwayRunner([[freshService("SUCCESS")]]);
    runner.setVariableListResponse({});

    await expect(
      provisionClientInstance(
        { clientName: "acme", projectId: "proj_123", pollSeconds: 0, writeLocalFiles: false },
        baseDependencies(runner)
      )
    ).rejects.toThrow("exists but has no SETUP_PASSWORD variable set");
  });

  it("throws instead of silently generating a fresh token when the existing service has no OPENCLAW_GATEWAY_TOKEN set", async () => {
    const runner = new FakeRailwayRunner([[freshService("SUCCESS")]]);
    runner.setVariableListResponse({ SETUP_PASSWORD: "already-handed-off-secret" });

    await expect(
      provisionClientInstance(
        { clientName: "acme", projectId: "proj_123", pollSeconds: 0, writeLocalFiles: false },
        baseDependencies(runner)
      )
    ).rejects.toThrow("exists but has no OPENCLAW_GATEWAY_TOKEN variable set");
  });

  it("reuses the service's actual OPENCLAW_GATEWAY_TOKEN and constructs dashboardUrl from it, not a freshly generated one", async () => {
    const runner = new FakeRailwayRunner([[freshService("SUCCESS")]]);
    runner.setVariableListResponse({
      SETUP_PASSWORD: "already-handed-off-secret",
      OPENCLAW_GATEWAY_TOKEN: "already-handed-off-token"
    });
    runner.setDomainList(domainList(8080));

    const result = await provisionClientInstance(
      { clientName: "acme", projectId: "proj_123", pollSeconds: 0, writeLocalFiles: false },
      baseDependencies(runner)
    );

    expect(result.gatewayToken).toBe("already-handed-off-token");
    expect(result.dashboardUrl).toBe(`${result.openclawUrl}#token=already-handed-off-token`);
  });

  it("refuses to guess when the linked project already has more than one service (PR #21 review comment)", async () => {
    const runner = new FakeRailwayRunner([
      [
        serviceFixture({ id: "svc_a", name: "acme-openclaw", status: "SUCCESS" }),
        serviceFixture({ id: "svc_b", name: "acme-openclaw-old", status: "SUCCESS" })
      ]
    ]);

    await expect(
      provisionClientInstance(
        { clientName: "acme", projectId: "proj_123", pollSeconds: 0, writeLocalFiles: false },
        baseDependencies(runner)
      )
    ).rejects.toThrow("found 2: acme-openclaw, acme-openclaw-old");
  });
});

function freshService(status: "BUILDING" | "CRASHED" | "FAILED" | "SUCCESS") {
  return serviceFixture({ status });
}

function serviceFixture(overrides: {
  id?: string;
  name?: string;
  status: "BUILDING" | "CRASHED" | "FAILED" | "SUCCESS";
}) {
  return {
    id: overrides.id ?? "svc_acme",
    name: overrides.name ?? "acme-openclaw",
    latestDeployment: {
      id: "dep_acme",
      status: overrides.status
    },
    url: "https://acme-openclaw.example.com"
  };
}
