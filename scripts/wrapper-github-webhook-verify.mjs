// GitHub App webhook signature verification for the pinned Railway wrapper
// (`POST /hooks/github-webhook-verify`).
//
// This module is copied verbatim into the wrapper image next to src/server.js
// (Dockerfile `template-source` stage, `COPY scripts/wrapper-github-webhook-verify.mjs
// src/wrapper-github-webhook-verify.mjs`) and imported by the route registration
// that scripts/patch-wrapper-github-webhook.mjs injects immediately before the
// wrapper's global `app.use(express.json({ limit: "1mb" }));` body parser --
// not merely before the later catch-all `app.use(requireDashboardAuth, ...)`
// proxy to the OpenClaw gateway, though it is also earlier than that. The
// body parser matters: registered after it, this route's own raw-body read
// never sees its 'data'/'end' events fire, because the parser already
// drained the stream -- every request would hang to its own timeout. See
// docs/plans/github-webhook-verify/plan.md's Approach section for the
// empirical repro. Registered correctly, a verified (or rejected) request
// never reaches the gateway at all. It is also imported directly by this
// repo's vitest suite, so it must stay dependency-free: only `node:*`
// built-ins.
//
// Why a dedicated route instead of upstream OpenClaw's `/hooks` gateway or
// bundled `webhooks` plugin: both of those authenticate with a static shared
// secret compared against an `Authorization`/`x-openclaw-webhook-secret`
// header. A GitHub App webhook delivery never sends the secret itself -- it
// HMAC-SHA256-signs the raw request body and sends the digest in
// `X-Hub-Signature-256`. Neither existing mechanism can verify that scheme, so
// this route exists purely to check the signature and respond 200/401 -- no
// dispatch, no agent involvement, no gateway process involvement. See
// docs/plans/github-webhook-verify/plan.md for the full rationale.

import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB
export const GITHUB_WEBHOOK_MAX_BODY_BYTES_ENV = "GITHUB_WEBHOOK_MAX_BODY_BYTES";

/**
 * Resolve the raw-body byte cap: the env override when set to a positive
 * integer, otherwise the 1 MiB default. A malformed override throws rather
 * than silently falling back, so a typo cannot quietly lift the cap. Same
 * pattern as wrapper-state-export.mjs's resolveStateExportMaxBytes.
 */
export function resolveGithubWebhookMaxBytes(env = process.env) {
  const raw = env[GITHUB_WEBHOOK_MAX_BODY_BYTES_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const err = new Error(
      `${GITHUB_WEBHOOK_MAX_BODY_BYTES_ENV} must be a positive integer number of bytes, got ${JSON.stringify(raw)}`,
    );
    // Tagged so the handler can tell a deploy misconfiguration apart from a
    // client's oversize/slow body -- the former is a server-side config
    // error (500), never the client's fault (400).
    err.code = "GITHUB_WEBHOOK_MAX_BYTES_CONFIG_ERROR";
    throw err;
  }
  return parsed;
}
const DEFAULT_TIMEOUT_MS = 10_000;
const ROUTE = "/hooks/github-webhook-verify";

// --- Multi-secret verification (#116) ---------------------------------------

export const GITHUB_WEBHOOK_SECRETS_ENV = "GITHUB_WEBHOOK_SECRETS";

function throwWebhookSecretsConfigError(detail) {
  const err = new Error(`${GITHUB_WEBHOOK_SECRETS_ENV} ${detail}`);
  // Tagged the same way resolveGithubWebhookMaxBytes tags its own config
  // error, so the handler can tell "deploy misconfigured this env var"
  // (500) apart from "this delivery's signature didn't match" (401).
  err.code = "GITHUB_WEBHOOK_SECRETS_CONFIG_ERROR";
  throw err;
}

