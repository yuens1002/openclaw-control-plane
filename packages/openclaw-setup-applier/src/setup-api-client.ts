// LIVE-INSTANCE TIER: destructive
// See docs/live-instance-operations.md for what this tier permits.
//
// Highest tier comes from `reset`, which POSTs the setup API's reset
// endpoint and deletes the instance's config file outright. It has no
// production callers -- the only callers are unit tests that exist to
// exercise it -- and no gate of any kind in front of it --
// its presence on this client's surface is what sets the whole module's
// tier, and deleting the capability (rather than gating unused code) is
// tracked separately. Each returned method carries its own marker below.
// On the credential axis this module is uniformly secret-bearing: it holds
// Basic auth credentials for the life of the client and its POST bodies
// can carry resolved secret values.

// GET /setup/api/status and GET /setup/api/auth-groups response shapes ARE
// now confirmed against a live instance -- see
// docs/plans/setup-run-payload-contract/plan.md's Live Confirmation. Both
// calls still return `unknown` by design, not because the shape is
// unknown: this client stays a thin, unopinionated transport, and callers
// narrow only the fields they actually consume (see apply-profile.ts's
// `isConfigured` and its `mapChannelsToPayloadFields`-driven payload
// construction) rather than this module asserting a full response type.

export interface SetupApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  // A SETUP_PASSWORD-protected instance requires HTTP Basic auth on every
  // /setup/api/* route (confirmed live: an unauthenticated GET returns
  // 401). Omit when the target instance isn't password-protected -- no
  // Authorization header is sent, matching prior behavior exactly.
  auth?: {
    username: string;
    password: string;
  };
}

export class SetupApiError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number) {
    super(`OpenClaw setup API ${method} ${path} returned ${status}`);
    this.name = "SetupApiError";
    this.status = status;
  }
}

export function createSetupApiClient(options: SetupApiClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  // Never included in a thrown error or logged anywhere in this module —
  // same discipline as the request bodies below.
  const authHeaders: Record<string, string> = options.auth
    ? { authorization: `Basic ${Buffer.from(`${options.auth.username}:${options.auth.password}`).toString("base64")}` }
    : {};

  async function getJson(path: string): Promise<unknown> {
    const response = await fetchImpl(`${baseUrl}${path}`, { headers: authHeaders });
    if (!response.ok) {
      // Never include the response body in the thrown error — it may
      // contain instance-specific detail this applier must not log.
      throw new SetupApiError("GET", path, response.status);
    }
    return response.json();
  }

  async function postJson(path: string, body: unknown): Promise<unknown> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      // The body may contain a resolved secret value (authSecret, channel
      // tokens) — never include it in a thrown error, and never log this
      // call site's arguments anywhere in this module.
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new SetupApiError("POST", path, response.status);
    }
    return response.json();
  }

  return {
    // LIVE-INSTANCE TIER: read
    getStatus: (): Promise<unknown> => getJson("/setup/api/status"),
    // LIVE-INSTANCE TIER: read
    getAuthGroups: (): Promise<unknown> => getJson("/setup/api/auth-groups"),
    // `run`'s response shape is not independently confirmed live. `run`
    // accepts `unknown` rather than a typed payload because its exact
    // field set -- confirmed live: authChoice, authSecret, flow,
    // telegramToken/discordToken/slackBotToken/slackAppToken,
    // customProvider* fields; NOT authGroup, which is UI-grouping-only in
    // the real wizard and deliberately never sent (see
    // docs/plans/setup-run-payload-contract/plan.md) -- is assembled by
    // apply-profile.ts from the parsed profile; this client stays a thin,
    // unopinionated transport.
    // LIVE-INSTANCE TIER: unconditional-write
    // This transport POSTs whatever it is handed with no idempotency check
    // of its own; the guard that makes the apply path safe (skip the call
    // entirely when the instance already reports configured) lives in
    // apply-profile.ts, not here. Calling this directly bypasses it.
    run: (payload: unknown): Promise<unknown> => postJson("/setup/api/run", payload),
    // LIVE-INSTANCE TIER: destructive
    // Deletes the live instance's config file. No production callers; the
    // only callers are unit tests that exist to exercise this method.
    reset: (): Promise<unknown> => postJson("/setup/api/reset", {})
  };
}

export type SetupApiClient = ReturnType<typeof createSetupApiClient>;
