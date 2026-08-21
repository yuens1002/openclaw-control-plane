// LIVE-INSTANCE TIER: idempotent-write
// See docs/live-instance-operations.md for what this tier permits.
//
// Reads the pending-pairing list first and returns `undefined` without
// approving when `requestIds` is empty, so a rerun against an instance
// whose pairing was already approved makes no write at all. Refuses under
// ambiguity rather than guessing: more than one pending request throws.
// Grants dashboard access to one device; it does not restart the gateway
// and does not redeploy.

import { basicAuthHeader, type SetupAuth } from "./setup-auth.js";

// First-time browser/device connections require pairing approval even with
// a correct OPENCLAW_GATEWAY_TOKEN (issue #18 item 5). This only covers
// pairing for whatever session the installer itself uses to verify -- a
// client's own first real browser login still triggers its own fresh
// pairing request, since pairing is per-device.

export interface ApproveOwnDeviceDependencies {
  getPendingDevices?:
    | ((baseUrl: string, auth: SetupAuth) => Promise<{ ok: boolean; requestIds: string[] }>)
    | undefined;
  approveDevice?: ((baseUrl: string, auth: SetupAuth, requestId: string) => Promise<{ ok: boolean }>) | undefined;
}

export async function approveOwnDevicePairing(
  baseUrl: string,
  auth: SetupAuth,
  dependencies: ApproveOwnDeviceDependencies = {}
): Promise<string | undefined> {
  const getPendingDevices = dependencies.getPendingDevices ?? defaultGetPendingDevices;
  const approveDevice = dependencies.approveDevice ?? defaultApproveDevice;

  const pending = await getPendingDevices(baseUrl, auth);
  if (!pending.ok) {
    throw new Error("GET /setup/api/devices/pending responded ok:false");
  }
  const { requestIds } = pending;

  if (requestIds.length === 0) {
    return undefined;
  }
  if (requestIds.length > 1) {
    // Ambiguous: this installer only approves pairing for its own single
    // verification session. Guessing which of several pending requests is
    // "ours" risks approving someone else's device.
    throw new Error(
      `Found ${requestIds.length} pending device pairing requests; refusing to guess which one is the ` +
        `installer's own session. Approve manually via 'openclaw devices approve <id>'.`
    );
  }

  const requestId = requestIds[0];
  if (!requestId) {
    return undefined;
  }
  const approved = await approveDevice(baseUrl, auth, requestId);
  if (!approved.ok) {
    throw new Error("POST /setup/api/devices/approve responded ok:false");
  }
  return requestId;
}

async function defaultGetPendingDevices(
  baseUrl: string,
  auth: SetupAuth
): Promise<{ ok: boolean; requestIds: string[] }> {
  const response = await fetch(`${baseUrl}/setup/api/devices/pending`, {
    headers: { authorization: basicAuthHeader(auth) }
  });
  if (!response.ok) {
    throw new Error(`GET /setup/api/devices/pending returned ${response.status}`);
  }
  return (await response.json()) as { ok: boolean; requestIds: string[] };
}

async function defaultApproveDevice(baseUrl: string, auth: SetupAuth, requestId: string): Promise<{ ok: boolean }> {
  const response = await fetch(`${baseUrl}/setup/api/devices/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: basicAuthHeader(auth) },
    body: JSON.stringify({ requestId })
  });
  if (!response.ok) {
    throw new Error(`POST /setup/api/devices/approve returned ${response.status}`);
  }
  return (await response.json()) as { ok: boolean };
}