/**
 * Resolves the list of secrets a delivery's signature may be verified
 * against. `GITHUB_WEBHOOK_SECRETS` (a JSON array of one or more non-empty
 * strings) takes precedence when set to a non-blank value; otherwise falls
 * back to a single-element array built from the legacy `GITHUB_WEBHOOK_SECRET`
 * (unchanged behavior for every existing single-secret deployment); otherwise
 * `[]`. A `GITHUB_WEBHOOK_SECRETS` value that is set but fails to parse as
 * JSON, does not parse to an array, or contains anything other than
 * non-empty strings throws a tagged config error -- mirroring
 * resolveGithubWebhookMaxBytes's fail-loud-on-misconfig pattern. This never
 * silently falls back to the legacy var, and never treats the raw string as
 * one literal secret, because either fallback would quietly narrow the set
 * of Apps a deployment operator believes they configured.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function resolveGithubWebhookSecrets(env = process.env) {
  const raw = env[GITHUB_WEBHOOK_SECRETS_ENV];
  if (typeof raw === "string" && raw.trim() !== "") {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throwWebhookSecretsConfigError(`must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!Array.isArray(parsed)) {
      throwWebhookSecretsConfigError("must be a JSON array");
    }
    for (const entry of parsed) {
      if (typeof entry !== "string" || entry === "") {
        throwWebhookSecretsConfigError("every element must be a non-empty string");
      }
    }
    // A deliberately-configured empty array ("[]") is accepted as-is (no
    // secrets currently enrolled) rather than falling through to the legacy
    // var -- an explicit GITHUB_WEBHOOK_SECRETS always wins once it's set to
    // a non-blank value, empty or not.
    return parsed;
  }
  const legacy = env.GITHUB_WEBHOOK_SECRET;
  if (typeof legacy === "string" && legacy !== "") return [legacy];
  return [];
}

/**
 * True if `headerValue` verifies against ANY secret in `secrets`, using the
 * existing timing-safe `verifyGithubSignature` for each candidate. False if
 * `secrets` is empty. Every candidate is compared unconditionally -- the
 * loop never short-circuits on the first match -- so a match at index 0
 * takes observably the same number of comparisons as a match at the end (or
 * no match at all); each individual comparison is already timing-safe via
 * `timingSafeEqual`, and this keeps the *number of comparisons made* from
 * also becoming an observable signal of which secret (or how many) matched.
 * Never reveals which secret matched -- only whether at least one did.
 *
 * @param {string[]} secrets
 * @param {Buffer} rawBody
 * @param {string | undefined} headerValue
 * @returns {boolean}
 */
export function verifyAnyGithubSignature(secrets, rawBody, headerValue) {
  if (!Array.isArray(secrets) || secrets.length === 0) return false;
  let matched = false;
  for (const secret of secrets) {
    if (verifyGithubSignature(secret, rawBody, headerValue)) matched = true;
  }
  return matched;
}

// --- Dedup key / session key computation (#117) -----------------------------

/**
 * Resolves the PR/issue resource number a payload refers to, or undefined
 * if the event type is unsupported or the field is missing/wrong-typed.
 * Shared by computeDedupKey, computeSessionKey, and forwardToAgentHook's
 * trigger-building so all three agree on where this number lives.
 *
 * @param {string} event
 * @param {any} payload
 * @returns {number | undefined}
 */
function resourceNumberFor(event, payload) {
  if (event === "pull_request") {
    // GitHub sends the PR number both top-level (`number`) and nested
    // (`pull_request.number`) on this event; prefer the nested one since
    // it's unambiguously scoped to the PR object itself.
    const n = payload?.pull_request?.number ?? payload?.number;
    return typeof n === "number" ? n : undefined;
  }
  if (event === "issue_comment") {
    const n = payload?.issue?.number;
    return typeof n === "number" ? n : undefined;
  }
  return undefined;
}

/**
 * The pull_request-specific field computeDedupKey/computeSessionKey both
 * require to consider a pull_request payload well-formed, or undefined if
 * it's missing/wrong-typed.
 *
 * @param {any} payload
 * @returns {string | undefined}
 */
function pullRequestHeadSha(payload) {
  const sha = payload?.pull_request?.head?.sha;
  return typeof sha === "string" && sha !== "" ? sha : undefined;
}

/**
 * The issue_comment-specific field computeDedupKey/computeSessionKey both
 * require to consider an issue_comment payload well-formed, or undefined if
 * it's missing/wrong-typed.
 *
 * @param {any} payload
 * @returns {string | number | undefined}
 */
function issueCommentId(payload) {
  const id = payload?.comment?.id;
  return typeof id === "number" || typeof id === "string" ? id : undefined;
}

/**
 * repo + resource number + observed head for `pull_request`
 * (`owner/repo#N@sha`); repo + resource number + comment id for
 * `issue_comment` (`owner/repo#N/comment-<id>`). Deliberately DIFFERENT from
 * computeSessionKey -- this key changes on every new head push or new
 * comment, precisely so a dedup check keyed on it treats each as a distinct
 * delivery, while computeSessionKey (repo + resource number ONLY) stays
 * stable across all of them so the dispatched agent keeps one session per
 * PR/issue.
 *
 * @param {string} event
 * @param {any} payload
 * @returns {string | undefined}
 */
export function computeDedupKey(event, payload) {
  const repo = payload?.repository?.full_name;
  if (typeof repo !== "string" || repo === "") return undefined;
  const number = resourceNumberFor(event, payload);
  if (typeof number !== "number") return undefined;

  if (event === "pull_request") {
    const sha = pullRequestHeadSha(payload);
    if (sha === undefined) return undefined;
    return `${repo}#${number}@${sha}`;
  }
  if (event === "issue_comment") {
    const commentId = issueCommentId(payload);
    if (commentId === undefined) return undefined;
    return `${repo}#${number}/comment-${commentId}`;
  }
  return undefined;
}

