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
    getStatus: (): Promise<unknown> => getJson("/setup/api/status"),
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
    run: (payload: unknown): Promise<unknown> => postJson("/setup/api/run", payload),
    reset: (): Promise<unknown> => postJson("/setup/api/reset", {})
  };
}

export type SetupApiClient = ReturnType<typeof createSetupApiClient>;
