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
const DEFAULT_TIMEOUT_MS = 10_000;
const ROUTE = "/hooks/github-webhook-verify";

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
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
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

    const timer = setTimeout(() => {
      req.destroy?.();
      settle(new Error(`readRawBody timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    const onData = (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy?.();
        settle(new Error(`request body exceeds ${maxBytes}-byte limit`));
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
 * - No secret configured (`options.secret` / `GITHUB_WEBHOOK_SECRET` unset)
 *   -> 404, body "Not Found", before reading the body or comparing anything.
 *   This keeps every instance that hasn't opted in inert by default.
 * - Non-POST -> 405, `Allow: POST`.
 * - Body read failure (oversize / timeout / stream error) -> 400.
 * - Signature does not verify -> 401; logs only `{route, result:"rejected"}`
 *   -- never the payload, never the signature, never the body.
 * - Signature verifies -> 200, body "ok"; logs
 *   `{route, result:"accepted", event, deliveryId, repo}` where `event` and
 *   `deliveryId` come from the `X-Github-Event`/`X-Github-Delivery` headers
 *   and `repo` is the verified body's `repository.full_name` when it parses
 *   as JSON (undefined otherwise -- a parse failure here only affects what
 *   gets logged, not the already-decided 200 response).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{ secret?: string, log?: (line: string) => void }} [options]
 * @returns {Promise<void>}
 */
export async function handleGithubWebhookVerify(req, res, options = {}) {
  const secret = options.secret ?? process.env.GITHUB_WEBHOOK_SECRET;
  const log = options.log ?? console.log;

  if (!secret) {
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
  } catch {
    res.statusCode = 400;
    res.end();
    return;
  }

  const headerValue = req.headers["x-hub-signature-256"];
  if (!verifyGithubSignature(secret, rawBody, headerValue)) {
    res.statusCode = 401;
    log(JSON.stringify({ route: ROUTE, result: "rejected" }));
    res.end();
    return;
  }

  let repo;
  try {
    const parsed = JSON.parse(rawBody.toString("utf8"));
    repo = parsed && typeof parsed === "object" ? parsed.repository?.full_name : undefined;
  } catch {
    repo = undefined;
  }

  log(
    JSON.stringify({
      route: ROUTE,
      result: "accepted",
      event: req.headers["x-github-event"],
      deliveryId: req.headers["x-github-delivery"],
      repo,
    }),
  );
  res.statusCode = 200;
  res.end("ok");
}