/**
 * repo + resource number ONLY (`owner/repo#N`) -- stable across every
 * delivery on the same PR/issue regardless of event type, head, or comment
 * id. This is deliberately NOT the dedup key: an earlier draft of this
 * design computed a session key that varied with head/comment id, which
 * gave the dispatched agent a fresh, unrelated session on every delivery
 * instead of one continuous session per PR/issue.
 *
 * Returns undefined under the same malformed-payload condition as
 * computeDedupKey -- this function's OUTPUT never includes head sha /
 * comment id, but it still requires their PRESENCE before returning
 * anything, matching computeDedupKey's own validation exactly. A payload
 * missing a field its event type requires is treated as
 * malformed/untrustworthy for BOTH keys together, not just the one whose
 * output happens to need that field: if the payload isn't a genuine,
 * complete instance of this event type, neither key should be built from it.
 *
 * @param {string} event
 * @param {any} payload
 * @returns {string | undefined}
 */
export function computeSessionKey(event, payload) {
  const repo = payload?.repository?.full_name;
  if (typeof repo !== "string" || repo === "") return undefined;
  const number = resourceNumberFor(event, payload);
  if (typeof number !== "number") return undefined;

  if (event === "pull_request") {
    if (pullRequestHeadSha(payload) === undefined) return undefined;
    return `${repo}#${number}`;
  }
  if (event === "issue_comment") {
    if (issueCommentId(payload) === undefined) return undefined;
    return `${repo}#${number}`;
  }
  return undefined;
}

// --- Dispatch allowlist (#117) -----------------------------------------------

export const GITHUB_DISPATCH_ALLOWLIST_ENV = "GITHUB_DISPATCH_ALLOWLIST";

function throwDispatchAllowlistConfigError(detail) {
  const err = new Error(`${GITHUB_DISPATCH_ALLOWLIST_ENV} ${detail}`);
  err.code = "GITHUB_DISPATCH_ALLOWLIST_CONFIG_ERROR";
  throw err;
}

/**
 * Validates one `GITHUB_DISPATCH_ALLOWLIST` entry's shape, throwing a
 * tagged config error on any violation:
 *
 * ```
 * {
 *   repo: "owner/repo",
 *   events: [
 *     { event: "pull_request", actions: ["opened", "synchronize"] },
 *     { event: "issue_comment", actions: ["created"],
 *       trustedMention: { actors: ["some-actor"], pattern: "@some-bot\\b" } }
 *   ]
 * }
 * ```
 *
 * An `issue_comment` event entry MUST carry `trustedMention` -- there is no
 * actor/mention gate for any other event type, so requiring it only there
 * is deliberate, not an oversight.
 *
 * @param {any} entry
 */
function validateDispatchAllowlistEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throwDispatchAllowlistConfigError("each entry must be a JSON object");
  }
  if (typeof entry.repo !== "string" || entry.repo.trim() === "") {
    throwDispatchAllowlistConfigError("each entry must have a non-empty string \"repo\"");
  }
  if (!Array.isArray(entry.events) || entry.events.length === 0) {
    throwDispatchAllowlistConfigError(`entry for "${entry.repo}" must have a non-empty "events" array`);
  }
  for (const eventEntry of entry.events) {
    if (!eventEntry || typeof eventEntry !== "object" || Array.isArray(eventEntry)) {
      throwDispatchAllowlistConfigError(`entry for "${entry.repo}" has a malformed "events" item`);
    }
    if (typeof eventEntry.event !== "string" || eventEntry.event.trim() === "") {
      throwDispatchAllowlistConfigError(`entry for "${entry.repo}" has an "events" item missing "event"`);
    }
    const actions = eventEntry.actions;
    if (!Array.isArray(actions) || actions.length === 0 || actions.some((a) => typeof a !== "string" || a === "")) {
      throwDispatchAllowlistConfigError(
        `entry for "${entry.repo}" event "${eventEntry.event}" must have a non-empty "actions" array of strings`
      );
    }
    if (eventEntry.event === "issue_comment") {
      const trusted = eventEntry.trustedMention;
      const actorsOk = trusted && Array.isArray(trusted.actors) && trusted.actors.length > 0
        && trusted.actors.every((a) => typeof a === "string" && a !== "");
      const patternOk = trusted && typeof trusted.pattern === "string" && trusted.pattern !== "";
      if (!actorsOk || !patternOk) {
        throwDispatchAllowlistConfigError(
          `entry for "${entry.repo}" permits issue_comment but is missing a valid trustedMention {actors: string[], pattern: string}`
        );
      }
    }
  }
}

