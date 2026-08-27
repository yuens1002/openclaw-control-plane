import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  approveOwnDevicePairing,
  describeDeviceApprovalStatus
} from "@openclaw-control-plane/openclaw-railway-installer/approve-own-device";

const AUTH = { username: "openclaw-admin", password: "setup-secret" };
const BASE_URL = "https://example-openclaw.example.com";

let server: Server | undefined;

/** Requests actually received by the server started by the most recent `serveDevicesPending*` call. */
let receivedRequests: Array<{ method: string | undefined; url: string | undefined; authorization: string | undefined }> = [];

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  receivedRequests = [];
});

/** Starts a local HTTP server that answers /setup/api/devices/pending with the given status/JSON body, and returns its base URL. Any other path answers 404, so a request to the wrong path fails loudly instead of silently getting the fixture response. */
function serveDevicesPending(status: number, body: unknown): Promise<string> {
  return serveDevicesPendingRaw(status, JSON.stringify(body), "application/json");
}

/** Same as `serveDevicesPending`, but with a raw (possibly non-JSON) response body. */
function serveDevicesPendingRaw(status: number, rawBody: string, contentType = "text/plain"): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      receivedRequests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
      if (req.url !== "/setup/api/devices/pending") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(status, { "content-type": contentType });
      res.end(rawBody);
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

  it("throws on a single pending entry with an empty id -- a malformed response, not nothing-pending", async () => {
    // requestIds.length === 1 here, so an empty string is not "no requests
    // pending" -- it's the wrapper returning a broken entry. Silently
    // treating it as no-pending would skip approval and hide the real
    // protocol/data problem.
    let approveCalls = 0;

    await expect(
      approveOwnDevicePairing(BASE_URL, AUTH, {
        getPendingDevices: async () => ({ ok: true, requestIds: [""] }),
        approveDevice: async () => {
          approveCalls += 1;
          return { ok: true };
        }
      })
    ).rejects.toThrow("malformed response, not \"nothing pending\"");

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

      // Confirms the default hit the real endpoint (the 404 fallback would
      // otherwise let a wrong-path request pass this test unnoticed) with
      // the auth actually passed in, not some other path or no credential.
      expect(receivedRequests).toEqual([
        { method: "GET", url: "/setup/api/devices/pending", authorization: `Basic ${Buffer.from(`${AUTH.username}:${AUTH.password}`).toString("base64")}` }
      ]);
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

    it("reports not-ready on a 500 with a non-JSON body (a proxy error page) -- same signal in different clothing", async () => {
      const baseUrl = await serveDevicesPendingRaw(500, "<html><body>Bad Gateway</body></html>", "text/html");

      const result = await approveOwnDevicePairing(baseUrl, AUTH, {});

      expect(result).toEqual({ status: "not-ready" });
    });

    it("reports not-ready on a 500 even when its JSON body erroneously claims ok:true -- the HTTP layer wins", async () => {
      // A 5xx is never "ready", no matter what an inconsistent/buggy body
      // says. Trusting body.ok on a 500 could approve a pairing against a
      // gateway the transport layer itself says is failing.
      const baseUrl = await serveDevicesPending(500, { ok: true, requestIds: ["req_should_not_surface"] });

      const result = await approveOwnDevicePairing(baseUrl, AUTH, {});

      expect(result).toEqual({ status: "not-ready" });
    });

    it("throws on a 200 with a non-JSON body -- a broken response must never be silently treated as not-ready", async () => {
      // Confirmed live 500s always carry {ok:false} JSON; a 2xx that fails
      // to parse was never the gateway-not-started shape at all, and
      // mapping it to "not-ready" would hide a genuine protocol violation.
      const baseUrl = await serveDevicesPendingRaw(200, "<html><body>unexpected</body></html>", "text/html");

      await expect(approveOwnDevicePairing(baseUrl, AUTH, {})).rejects.toThrow(
        "GET /setup/api/devices/pending returned 200 with a non-JSON body"
      );
    });
  });
});

describe("describeDeviceApprovalStatus", () => {
  it("renders the requestId for an approved pairing", () => {
    expect(describeDeviceApprovalStatus("approved", "req_1")).toBe("req_1");
  });

  it("renders no-pending and not-ready as fixed, human-readable strings", () => {
    expect(describeDeviceApprovalStatus("no-pending")).toBe("none pending");
    expect(describeDeviceApprovalStatus("not-ready")).toMatch(/did not report ready/);
  });

  it("throws rather than silently rendering an ambiguous string when status is approved with no requestId", () => {
    // ApproveOwnDeviceResult's own type guarantees this combination can't be
    // constructed from approveOwnDevicePairing's return value -- reaching
    // this branch means the two arguments were assembled inconsistently by
    // the caller, which must surface loudly, not render "approved".
    expect(() => describeDeviceApprovalStatus("approved")).toThrow(
      "status is 'approved' but no requestId was given"
    );
  });
});
