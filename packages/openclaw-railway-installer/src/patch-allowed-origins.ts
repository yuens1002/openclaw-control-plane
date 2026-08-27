// LIVE-INSTANCE TIER: restart-or-redeploy-triggering
// See docs/live-instance-operations.md for what this tier permits.
//
// Compare-then-write: GETs the raw config first and returns
// `{ patched: false }` without POSTing when `existingOrigins` already
// includes the origin. That compare is the only thing keeping the common
// path off this tier -- POSTing this endpoint always restarts the gateway
// once the instance reports configured (evidence:
// docs/plans/post-deploy-readiness/plan.md, Item 4), so every skipped POST
// is a skipped live restart. When the POST does fire, this module re-reads
// the config and asserts the origin is actually present before returning --
// the post-write verification half the protocol's idempotent-write rule
// requires, matching the profile-apply path.
//
// Issue #77: on a genuinely fresh instance (no `openclaw.json` yet), the
// GET above reads back whatever minimal/default document the wrapper
// serves for an unconfigured instance -- which has no `gateway.mode`. This
// read-merge-write cycle protects against a *redundant* write (the origin
// compare above), but not against writing back an *incomplete* one: a
// config with `allowedOrigins` set but no `gateway.mode` makes the wrapper
// treat the file as suspicious/clobbered and refuse to start the gateway
// at all. So the write is also refused -- not just the redundant one --
// when the document read back has no `gateway.mode`: this function only
// ever writes a document it read as already carrying a baseline `gateway`
// section, never one it would be completing on the instance's behalf.
// `bootstrapOnboardingCycle` retries this call once `/setup/api/run` has
// established that baseline, so the origin still lands in the common
// provisioning flow -- just after setup instead of before it.

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

  // Refuse to write back a document that has no baseline `gateway.mode` --
  // see the issue #77 note above. `gateway` here is whatever `asRecord`
  // read (and possibly just created as `{}` for a missing/empty document),
  // so an absent or non-string `mode` means there is no real baseline yet.
  if (typeof gateway.mode !== "string" || gateway.mode.trim().length === 0) {
    return { patched: false };
  }

  controlUi.allowedOrigins = [...existingOrigins, origin];
  const postResult = await postConfigRaw(baseUrl, auth, JSON.stringify(config, null, 2));
  if (!postResult.ok) {
    throw new Error("POST /setup/api/config/raw responded ok:false");
  }

  // Post-write verification. A POST that returns ok:true reports that the
  // request was accepted, not that the intended value is present -- so re-read
  // and assert it. No wait is needed before this read despite the POST
  // restarting the gateway: /setup/api/config/raw is served by the wrapper
  // itself, reading the config file directly, and is never proxied to the
  // gateway. Adding a sleep here would only slow the common path.
  const verifyResult = await getConfigRaw(baseUrl, auth);
  if (!verifyResult.ok) {
    throw new Error("Post-write verification failed: GET /setup/api/config/raw responded ok:false");
  }
  let verifiedOrigins: unknown[];
  try {
    verifiedOrigins = readAllowedOrigins(verifyResult.content);
  } catch (cause) {
    // A bare SyntaxError here would read as a parse bug rather than as the
    // write having produced a config this process can no longer validate.
    throw new Error(
      `Post-write verification failed: the config returned after the write is not parseable JSON. ${String(cause)}`,
      { cause }
    );
  }
  if (!verifiedOrigins.includes(origin)) {
    throw new Error(
      `Post-write verification failed: ${origin} is absent from gateway.controlUi.allowedOrigins after the write reported success`
    );
  }
  return { patched: true };
}

/**
 * Reads `gateway.controlUi.allowedOrigins` out of a raw config document
 * without creating any of the intermediate objects. Deliberately separate
 * from `asRecord`, which materialises the path so the write can target it --
 * a verification read must not mutate what it is checking, and must tolerate
 * a config whose shape changed underneath the write.
 */
function readAllowedOrigins(content: string): unknown[] {
  const parsed: unknown = content.trim().length > 0 ? JSON.parse(content) : {};
  const gateway = readObject(parsed, "gateway");
  const controlUi = readObject(gateway, "controlUi");
  const origins = controlUi?.allowedOrigins;
  return Array.isArray(origins) ? origins : [];
}

function readObject(parent: unknown, key: string): Record<string, unknown> | undefined {
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
    return undefined;
  }
  const value = (parent as Record<string, unknown>)[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
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