/**
 * Reads `GITHUB_DISPATCH_ALLOWLIST` (a JSON array string): each entry names
 * a repo, its permitted `{ event, actions[] }` combinations, and (only
 * where `issue_comment` is permitted) a `trustedMention` condition (actor
 * allowlist + mention pattern) -- see validateDispatchAllowlistEntry's
 * docstring for the exact shape. Empty/unset resolves to `[]`. Malformed
 * JSON or a shape violation throws a tagged config error (fail loud, not
 * fail open): an allowlist that can't be parsed must never be silently
 * treated as "allow nothing" mistaken for "allow everything," and must not
 * crash the request pipeline either -- callers must treat a thrown resolve
 * as "do not forward, log a config-error line," never let it propagate to a
 * 500 back to GitHub for what is a deploy-config problem, not this
 * delivery's fault.
 *
 * No repository, actor, or workflow name is hardcoded anywhere in this
 * module -- every value here is deployment-owner configuration supplied at
 * runtime via this env var.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Array<{ repo: string, events: Array<{ event: string, actions: string[], trustedMention?: { actors: string[], pattern: string } }> }>}
 */
export function resolveDispatchAllowlist(env = process.env) {
  const raw = env[GITHUB_DISPATCH_ALLOWLIST_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throwDispatchAllowlistConfigError(`must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throwDispatchAllowlistConfigError("must be a JSON array");
  }
  for (const entry of parsed) validateDispatchAllowlistEntry(entry);
  return parsed;
}

/**
 * True only if `repoFullName` has an entry permitting this `(event,
 * action)` pair, AND, for `issue_comment` specifically, `actorLogin` is in
 * that entry's `trustedMention.actors` AND `commentBody` matches
 * `trustedMention.pattern` (treated as a `RegExp` source; an invalid
 * pattern is treated as a non-match rather than throwing, since a bad
 * pattern is caught earlier by resolveDispatchAllowlist's own validation --
 * this is defense in depth, not the primary validation path).
 *
 * `commentBody` is used ONLY for this boolean pattern match -- it is never
 * returned, logged, or included in anything this function's caller
 * forwards (see AC-SEC-3 in docs/plans/github-webhook-agent-dispatch/ACs.md).
 *
 * @param {Array<{ repo: string, events: Array<{ event: string, actions: string[], trustedMention?: { actors: string[], pattern: string } }> }>} entries
 * @param {string} event
 * @param {string | undefined} action
 * @param {string | undefined} repoFullName
 * @param {string | undefined} actorLogin
 * @param {string | undefined} commentBody
 * @returns {boolean}
 */
export function matchesDispatchAllowlist(entries, event, action, repoFullName, actorLogin, commentBody) {
  if (!Array.isArray(entries) || typeof repoFullName !== "string" || repoFullName === "") return false;
  const repoEntry = entries.find((e) => e && e.repo === repoFullName);
  if (!repoEntry || !Array.isArray(repoEntry.events)) return false;
  const eventEntry = repoEntry.events.find(
    (e) => e && e.event === event && Array.isArray(e.actions) && typeof action === "string" && e.actions.includes(action)
  );
  if (!eventEntry) return false;

  if (event === "issue_comment") {
    const trusted = eventEntry.trustedMention;
    if (!trusted || !Array.isArray(trusted.actors) || typeof trusted.pattern !== "string") return false;
    if (typeof actorLogin !== "string" || !trusted.actors.includes(actorLogin)) return false;
    if (typeof commentBody !== "string") return false;
    let pattern;
    try {
      pattern = new RegExp(trusted.pattern);
    } catch {
      return false;
    }
    return pattern.test(commentBody);
  }

  return true;
}

// --- Forwarding to OpenClaw's /hooks/agent (#117) ---------------------------
//
// WHERE /hooks/agent LIVES, EMPIRICALLY CONFIRMED (not assumed): downloaded
// the pinned wrapper template's own src/server.js (same OPENCLAW_TEMPLATE_REF
// this repo's Dockerfile pins) and read its proxy setup directly, the same
// method used to find #108's body-parser ordering issue. That file computes:
//
//   const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
//   const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
//   const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;
//
// and proxies the wrapper's own unauthenticated dashboard traffic to exactly
// that target (`httpProxy.createProxyServer({ target: GATEWAY_TARGET, ... })`),
// injecting `Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}` when a request
// arrives with none. So: the OpenClaw gateway process this wrapper is anchored
// ahead of (see this file's top-of-file comment) always listens on plain HTTP
// at `INTERNAL_GATEWAY_HOST:INTERNAL_GATEWAY_PORT` inside the same container --
// reachable from this wrapper process via a real HTTP call, never an in-process
// function call. Reusing those exact env var names (rather than inventing new
// ones) means this module's default target tracks the wrapper's own gateway
// target automatically if either is ever overridden.
//
// `/hooks/agent`'s bearer token is a SEPARATE value from `OPENCLAW_GATEWAY_TOKEN`
// above: the Current State note in
// docs/plans/github-webhook-agent-dispatch/plan.md is explicit that
// `/hooks/agent` is gated by its own `hooks.token` config (`hooks.enabled` /
// `hooks.token` / `hooks.path` in `openclaw.json`), not the wrapper's
// dashboard-proxy gateway token -- so a dedicated env var is used for it
// rather than reusing OPENCLAW_GATEWAY_TOKEN.

const DEFAULT_INTERNAL_GATEWAY_HOST = "127.0.0.1";
const DEFAULT_INTERNAL_GATEWAY_PORT = "18789";
const AGENT_HOOK_PATH = "/hooks/agent";

/** Same names/defaults the pinned wrapper's own server.js uses for its gateway proxy target (see comment block above) -- reused, not reinvented. */
const INTERNAL_GATEWAY_HOST_ENV = "INTERNAL_GATEWAY_HOST";
const INTERNAL_GATEWAY_PORT_ENV = "INTERNAL_GATEWAY_PORT";

/** This module's own env vars for the /hooks/agent call specifically. */
export const OPENCLAW_AGENT_HOOK_URL_ENV = "OPENCLAW_AGENT_HOOK_URL";
export const OPENCLAW_AGENT_HOOK_TOKEN_ENV = "OPENCLAW_AGENT_HOOK_TOKEN";

/**
 * Resolves the full URL to POST a dispatch to. `OPENCLAW_AGENT_HOOK_URL`
 * (a complete URL) takes precedence when set to a non-blank value --
 * useful if `hooks.path` is ever reconfigured away from the default, or the
 * gateway is reached through some other route in a given deployment.
 * Otherwise builds `http://<INTERNAL_GATEWAY_HOST>:<INTERNAL_GATEWAY_PORT>/hooks/agent`
 * from the same env vars (and same defaults, 127.0.0.1:18789) the pinned
 * wrapper's own server.js uses for its gateway proxy target -- see the
 * comment block above this section for how that was confirmed.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveAgentHookUrl(env = process.env) {
  const explicit = env[OPENCLAW_AGENT_HOOK_URL_ENV];
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit;
  const host = env[INTERNAL_GATEWAY_HOST_ENV] || DEFAULT_INTERNAL_GATEWAY_HOST;
  const port = env[INTERNAL_GATEWAY_PORT_ENV] || DEFAULT_INTERNAL_GATEWAY_PORT;
  return `http://${host}:${port}${AGENT_HOOK_PATH}`;
}

/**
 * POSTs `{ sessionKey, trigger: { event, repo, resource, actor, deliveryId } }`
 * -- explicitly NOT the raw comment/PR body, only these labeled,
 * non-executable metadata fields pulled off `payload` -- to
 * `options.hookUrl` (default `resolveAgentHookUrl()`) with
 * `options.hookToken` (default `process.env[OPENCLAW_AGENT_HOOK_TOKEN_ENV]`)
 * as a bearer token header, matching the `Authorization: Bearer <token>`
 * convention the pinned wrapper's own gateway proxy already uses (see
 * comment block above).
 *
 * Never throws on the downstream call failing: a network error, a rejected
 * promise, or a non-2xx response is caught/checked here and logged via
 * `console.error` (not the caller's injectable `log`, matching this
 * module's own config-error precedent), returning `{ forwarded: false }` --
 * so a hook-endpoint outage degrades to "verified but not dispatched,"
 * never a 5xx back to GitHub for something GitHub didn't cause.
 *
 * @param {string} sessionKey
 * @param {string} event
 * @param {any} payload
 * @param {{ hookUrl?: string, hookToken?: string, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ forwarded: boolean }>}
 */
export async function forwardToAgentHook(sessionKey, event, payload, options = {}) {
  const hookUrl = options.hookUrl ?? resolveAgentHookUrl();
  const hookToken = options.hookToken ?? process.env[OPENCLAW_AGENT_HOOK_TOKEN_ENV];
  const fetchImpl = options.fetchImpl ?? fetch;

  const trigger = {
    event,
    repo: payload?.repository?.full_name,
    resource: resourceNumberFor(event, payload),
    actor: payload?.sender?.login,
    deliveryId: payload?.deliveryId,
  };

  try {
    const headers = { "content-type": "application/json" };
    if (typeof hookToken === "string" && hookToken !== "") {
      headers.authorization = `Bearer ${hookToken}`;
    }
    const response = await fetchImpl(hookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionKey, trigger }),
    });
    if (!response || !response.ok) {
      console.error(`[github-webhook-verify] agent hook forward failed: HTTP ${response?.status ?? "no response"}`);
      return { forwarded: false };
    }
    return { forwarded: true };
  } catch (err) {
    console.error(`[github-webhook-verify] agent hook forward errored: ${err instanceof Error ? err.message : String(err)}`);
    return { forwarded: false };
  }
}

