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

    expect(result).toBeUndefined();
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

    expect(result).toBe("req_abc123");
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

  it("throws when the wrapper responds ok:false on the pending-devices listing", async () => {
    await expect(
      approveOwnDevicePairing(BASE_URL, AUTH, {
        getPendingDevices: async () => ({ ok: false, requestIds: [] }),
        approveDevice: async () => ({ ok: true })
      })
    ).rejects.toThrow("ok:false");
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
