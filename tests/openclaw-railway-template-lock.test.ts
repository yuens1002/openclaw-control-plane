import { describe, expect, it } from "vitest";

import {
  checkTemplateUpdate,
  formatTemplateUpdateStatus,
  parseTemplateLock,
  type TemplateLock
} from "@openclaw-control-plane/openclaw-railway-installer/template-lock";

describe("Railway template lock", () => {
  it("reports current when upstream matches the pinned commit", async () => {
    const lock = templateLock();

    const result = await checkTemplateUpdate(lock, async () => lock.pinnedCommit);

    expect(result.status).toBe("current");
    expect(formatTemplateUpdateStatus(result)).toContain("Status: current");
  });

  it("reports update_available without mutating the lock", async () => {
    const lock = templateLock();
    const latestCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const result = await checkTemplateUpdate(lock, async () => latestCommit);

    expect(result.status).toBe("update_available");
    expect(result.lock.pinnedCommit).toBe(lock.pinnedCommit);
    expect(result.latestCommit).toBe(latestCommit);
    expect(formatTemplateUpdateStatus(result)).toContain("run a Railway proof smoke");
  });

  it("rejects malformed lock files", () => {
    expect(() =>
      parseTemplateLock({
        ...templateLock(),
        pinnedCommit: "not-a-sha"
      })
    ).toThrow("pinnedCommit");
  });

  it("requires mirror status and update cadence", () => {
    const missingMirrorStatus = templateLock();
    missingMirrorStatus.mirror = {
      requiredForImmutableProofInstance: true,
      approvedBranch: "openclaw-control-plane-approved"
    } as TemplateLock["mirror"];

    const missingCadence = templateLock();
    missingCadence.policy = {
      autoApply: false,
      requiresSmokeBeforeBump: true
    } as TemplateLock["policy"];

    expect(() => parseTemplateLock(missingMirrorStatus)).toThrow("mirror.status");
    expect(() => parseTemplateLock(missingCadence)).toThrow("policy.updateCadence");
  });

  it("uses upstreamRef when fetching the latest commit", async () => {
    const lock = templateLock();
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";

    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ sha: lock.pinnedCommit }), { status: 200 });
    };

    try {
      await checkTemplateUpdate(lock);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestedUrl).toContain("/commits/refs%2Fheads%2Fmain");
  });

  it("surfaces upstream fetch failures", async () => {
    await expect(
      checkTemplateUpdate(templateLock(), async () => {
        throw new Error("network failed");
      })
    ).rejects.toThrow("network failed");
  });
});

function templateLock(): TemplateLock {
  return {
    template: "clawdbot-railway-template",
    upstreamRepo: "vignesh07/clawdbot-railway-template",
    upstreamBranch: "main",
    upstreamRef: "refs/heads/main",
    pinnedCommit: "b9e2467189d02dfe51a80173c40bad650a58eaf2",
    mirror: {
      requiredForImmutableProofInstance: true,
      approvedBranch: "openclaw-control-plane-approved",
      status: "planned"
    },
    policy: {
      updateCadence: "weekly",
      autoApply: false,
      requiresSmokeBeforeBump: true
    }
  };
}
