import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  readProofSourceFiles,
  verifyOpenClawRailwayProof,
  type ProofSnapshot
} from "@openclaw-control-plane/openclaw-railway-installer/verify-proof";

const expectations = {
  publicRepo: "yuens1002/openclaw-control-plane",
  branch: "main",
  expectedCommit: "main-commit",
  targetPort: 8080
};

describe("Railway OpenClaw proof verification", () => {
  it("accepts the desired end state", async () => {
    const result = verifyOpenClawRailwayProof(await desiredSnapshot(), expectations);

    expect(result.ok).toBe(true);
  });

  it("rejects a proof deployment that still sources the upstream template directly", async () => {
    const snapshot = await desiredSnapshot();
    snapshot.latestDeployment = {
      status: "SUCCESS",
      repo: snapshot.sourceFiles.templateLock.upstreamRepo,
      branch: "main",
      commitHash: "main-commit"
    };

    const result = verifyOpenClawRailwayProof(snapshot, expectations);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name === "latest deployment source is public repo")?.ok).toBe(false);
    expect(
      result.checks.find((check) => check.name === "latest deployment does not source upstream template directly")?.ok
    ).toBe(false);
  });

  it("rejects an API-shell deployment without OpenClaw dashboard routes", async () => {
    const snapshot = await desiredSnapshot();
    snapshot.endpoints = {
      setupHealth: 404,
      setup: 404,
      openclaw: 404
    };

    const result = verifyOpenClawRailwayProof(snapshot, expectations);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name === "live OpenClaw route exists")?.ok).toBe(false);
  });

  it("rejects stale Railway runtime settings that still start the API workspace", async () => {
    const snapshot = await desiredSnapshot();
    snapshot.serviceRuntime = {
      ...snapshot.serviceRuntime,
      startCommand: "npm --workspace @openclaw-control-plane/api start"
    };

    const result = verifyOpenClawRailwayProof(snapshot, expectations);

    expect(result.ok).toBe(false);
    expect(
      result.checks.find((check) => check.name === "Railway runtime start command does not override OpenClaw wrapper")
        ?.ok
    ).toBe(false);
  });

  it("rejects Railway runtime settings that bypass the source-owned config file", async () => {
    const snapshot = await desiredSnapshot();
    snapshot.serviceRuntime = {
      ...snapshot.serviceRuntime,
      railwayConfigFile: null,
      healthcheckPath: "/health"
    };

    const result = verifyOpenClawRailwayProof(snapshot, expectations);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name === "Railway runtime config file is railway.toml")?.ok).toBe(
      false
    );
    expect(
      result.checks.find((check) => check.name === "Railway runtime healthcheck targets setup wrapper")?.ok
    ).toBe(false);
  });

  it("rejects a proof service with an active upstream template source", async () => {
    const snapshot = await desiredSnapshot();
    snapshot.serviceSource = {
      repo: "yuens1002/openclaw-control-plane",
      image: null,
      upstreamUrl: "https://github.com/vignesh07/clawdbot-railway-template",
      templateId: "template",
      templateServiceId: "template-service",
      templateThreadSlug: "clawdbot-railway-template"
    };

    const result = verifyOpenClawRailwayProof(snapshot, expectations);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name === "Railway service upstream is not the template repo")?.ok).toBe(
      false
    );
    expect(
      result.checks.find((check) => check.name === "Railway service template metadata is historical only")?.ok
    ).toBe(true);
  });

  it("accepts historical template metadata when the active source is clean", async () => {
    const snapshot = await desiredSnapshot();
    snapshot.serviceSource = {
      repo: "yuens1002/openclaw-control-plane",
      image: null,
      upstreamUrl: null,
      templateId: "template",
      templateServiceId: "template-service",
      templateThreadSlug: "clawdbot-railway-template"
    };

    const result = verifyOpenClawRailwayProof(snapshot, expectations);

    expect(result.ok).toBe(true);
    expect(
      result.checks.find((check) => check.name === "Railway service template metadata is historical only")?.detail
    ).toContain("historical templateId");
  });

  it("keeps the source-owned Railway runtime contract pinned to the template lock", async () => {
    const sourceFiles = await readProofSourceFiles();
    const rawLock = JSON.parse(await readFile("deploy/openclaw-railway/template-lock.json", "utf8")) as {
      pinnedCommit: string;
    };

    expect(sourceFiles.dockerfile).toContain(`ARG OPENCLAW_TEMPLATE_REF=${rawLock.pinnedCommit}`);
    expect(sourceFiles.railwayToml).toContain('healthcheckPath = "/setup/healthz"');
  });
});

async function desiredSnapshot(): Promise<ProofSnapshot> {
  return {
    sourceFiles: await readProofSourceFiles(),
    serviceSource: {
      repo: "yuens1002/openclaw-control-plane",
      image: null,
      upstreamUrl: null,
      templateId: null,
      templateServiceId: null,
      templateThreadSlug: null
    },
    latestDeployment: {
      status: "SUCCESS",
      repo: "yuens1002/openclaw-control-plane",
      branch: "main",
      commitHash: "main-commit"
    },
    serviceRuntime: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
      railwayConfigFile: "railway.toml",
      rootDirectory: null,
      startCommand: "node src/server.js",
      healthcheckPath: "/setup/healthz"
    },
    domains: [
      {
        domain: "openclaw-control-plane-production.example.com",
        type: "service",
        targetPort: 8080,
        syncStatus: "ACTIVE"
      }
    ],
    endpoints: {
      setupHealth: 200,
      setup: 401,
      openclaw: 401
    }
  };
}
