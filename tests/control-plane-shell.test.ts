import { afterEach, describe, expect, it } from "vitest";

import { createControlPlaneApp } from "@openclaw-control-plane/api";
import { DomainSchema } from "@openclaw-control-plane/contracts";

describe("control-plane shell defaults", () => {
  const originalSetupPassword = process.env.SETUP_PASSWORD;
  const originalSetupUsername = process.env.OPENCLAW_SETUP_USERNAME;
  const originalRuntimeBasicAuth = process.env.RUNTIME_ENABLE_BASIC_AUTH;

  afterEach(() => {
    restoreEnv("SETUP_PASSWORD", originalSetupPassword);
    restoreEnv("OPENCLAW_SETUP_USERNAME", originalSetupUsername);
    restoreEnv("RUNTIME_ENABLE_BASIC_AUTH", originalRuntimeBasicAuth);
  });

  it("serves a public root status response", async () => {
    delete process.env.SETUP_PASSWORD;
    const app = createControlPlaneApp();

    const response = await app.request("/");
    const root = (await response.json()) as {
      ok: boolean;
      service: string;
      worker_registry: string[];
      endpoints: string[];
    };

    expect(response.status).toBe(200);
    expect(root.ok).toBe(true);
    expect(root.service).toBe("openclaw-control-plane-api");
    expect(root.worker_registry).toEqual([]);
    expect(root.endpoints).toContain("/health");
  });

  it("keeps health public when operator auth is configured", async () => {
    process.env.SETUP_PASSWORD = "setup-secret";
    process.env.RUNTIME_ENABLE_BASIC_AUTH = "true";
    const app = createControlPlaneApp();

    const response = await app.request("/health");

    expect(response.status).toBe(503);
  });

  it("requires operator auth on the public root when setup password is configured", async () => {
    process.env.SETUP_PASSWORD = "setup-secret";
    process.env.RUNTIME_ENABLE_BASIC_AUTH = "true";
    const app = createControlPlaneApp();

    const response = await app.request("/");

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("OpenClaw Control Plane");
  });

  it("accepts operator auth with the configured setup password", async () => {
    process.env.SETUP_PASSWORD = "setup-secret";
    process.env.OPENCLAW_SETUP_USERNAME = "operator";
    process.env.RUNTIME_ENABLE_BASIC_AUTH = "true";
    const app = createControlPlaneApp();

    const response = await app.request("/", {
      headers: {
        authorization: `Basic ${Buffer.from("operator:setup-secret").toString("base64")}`
      }
    });

    expect(response.status).toBe(200);
  });

  it("starts without registering a vertical workflow", async () => {
    delete process.env.SETUP_PASSWORD;
    const app = createControlPlaneApp();

    const healthResponse = await app.request("/health");
    const health = (await healthResponse.json()) as {
      worker_registry: string[];
    };

    const pipelinesResponse = await app.request("/pipelines");
    const pipelines = (await pipelinesResponse.json()) as {
      pipelines: unknown[];
    };

    expect(health.worker_registry).toEqual([]);
    expect(pipelines.pipelines).toEqual([]);
  });

  it("reports persistence readiness dimensions independently", async () => {
    delete process.env.SETUP_PASSWORD;
    const app = createControlPlaneApp({
      eventStore: {
        insertEventIfNew: async (event) => ({ status: "inserted", event }),
        getEventByIdempotencyKey: async () => null
      },
      readiness: async () => ({
        database: "ready",
        migrations: "ready",
        registry: "invalid"
      })
    });

    const response = await app.request("/health");
    const health = (await response.json()) as {
      ready: boolean;
      api: string;
      database: string;
      migrations: string;
      registry: string;
    };

    expect(health).toMatchObject({
      ok: false,
      ready: false,
      api: "unavailable",
      database: "ready",
      migrations: "ready",
      registry: "invalid"
    });
    expect(response.status).toBe(503);
  });

  it("fails every operational command closed without trusted context", async () => {
    delete process.env.SETUP_PASSWORD;
    const app = createControlPlaneApp();
    const commandPaths = [
      "/events",
      "/pipelines/example-workflow/run",
      "/pipelines/example-workflow/pause",
      "/pipelines/example-workflow/resume",
      "/runs/run-1/retry",
      "/events/event-1/replay",
      "/artifacts/artifact-1/review",
      "/approvals/approval-1/approve",
      "/approvals/approval-1/reject",
      "/work-items/work-item-1/handoff"
    ];

    for (const path of commandPaths) {
      const response = await app.request(path, { method: "POST" });
      expect(response.status, path).toBe(503);
    }
  });

  it("accepts plugin-provided domain identifiers", () => {
    expect(DomainSchema.parse("client-location-pipeline")).toBe("client-location-pipeline");
  });

  it("rejects unsafe domain identifiers", () => {
    expect(DomainSchema.safeParse(" client-location-pipeline ").success).toBe(false);
    expect(DomainSchema.safeParse("client/location").success).toBe(false);
    expect(DomainSchema.safeParse("ClientLocation").success).toBe(false);
  });
});

function restoreEnv(
  key: "SETUP_PASSWORD" | "OPENCLAW_SETUP_USERNAME" | "RUNTIME_ENABLE_BASIC_AUTH",
  value: string | undefined
) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
