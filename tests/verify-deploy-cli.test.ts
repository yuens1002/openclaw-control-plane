import { describe, expect, it } from "vitest";

import {
  classifyDeploymentStatus,
  readRailwayDeployConfig,
  selectDeploymentForCommit
} from "@openclaw-control-plane/openclaw-railway-installer/verify-deploy";

describe("selectDeploymentForCommit", () => {
  it("picks the entry whose commit matches, not the first entry in the list", () => {
    const deployments = [
      { status: "SUCCESS", meta: { commitHash: "aaa111" } },
      { status: "FAILED", meta: { commitHash: "bbb222" } }
    ];
    expect(selectDeploymentForCommit(deployments, "bbb222")).toMatchObject({ status: "FAILED" });
  });

  it("returns undefined when no deployment matches the target commit", () => {
    const deployments = [{ status: "SUCCESS", meta: { commitHash: "aaa111" } }];
    expect(selectDeploymentForCommit(deployments, "zzz999")).toBeUndefined();
  });

  it("treats a deployment with no meta/commitHash as non-matching, not a crash", () => {
    const deployments = [{ status: "SUCCESS" }, { status: "SUCCESS", meta: {} }];
    expect(selectDeploymentForCommit(deployments, "aaa111")).toBeUndefined();
  });
});

describe("classifyDeploymentStatus", () => {
  it("classifies SUCCESS as success", () => {
    expect(classifyDeploymentStatus("SUCCESS")).toBe("success");
  });

  it("classifies every terminal failure status as failure", () => {
    for (const status of ["FAILED", "CRASHED", "REMOVED", "SKIPPED"]) {
      expect(classifyDeploymentStatus(status)).toBe("failure");
    }
  });

  it("classifies every non-terminal status as pending", () => {
    for (const status of ["BUILDING", "DEPLOYING", "INITIALIZING", "QUEUED", "WAITING", "NEEDS_APPROVAL"]) {
      expect(classifyDeploymentStatus(status)).toBe("pending");
    }
  });
});

describe("readRailwayDeployConfig", () => {
  it("returns the config when all three scoping vars are set", () => {
    const env = {
      RAILWAY_PROJECT_ID: "proj",
      RAILWAY_ENVIRONMENT_ID: "env",
      RAILWAY_SERVICE_ID: "svc"
    };
    expect(readRailwayDeployConfig(env)).toEqual({
      projectId: "proj",
      environmentId: "env",
      serviceId: "svc"
    });
  });

  it("returns undefined (not a throw) when any scoping var is missing, matching verify-proof-cli's skip convention", () => {
    expect(readRailwayDeployConfig({ RAILWAY_PROJECT_ID: "proj" })).toBeUndefined();
    expect(readRailwayDeployConfig({})).toBeUndefined();
  });
});
