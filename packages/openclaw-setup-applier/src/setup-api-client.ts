// GET /setup/api/status and GET /setup/api/auth-groups response shapes are
// not independently confirmed against a live instance (see the "Before
// D2/D13" entry in docs/plans/setup-profile-applier/plan.md's Dependencies
// section, which flags the authGroup/authChoice enum in particular).
// Both calls therefore return `unknown` — callers must narrow only the
// fields they actually need rather than trusting an assumed shape.

export interface SetupApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
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

  async function getJson(path: string): Promise<unknown> {
    const response = await fetchImpl(`${baseUrl}${path}`);
    if (!response.ok) {
      // Never include the response body in the thrown error — it may
      // contain instance-specific detail this applier must not log.
      throw new SetupApiError("GET", path, response.status);
    }
    return response.json();
  }

  return {
    getStatus: (): Promise<unknown> => getJson("/setup/api/status"),
    getAuthGroups: (): Promise<unknown> => getJson("/setup/api/auth-groups")
  };
}

export type SetupApiClient = ReturnType<typeof createSetupApiClient>;
