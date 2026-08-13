import { describe, expect, it } from "vitest";

import { createControlPlaneApp } from "@openclaw-control-plane/api";
import { DomainSchema } from "@openclaw-control-plane/contracts";

describe("control-plane shell defaults", () => {
  it("serves a public root status response", async () => {
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

  it("starts without registering a vertical workflow", async () => {
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

  it("accepts plugin-provided domain identifiers", () => {
    expect(DomainSchema.parse("client-location-pipeline")).toBe("client-location-pipeline");
  });

  it("rejects unsafe domain identifiers", () => {
    expect(DomainSchema.safeParse(" client-location-pipeline ").success).toBe(false);
    expect(DomainSchema.safeParse("client/location").success).toBe(false);
    expect(DomainSchema.safeParse("ClientLocation").success).toBe(false);
  });
});
