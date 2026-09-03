import { describe, expect, it } from "vitest";

import { terminalFailureStatuses, type DeploymentStatus } from "@openclaw-control-plane/openclaw-railway-installer";
import {
  classifyDeploymentStatus,
  readRailwayDeployConfig,
  selectDeploymentForCommit,
  selectLatestDeployment
} from "@openclaw-control-plane/openclaw-railway-installer/verify-deploy";

describe("selectDeploymentForCommit", () => {
  it("picks the entry whose commit matches, not the first entry in the list", () => {
    const deployments = [
      { status: "SUCCESS", meta: { commitHash: "aaa111" } },
      { status: "FAILED", meta: { commitHash: "bbb222" } }
    ];
    expect(selectDeploymentForCommit(deployments, "bbb222")).toBe(deployments[1]);
  });

  it("returns undefined when no deployment matches the target commit", () => {
    const deployments = [{ status: "SUCCESS", meta: { commitHash: "aaa111" } }];
    expect(selectDeploymentForCommit(deployments, "zzz999")).toBeUndefined();
  });

  it("returns undefined for an empty deployments array", () => {
    expect(selectDeploymentForCommit([], "aaa111")).toBeUndefined();
  });

  it("treats a deployment with no meta/commitHash, or an explicit null commitHash, as non-matching", () => {
    const deployments = [{ status: "SUCCESS" }, { status: "SUCCESS", meta: {} }, { status: "SUCCESS", meta: { commitHash: null } }];
    expect(selectDeploymentForCommit(deployments, "aaa111")).toBeUndefined();
  });

  it("picks the FIRST match when multiple deployments share a commit (a redeploy of an unchanged commit) -- documents the newest-first ordering assumption", () => {
    const deployments = [
      { status: "BUILDING", meta: { commitHash: "aaa111" } },
      { status: "SUCCESS", meta: { commitHash: "aaa111" } }
    ];
    expect(selectDeploymentForCommit(deployments, "aaa111")).toBe(deployments[0]);
  });
});

describe("selectLatestDeployment", () => {
  it("returns the first entry in the list -- railway deployment list returns newest-first", () => {
    const deployments = [
      { status: "SUCCESS", meta: { commitHash: "newest" } },
      { status: "SUCCESS", meta: { commitHash: "older" } }
    ];
    expect(selectLatestDeployment(deployments)).toBe(deployments[0]);
  });

  it("returns undefined for an empty deployments array", () => {
    expect(selectLatestDeployment([])).toBeUndefined();
  });
});

describe("classifyDeploymentStatus", () => {
  it("classifies SUCCESS as success", () => {
    expect(classifyDeploymentStatus("SUCCESS")).toBe("success");
  });

  it("classifies every status in the shared terminalFailureStatuses set as failure -- derived from the set itself so this can't drift from index.ts's own definition", () => {
    for (const status of terminalFailureStatuses) {
      expect(classifyDeploymentStatus(status)).toBe("failure");
    }
  });

  it("classifies every known non-terminal, non-success status as pending", () => {
    const nonTerminal: DeploymentStatus[] = ["BUILDING", "DEPLOYING", "INITIALIZING", "PENDING", "QUEUED", "WAITING"];
    for (const status of nonTerminal) {
      expect(classifyDeploymentStatus(status)).toBe("pending");
    }
  });

  it("classifies an unrecognized status string as pending rather than throwing or asserting a type", () => {
    expect(classifyDeploymentStatus("")).toBe("pending");
    expect(classifyDeploymentStatus("CANCELLED")).toBe("pending");
  });

  it("is case-sensitive -- a lowercase status never matches SUCCESS or a failure status", () => {
    expect(classifyDeploymentStatus("success")).toBe("pending");
    expect(classifyDeploymentStatus("failed")).toBe("pending");
  });
});

describe("readRailwayDeployConfig", () => {
  const full = { RAILWAY_PROJECT_ID: "proj", RAILWAY_ENVIRONMENT_ID: "env", RAILWAY_SERVICE_ID: "svc" };

  it("returns the config when all three scoping vars are set", () => {
    expect(readRailwayDeployConfig(full)).toEqual({
      projectId: "proj",
      environmentId: "env",
      serviceId: "svc"
    });
  });

  it("returns undefined when any single scoping var is missing, checked individually", () => {
    expect(readRailwayDeployConfig({ ...full, RAILWAY_PROJECT_ID: undefined })).toBeUndefined();
    expect(readRailwayDeployConfig({ ...full, RAILWAY_ENVIRONMENT_ID: undefined })).toBeUndefined();
    expect(readRailwayDeployConfig({ ...full, RAILWAY_SERVICE_ID: undefined })).toBeUndefined();
  });

  it('treats an empty string the same as missing -- GitHub Actions interpolates an unset secret to "", not undefined', () => {
    expect(readRailwayDeployConfig({ ...full, RAILWAY_PROJECT_ID: "" })).toBeUndefined();
  });

  it("returns undefined when all scoping vars are missing", () => {
    expect(readRailwayDeployConfig({})).toBeUndefined();
  });
});
