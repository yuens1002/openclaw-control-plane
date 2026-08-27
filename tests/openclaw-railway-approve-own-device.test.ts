import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { approveOwnDevicePairing } from "@openclaw-control-plane/openclaw-railway-installer/approve-own-device";

const AUTH = { username: "openclaw-admin", password: "setup-secret" };
const BASE_URL = "https://example-openclaw.example.com";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

/** Starts a local HTTP server that answers /setup/api/devices/pending with the given status/body, and returns its base URL. */
function serveDevicesPending(status: number, body: unknown): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

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

  // These exercise the real default fetch-based implementation (no
  // getPendingDevices override) against a local server, since the 4xx/5xx
  // branching lives inside that default and every test above bypasses it.
  describe("default getPendingDevices (real fetch, no dependency override)", () => {
    it("throws immediately on a 401 -- a credential problem must never be silently treated as not-ready", async () => {
      // A 4xx (wrong SETUP_PASSWORD, wrong username) is a hard failure.
      // Mapping it to {ok:false}/"not-ready" would hide it behind an
      // endless "retry once ready" loop instead of surfacing it.
      const baseUrl = await serveDevicesPending(401, { ok: false, requestIds: [] });

      await expect(approveOwnDevicePairing(baseUrl, AUTH, {})).rejects.toThrow(
        "GET /setup/api/devices/pending returned 401"
      );
    });

    it("reports not-ready, without throwing, on a real 500 with {ok:false} -- the confirmed-live gateway-not-started shape", async () => {
      const baseUrl = await serveDevicesPending(500, {
        ok: false,
        requestIds: [],
        output: "[openclaw] gateway closed (1006 abnormal closure)"
      });

      const result = await approveOwnDevicePairing(baseUrl, AUTH, {});

      expect(result).toEqual({ status: "not-ready" });
    });
  });
});
