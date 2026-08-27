import { describe, expect, it } from "vitest";

import { approveOwnDevicePairing } from "@openclaw-control-plane/openclaw-railway-installer/approve-own-device";

const AUTH = { username: "openclaw-admin", password: "setup-secret" };
const BASE_URL = "https://example-openclaw.example.com";

describe("approveOwnDevicePairing", () => {
  it("no-ops when there are zero pending requests", async () => {
    let approveCalls = 0;

    const result = await approveOwnDevicePairing(BASE_URL, AUTH, {
      getPendingDevices: async () => ({ ok: true, requestIds: [] }),
      approveDevice: async () => {
        approveCalls += 1;
        return { ok: true };
      }
    });

    expect(result).toEqual({ status: "no-pending" });
    expect(approveCalls).toBe(0);
  });

  it("approves the single pending request", async () => {
    const approvedIds: string[] = [];

    const result = await approveOwnDevicePairing(BASE_URL, AUTH, {
      getPendingDevices: async () => ({ ok: true, requestIds: ["req_abc123"] }),
      approveDevice: async (_baseUrl, _auth, requestId) => {
        approvedIds.push(requestId);
        return { ok: true };
      }
    });

    expect(result).toEqual({ requestId: "req_abc123", status: "approved" });
    expect(approvedIds).toEqual(["req_abc123"]);
  });

  it("refuses to guess when more than one request is pending", async () => {
    let approveCalls = 0;

    await expect(
      approveOwnDevicePairing(BASE_URL, AUTH, {
        getPendingDevices: async () => ({ ok: true, requestIds: ["req_a", "req_b"] }),
        approveDevice: async () => {
          approveCalls += 1;
          return { ok: true };
        }
      })
    ).rejects.toThrow("Found 2 pending device pairing requests");

    expect(approveCalls).toBe(0);
  });

  it("reports not-ready, without throwing, when the wrapper responds ok:false on the pending-devices listing", async () => {
    // Confirmed live (dogfood-throwaway-01 bootstrap): a genuinely fresh
    // instance's gateway has not started yet -- no baseline config exists --
    // and /setup/api/devices/pending proxies to it, answering {ok:false}
    // with a 500. That is a "not ready yet" signal for the caller to retry
    // once a baseline exists (issue #77's sibling), not a hard failure.
    let approveCalls = 0;

    const result = await approveOwnDevicePairing(BASE_URL, AUTH, {
      getPendingDevices: async () => ({ ok: false, requestIds: [] }),
      approveDevice: async () => {
        approveCalls += 1;
        return { ok: true };
      }
    });

    expect(result).toEqual({ status: "not-ready" });
    expect(approveCalls).toBe(0);
  });

  it("throws when the wrapper responds ok:false on approve, and does not return a requestId", async () => {
    await expect(
      approveOwnDevicePairing(BASE_URL, AUTH, {
        getPendingDevices: async () => ({ ok: true, requestIds: ["req_abc123"] }),
        approveDevice: async () => ({ ok: false })
      })
    ).rejects.toThrow("ok:false");
  });
});