/**
 * Computes the GitHub webhook signature for a raw request body under a given
 * secret: `"sha256=" + hex(HMAC-SHA256(secret, rawBody))`, matching the value
 * GitHub sends in the `X-Hub-Signature-256` header.
 *
 * @param {string} secret
 * @param {Buffer} rawBody
 * @returns {string}
 */
export function computeGithubSignature(secret, rawBody) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/**
 * Verifies a `X-Hub-Signature-256` header value against a raw body and
 * secret. Returns false (never throws) for any falsy secret or headerValue, a
 * length mismatch against the expected signature, or a failed timing-safe
 * compare -- true only on an exact match.
 *
 * @param {string} secret
 * @param {Buffer} rawBody
 * @param {string | undefined} headerValue
 * @returns {boolean}
 */
export function verifyGithubSignature(secret, rawBody, headerValue) {
  if (!secret || typeof headerValue !== "string" || !headerValue) return false;
  const expected = computeGithubSignature(secret, rawBody);
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(headerValue, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  // timingSafeEqual requires equal-length buffers, guaranteed by the check
  // above; the try/catch is defense in depth, not a reachable path.
  try {
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

/**
 * Reads a request body into a single Buffer without any framework body
 * parser, so the exact bytes GitHub signed are what gets HMAC'd -- a
 * re-serialized (e.g. JSON.parse then JSON.stringify) body would not match
 * the signature. Rejects (never resolves with a partial buffer) if the body
 * exceeds `maxBytes`, the read exceeds `timeoutMs`, or the stream emits an
 * `error`.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {{ maxBytes?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<Buffer>}
 */
export function readRawBody(req, opts = {}) {
  const maxBytes = opts.maxBytes ?? resolveGithubWebhookMaxBytes();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    // Fast-fail if the stream has already ended before we got here -- e.g. a
    // body parser registered earlier in the request pipeline already
    // consumed it. Without this check, 'data'/'end' listeners attached below
    // would never fire and this would hang to the full timeout on every such
    // request instead of failing immediately with a clear cause. This is
    // exactly the failure mode closed at the route-registration level by
    // anchoring ahead of the wrapper's body parser (see plan.md) -- this
    // guard is defense in depth for that class of regression, not a
    // replacement for correct anchoring.
    if (req.readableEnded) {
      const err = new Error("readRawBody called on an already-ended request stream");
      err.code = "READ_RAW_BODY_ALREADY_ENDED";
      reject(err);
      return;
    }

    const chunks = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };
    const settle = (err, buf) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(buf);
    };

    // On a limit/timeout rejection we deliberately do NOT call req.destroy()
    // here: destroying a real socket before the caller has had a chance to
    // send a response tears the connection down first, so the client sees
    // ECONNRESET instead of the intended 400 -- verified empirically against
    // a real http.createServer(). cleanup() above already stops consuming
    // (removes the data/end/error listeners), which is enough to let the
    // stream sit idle; the caller (handleGithubWebhookVerify) is responsible
    // for closing the underlying connection only after its response has
    // actually been sent.
    const timer = setTimeout(() => {
      const err = new Error(`readRawBody timed out after ${timeoutMs}ms`);
      err.code = "READ_RAW_BODY_TIMEOUT";
      settle(err);
    }, timeoutMs);
    timer.unref?.();

    const onData = (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const err = new Error(`request body exceeds ${maxBytes}-byte limit`);
        err.code = "READ_RAW_BODY_TOO_LARGE";
        settle(err);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => settle(null, Buffer.concat(chunks));
    const onError = (err) => settle(err instanceof Error ? err : new Error(String(err)));

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/**
 * Handles `POST /hooks/github-webhook-verify`: verifies the GitHub App
 * webhook signature and responds 200/401/404/405/400 per the response
 * matrix below. No dispatch, no agent involvement -- this either accepts or
 * rejects the delivery and nothing else.
 *
 * - A configured `GITHUB_WEBHOOK_SECRETS` that fails to resolve (malformed
 *   JSON / wrong shape) -> 500, before reading the body or comparing
 *   anything -- a deploy-config problem, never the client's fault.
 * - No secret configured at all (`options.secret` unset AND
 *   `resolveGithubWebhookSecrets()` resolves to `[]`) -> 404, body
 *   "Not Found", before reading the body or comparing anything. This keeps
 *   every instance that hasn't opted in inert by default.
 * - Non-POST -> 405, `Allow: POST`. Defensive: the patch script registers
 *   this handler via `app.post(...)`, so Express's own router already
 *   filters to POST before this handler ever runs in the deployed route --
 *   this branch is unreachable through it today, and exists only in case
 *   the handler is ever reused behind a method-agnostic registration.
 * - Body read failure (oversize / timeout / stream error) -> 400.
 * - Signature does not verify against ANY configured secret -> 401; logs
 *   only `{route, result:"rejected"}` -- never the payload, never the
 *   signature, never the body.
 * - Signature verifies -> 200, body "ok"; logs
 *   `{route, result:"accepted", event, deliveryId, repo, dispatch}` where
 *   `event` and `deliveryId` come from the `X-Github-Event`/
 *   `X-Github-Delivery` headers, `repo` is the verified body's
 *   `repository.full_name` when it parses as JSON (undefined otherwise -- a
 *   parse failure here only affects what gets logged, not the
 *   already-decided 200 response), and `dispatch` is the bounded dispatch
 *   decision (see `planDispatch` below) computed BEFORE this log line and
 *   the response are sent -- it can never change the response, and every
 *   failure mode in the decision (malformed allowlist config, an
 *   unenrolled/untrusted/duplicate delivery) is caught and folded into that
 *   one bounded value, never thrown back out of this function. Only the
 *   ACTUAL `forwardToAgentHook` network call (when `dispatch === "forwarded"`)
 *   happens after the response above -- see this function's body.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{
 *   secret?: string,
 *   log?: (line: string) => void,
 *   dedupStore?: { has(key: string): boolean, add(key: string): unknown },
 *   forward?: { hookUrl?: string, hookToken?: string, fetchImpl?: typeof fetch },
 * }} [options]
 * @returns {Promise<void>}
 */
export async function handleGithubWebhookVerify(req, res, options = {}) {
  const log = options.log ?? console.log;

  let secrets;
  try {
    secrets = resolveSecretsForRequest(options);
  } catch (err) {
    if (err?.code === "GITHUB_WEBHOOK_SECRETS_CONFIG_ERROR") {
      console.error(`[github-webhook-verify] config error: ${err.message}`);
      res.statusCode = 500;
      res.end();
      return;
    }
    throw err;
  }

  if (secrets.length === 0) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end();
    return;
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    if (err?.code === "GITHUB_WEBHOOK_MAX_BYTES_CONFIG_ERROR") {
      // A malformed GITHUB_WEBHOOK_MAX_BODY_BYTES is a deploy/config error,
      // not anything the client did -- surface it as 500, not 400, and log
      // it so a bad config doesn't read as "clients keep sending oversize
      // bodies."
      console.error(`[github-webhook-verify] config error: ${err.message}`);
      res.statusCode = 500;
      res.end();
      return;
    }
    // readRawBody deliberately did not destroy the request stream on a
    // limit/timeout rejection (see its own comment) -- respond first, and
    // only close the now-idle connection once the response has actually
    // been flushed, so the client receives the 400 status instead of a bare
    // connection reset.
    res.statusCode = 400;
    res.setHeader("Connection", "close");
    res.once("finish", () => req.destroy?.());
    res.end();
    return;
  }

  const headerValue = req.headers["x-hub-signature-256"];
  if (!verifyAnyGithubSignature(secrets, rawBody, headerValue)) {
    res.statusCode = 401;
    log(JSON.stringify({ route: ROUTE, result: "rejected" }));
    res.end();
    return;
  }

  let parsedPayload;
  let repo;
  try {
    parsedPayload = JSON.parse(rawBody.toString("utf8"));
    repo = parsedPayload && typeof parsedPayload === "object" ? parsedPayload.repository?.full_name : undefined;
  } catch {
    parsedPayload = undefined;
    repo = undefined;
  }

  const event = req.headers["x-github-event"];
  const deliveryId = req.headers["x-github-delivery"];

  // The dispatch DECISION (dedup check, allowlist consult) is entirely
  // synchronous -- no network call, no await -- so it's made BEFORE the
  // response is logged/sent, letting the outcome ride along in the SAME log
  // line as the existing {route, result, event, deliveryId, repo} shape
  // (AC-SEC-2: "the existing shape plus a bounded dispatch-outcome field",
  // not a second, separate log line). Only the ACTUAL `forwardToAgentHook`
  // network call happens after the response below.
  const dedupStore = options.dedupStore ?? defaultForwardedDeliveries;
  const decision = planDispatch({ event, payload: parsedPayload, dedupStore });

  log(
    JSON.stringify({
      route: ROUTE,
      result: "accepted",
      event,
      deliveryId,
      repo,
      dispatch: decision.dispatch,
    }),
  );
  res.statusCode = 200;
  res.end("ok");

  if (decision.dispatch === "forwarded") {
    // "forwarded" here records that an eligible, matching, non-duplicate
    // delivery WAS handed to forwardToAgentHook -- forwardToAgentHook logs
    // its own separate failure line (via console.error, see its own
    // docstring) if the downstream call itself didn't succeed, keeping this
    // function's own bounded outcome vocabulary fixed at exactly five
    // values regardless of the network result (AC-SEC-2).
    await forwardToAgentHook(decision.sessionKey, event, { ...parsedPayload, deliveryId }, options.forward);
  }
}

/**
 * Resolves the secret candidates for one request. `options.secret` (a
 * single literal secret) predates multi-secret support and is preserved
 * for backward compatibility -- every existing caller/test that passes one
 * secret directly keeps working byte-for-byte (AC-FN-3). Only when it's
 * absent does this consult the new multi-secret resolver
 * (`GITHUB_WEBHOOK_SECRETS`, falling back to legacy `GITHUB_WEBHOOK_SECRET`).
 *
 * @param {{ secret?: string }} options
 * @returns {string[]}
 */
function resolveSecretsForRequest(options) {
  if (typeof options.secret === "string" && options.secret !== "") {
    return [options.secret];
  }
  return resolveGithubWebhookSecrets();
}

/**
 * The in-memory "already forwarded" set `handleGithubWebhookVerify` uses by
 * default when `options.dedupStore` isn't supplied. A small `Set` is
 * sufficient for this process's own lifetime -- this route's whole design
 * (see docs/plans/github-webhook-agent-dispatch/plan.md) is a single
 * wrapper process with no external datastore, and losing this set on a
 * restart only means a delivery already forwarded before the restart could
 * be forwarded again after one, which is a re-delivery, not a correctness
 * bug (the downstream agent turn is responsible for its own idempotency
 * once dispatched -- out of scope here, see the plan's Out of Scope
 * section). Exposed via `options.dedupStore` specifically so tests (or an
 * alternate wiring) can supply their own instead of sharing this module-level
 * one across unrelated calls.
 */
const defaultForwardedDeliveries = new Set();

/**
 * Makes the post-verification dispatch DECISION -- entirely synchronous, no
 * network call -- so its outcome can ride along in the same log line as the
 * existing accepted-delivery log (AC-SEC-2). Computes the dedup key and
 * session key, treats an unsupported event type or a payload missing a
 * required field as "not-enrolled," checks `dedupStore` for a repeat
 * delivery ("duplicate"), resolves and consults the dispatch allowlist
 * (treating a thrown resolve as "config-error," never letting it escape to
 * the caller), and on a match, marks the dedup key as forwarded and returns
 * `{ dispatch: "forwarded", sessionKey }` for the caller to actually POST
 * with `forwardToAgentHook`. The dedup key is marked HERE (synchronously,
 * before any network call is even started) to close the race window
 * between two near-simultaneous deliveries carrying the same dedup key --
 * matches this file's existing "fail fast / close the obvious race"
 * conventions elsewhere (see readRawBody's settle()).
 *
 * @param {{ event: string | undefined, payload: any, dedupStore: { has(key: string): boolean, add(key: string): unknown } }} args
 * @returns {{ dispatch: "not-enrolled" | "duplicate" | "config-error" | "no-match" | "forwarded", sessionKey?: string }}
 */
function planDispatch({ event, payload, dedupStore }) {
  if (typeof event !== "string") {
    return { dispatch: "not-enrolled" };
  }

  const dedupKey = computeDedupKey(event, payload);
  const sessionKey = computeSessionKey(event, payload);
  if (dedupKey === undefined || sessionKey === undefined) {
    // Unsupported event type (e.g. push/ping) or a malformed payload missing
    // the fields this event type requires -- either way, there is nothing
    // to safely key a session or a dedup check on, so this delivery is
    // simply not eligible for dispatch.
    return { dispatch: "not-enrolled" };
  }

  if (dedupStore.has(dedupKey)) {
    return { dispatch: "duplicate" };
  }

  let allowlist;
  try {
    allowlist = resolveDispatchAllowlist();
  } catch (err) {
    console.error(`[github-webhook-verify] config error: ${err instanceof Error ? err.message : String(err)}`);
    return { dispatch: "config-error" };
  }

  const repoFullName = payload?.repository?.full_name;
  const action = payload?.action;
  const actorLogin = payload?.sender?.login;
  // commentBody is read here ONLY to hand to matchesDispatchAllowlist's
  // pattern check immediately below -- it is never logged, never assigned
  // into the forwarded trigger, and never passed to forwardToAgentHook
  // (AC-SEC-3).
  const commentBody = event === "issue_comment" ? payload?.comment?.body : undefined;

  if (!matchesDispatchAllowlist(allowlist, event, action, repoFullName, actorLogin, commentBody)) {
    return { dispatch: "no-match" };
  }

  dedupStore.add(dedupKey);
  return { dispatch: "forwarded", sessionKey };
}
