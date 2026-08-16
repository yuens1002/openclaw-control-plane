import { basicAuthHeader, type SetupAuth } from "./setup-auth.js";

// `gateway.controlUi.allowedOrigins` has no environment-variable override
// and isn't auto-seeded for a Railway-style reverse-proxied deployment (the
// seeding migration only fires for non-loopback `--bind`; the wrapper
// always starts the gateway with `--bind loopback`). This is the confirmed
// root cause of the dashboard's "origin not allowed" error (issue #18 item
// 4) -- patch it via the wrapper's own config/raw endpoints instead of SSH.

export interface PatchAllowedOriginsDependencies {
  getConfigRaw?: ((baseUrl: string, auth: SetupAuth) => Promise<{ ok: boolean; content: string }>) | undefined;
  postConfigRaw?: ((baseUrl: string, auth: SetupAuth, content: string) => Promise<{ ok: boolean }>) | undefined;
}

export interface PatchAllowedOriginsResult {
  patched: boolean;
}

export async function patchAllowedOrigins(
  baseUrl: string,
  auth: SetupAuth,
  domain: string,
  dependencies: PatchAllowedOriginsDependencies = {}
): Promise<PatchAllowedOriginsResult> {
  const getConfigRaw = dependencies.getConfigRaw ?? defaultGetConfigRaw;
  const postConfigRaw = dependencies.postConfigRaw ?? defaultPostConfigRaw;

  const getResult = await getConfigRaw(baseUrl, auth);
  if (!getResult.ok) {
    throw new Error("GET /setup/api/config/raw responded ok:false");
  }
  const { content } = getResult;
  // The wrapper's own config is documented as "JSON/JSON5-ish", but a
  // freshly machine-written config from the setup wizard is plain JSON;
  // a hand-edited JSON5 config (comments, trailing commas) will fail this
  // parse loudly rather than being silently mishandled.
  const config: Record<string, unknown> = content.trim().length > 0 ? JSON.parse(content) : {};

  const gateway = asRecord(config, "gateway");
  const controlUi = asRecord(gateway, "controlUi");
  const existingOrigins = Array.isArray(controlUi.allowedOrigins) ? (controlUi.allowedOrigins as unknown[]) : [];
  const origin = `https://${domain}`;

  if (existingOrigins.includes(origin)) {
    return { patched: false };
  }

  controlUi.allowedOrigins = [...existingOrigins, origin];
  const postResult = await postConfigRaw(baseUrl, auth, JSON.stringify(config, null, 2));
  if (!postResult.ok) {
    throw new Error("POST /setup/api/config/raw responded ok:false");
  }
  return { patched: true };
}

function asRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

async function defaultGetConfigRaw(baseUrl: string, auth: SetupAuth): Promise<{ ok: boolean; content: string }> {
  const response = await fetch(`${baseUrl}/setup/api/config/raw`, {
    headers: { authorization: basicAuthHeader(auth) }
  });
  if (!response.ok) {
    throw new Error(`GET /setup/api/config/raw returned ${response.status}`);
  }
  return (await response.json()) as { ok: boolean; content: string };
}

async function defaultPostConfigRaw(baseUrl: string, auth: SetupAuth, content: string): Promise<{ ok: boolean }> {
  const response = await fetch(`${baseUrl}/setup/api/config/raw`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: basicAuthHeader(auth) },
    body: JSON.stringify({ content })
  });
  if (!response.ok) {
    throw new Error(`POST /setup/api/config/raw returned ${response.status}`);
  }
  return (await response.json()) as { ok: boolean };
}
