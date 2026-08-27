// LIVE-INSTANCE TIER: idempotent-write
// See docs/live-instance-operations.md for what this tier permits.
//
// Reads the pending-pairing list first and returns status "no-pending"
// without approving when `requestIds` is empty, so a rerun against an
// instance whose pairing was already approved makes no write at all.
// Refuses under ambiguity rather than guessing: more than one pending
// request throws. Grants dashboard access to one device; it does not
// restart the gateway and does not redeploy.
//
// Issue #77's sibling: on a genuinely fresh instance (no baseline config
// yet), the gateway process has not started at all -- the wrapper only
// starts it once a config exists. `/setup/api/devices/pending` proxies to
// that gateway, so it answers `{ok:false}` (confirmed live: HTTP 500,
// body `{"ok":false,"requestIds":[],"output":"...gateway closed..."}`) for
// exactly the same pre-baseline window `patchAllowedOrigins` had to learn
// to refuse in. `ok:false` here is that "not up yet" signal, not a genuine
// approval failure -- status "not-ready" lets `bootstrapOnboardingCycle`
// retry once `apply` has established a baseline, the same shape as the
// allowedOrigins retry.

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

export type ApproveOwnDeviceStatus = "approved" | "no-pending" | "not-ready";

// A discriminated union rather than a bare `{ requestId?: string; status }`:
// the latter lets a caller (or a future edit to this function) construct
// `{ status: "approved" }` with no requestId, or `{ status: "no-pending",
// requestId: "req_1" }` -- both nonsensical. Read access to `.requestId`
// across the union still works uniformly (TypeScript infers `string |
// undefined`), so no call site needs to narrow on `.status` first.
export type ApproveOwnDeviceResult =
  | { status: "approved"; requestId: string }
  | { status: "no-pending" | "not-ready"; requestId?: undefined };

/** One-line, human-readable rendering of an approval result for handoff docs and CLI output. */
export function describeDeviceApprovalStatus(status: ApproveOwnDeviceStatus, requestId?: string): string {
  switch (status) {
    case "approved":
      return requestId ?? "approved";
    case "no-pending":
      return "none pending";
    case "not-ready":
      return "skipped -- instance did not report ready (commonly: no baseline gateway.mode yet); retry once initial setup completes";
    default: {
      const exhaustiveCheck: never = status;
      throw new Error(`describeDeviceApprovalStatus: unhandled status '${String(exhaustiveCheck)}'`);
    }
  }
}

export async function approveOwnDevicePairing(
  baseUrl: string,
  auth: SetupAuth,
  dependencies: ApproveOwnDeviceDependencies = {}
): Promise<ApproveOwnDeviceResult> {
  const getPendingDevices = dependencies.getPendingDevices ?? defaultGetPendingDevices;
  const approveDevice = dependencies.approveDevice ?? defaultApproveDevice;

  const pending = await getPendingDevices(baseUrl, auth);
  if (!pending.ok) {
    return { status: "not-ready" };
  }
  const { requestIds } = pending;

  if (requestIds.length === 0) {
    return { status: "no-pending" };
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
    // requestIds.length === 1 by this point, so an empty/undefined single
    // entry is a malformed response, not "nothing pending" -- silently
    // treating it as no-pending would skip approval and hide a genuine
    // protocol/data problem in the wrapper's own response shape.
    throw new Error(
      `GET /setup/api/devices/pending returned exactly one pending request, but its id was empty or missing ` +
        `(requestIds: ${JSON.stringify(requestIds)}). This is a malformed response, not "nothing pending".`
    );
  }
  const approved = await approveDevice(baseUrl, auth, requestId);
  if (!approved.ok) {
    throw new Error("POST /setup/api/devices/approve responded ok:false");
  }
  return { requestId, status: "approved" };
}

async function defaultGetPendingDevices(
  baseUrl: string,
  auth: SetupAuth
): Promise<{ ok: boolean; requestIds: string[] }> {
  const response = await fetch(`${baseUrl}/setup/api/devices/pending`, {
    headers: { authorization: basicAuthHeader(auth) }
  });
  // Any non-2xx status below 500 -- a 4xx (wrong SETUP_PASSWORD, wrong
  // username) or an unexpected 3xx -- is a hard failure and must throw
  // immediately. Silently mapping it to {ok:false}/"not-ready" would hide a
  // credential (or redirect/config) problem behind an endless "retry once
  // ready" loop, exactly the mistake this codebase has already been burned
  // by once (retry-vs-fail-fast in a readiness poll, a different call site).
  if (!response.ok && response.status < 500) {
    throw new Error(`GET /setup/api/devices/pending returned ${response.status}`);
  }
  // Do not throw on a 5xx: confirmed live, the wrapper answers with its own
  // {ok:false} body (and a 500) when the underlying gateway process has not
  // started yet, in the exact pre-baseline window issue #77 fixed for the
  // raw-config endpoint.
  let body: { ok?: boolean; requestIds?: string[] };
  try {
    body = (await response.json()) as { ok?: boolean; requestIds?: string[] };
  } catch (cause) {
    if (response.status >= 500) {
      // A non-JSON 5xx body (a proxy error page) is the same "not ready
      // yet" signal in different clothing -- treat it like an explicit
      // {ok:false} rather than failing to parse it.
      return { ok: false, requestIds: [] };
    }
    // A 2xx (or any other unexpected status) with an unparseable body is a
    // genuine protocol violation, not a readiness signal -- throw rather
    // than silently reporting "not ready" for a response that was never
    // the gateway-not-started shape at all.
    throw new Error(
      `GET /setup/api/devices/pending returned ${response.status} with a non-JSON body: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
  // A 5xx is never "ready" regardless of what its JSON body claims -- an
  // erroneous {ok:true} on a 500 must not be trusted into approving a
  // pairing against a gateway the HTTP layer itself says is failing. Only a
  // genuine 2xx response's own ok flag is trusted.
  if (response.status >= 500) {
    return { ok: false, requestIds: [] };
  }
  return { ok: body.ok === true, requestIds: body.requestIds ?? [] };
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
