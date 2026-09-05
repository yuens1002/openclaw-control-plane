import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

// Issue #108 (github-webhook-verify) deliverable D3, extended by issue #116
// (multi-secret verify) and #117 (dispatch to /hooks/agent) deliverable D4.
//
// Direct unit tests of scripts/wrapper-github-webhook-verify.mjs's exported
// functions, written against the module contracts pinned in
// docs/plans/github-webhook-verify/plan.md (D1's original exports) and
// docs/plans/github-webhook-agent-dispatch/plan.md (D1-D3's additions:
// verifyAnyGithubSignature, resolveGithubWebhookSecrets, computeDedupKey,
// resolveDispatchAllowlist, matchesDispatchAllowlist, forwardToAgentHook,
// resolveAgentHookUrl).
//
// Loaded the same way tests/openclaw-railway-wrapper-patches.test.ts loads
// scripts/wrapper-state-export.mjs: createRequire(...)(computedPath) rather
// than a static `import ... from "../scripts/*.mjs"`. tests/tsconfig.json has
// rootDir "." and no allowJs, so a static import of an untyped .mjs path
// cannot be typechecked by `tsc -b`/`pretest`; createRequire hands the file
// to Node's own loader instead, keeping any missing-module failure scoped
// to a single runtime error in this file when vitest collects it, without
// breaking `tsc -b` for the rest of the suite.
const nativeRequire = createRequire(import.meta.url);
const webhookModulePath = fileURLToPath(new URL("../scripts/wrapper-github-webhook-verify.mjs", import.meta.url));

interface DispatchAllowlistEntry {
  repo: string;
  events: Array<{
    event: string;
    actions: string[];
    trustedMention?: { actors: string[]; pattern: string };
  }>;
}

interface HandleOptions {
  secret?: string;
  log?: (line: string) => void;
  dedupStore?: { has(key: string): boolean; add(key: string): unknown };
  forward?: { hookUrl?: string; hookToken?: string; fetchImpl?: typeof fetch };
}

interface WebhookVerifyModule {
  computeGithubSignature(secret: string, rawBody: Buffer): string;
  verifyGithubSignature(secret: string, rawBody: Buffer, headerValue: string | undefined): boolean;
  readRawBody(req: FakeIncomingMessage, opts?: { maxBytes?: number; timeoutMs?: number }): Promise<Buffer>;
  handleGithubWebhookVerify(req: FakeIncomingMessage | UntouchableReq, res: FakeRes, options?: HandleOptions): Promise<void>;
  resolveGithubWebhookMaxBytes(env?: Record<string, string | undefined>): number;
  GITHUB_WEBHOOK_MAX_BODY_BYTES_ENV: string;

  // #116 -- multi-secret verify
  verifyAnyGithubSignature(secrets: string[], rawBody: Buffer, headerValue: string | undefined): boolean;
  resolveGithubWebhookSecrets(env?: Record<string, string | undefined>): string[];
  GITHUB_WEBHOOK_SECRETS_ENV: string;

  // #117 -- dedup key (also used as the /hooks/agent session-store label;
  // there is no separate resumable session key -- /hooks/agent never
  // resumes a session regardless of the label) + allowlist + dispatch
  computeDedupKey(event: string, payload: unknown): string | undefined;
  resolveDispatchAllowlist(env?: Record<string, string | undefined>): DispatchAllowlistEntry[];
  matchesDispatchAllowlist(
    entries: DispatchAllowlistEntry[],
    event: string,
    action: string | undefined,
    repoFullName: string | undefined,
    actorLogin: string | undefined,
    commentBody: string | undefined
  ): boolean;
  GITHUB_DISPATCH_ALLOWLIST_ENV: string;
  forwardToAgentHook(
    dispatchKey: string,
    event: string,
    payload: unknown,
    options?: { hookUrl?: string; hookToken?: string; fetchImpl?: typeof fetch }
  ): Promise<{ forwarded: boolean }>;
  resolveAgentHookUrl(env?: Record<string, string | undefined>): string;
  OPENCLAW_AGENT_HOOK_URL_ENV: string;
  OPENCLAW_AGENT_HOOK_TOKEN_ENV: string;
}

const webhook = nativeRequire(webhookModulePath) as WebhookVerifyModule;

const TEST_SECRET = "test-secret-for-wrapper-github-webhook-verify";

// --- Fakes ---------------------------------------------------------------

interface FakeReqOptions {
  method?: string;
  headers?: Record<string, string>;
  body: string | Buffer;
}

/**
 * A real node:stream Readable, not a plain EventEmitter: D1 does not exist
 * yet, so this file cannot grep its actual body-reading mechanism. A real
 * Readable is a strict superset of every reasonable choice -- classic
 * `req.on("data"/"end"/"error", ...)`, `for await (const chunk of req)`, and
 * `.pipe()` all work against it -- and it also has a real `.destroy()`, in
 * case readRawBody aborts the stream on a maxBytes/timeout rejection.
 */
class FakeIncomingMessage extends Readable {
  method: string;
  headers: Record<string, string>;

  constructor({ method = "POST", headers = {}, body }: FakeReqOptions) {
    super();
    this.method = method;
    this.headers = headers;
    this.push(typeof body === "string" ? Buffer.from(body) : body);
    this.push(null);
  }

  override _read(): void {
    // no-op: the whole body is already pushed in the constructor.
  }
}

function createFakeReq(opts: FakeReqOptions): FakeIncomingMessage {
  return new FakeIncomingMessage(opts);
}

type UntouchableReq = { method: string; headers: Record<string, string> };

/**
 * A Proxy whose only readable properties are `method`/`headers`; any other
 * property access -- `.on`, `.once`, `.pipe`, `.resume`, `.destroy`,
 * `[Symbol.asyncIterator]`, whatever body-reading mechanism D1 actually uses
 * -- returns a function that throws the instant it is invoked. Used to prove
 * handleGithubWebhookVerify never attempts to read the body when no secret
 * is configured (AC-FN-3): if it did, either the throw propagates and fails
 * the test directly, or a handler-level try/catch turns it into some
 * non-404 response, which still fails the test's status-code assertion.
 */
function createUntouchableReq(method: string): UntouchableReq {
  const forbidden = () => {
    throw new Error("request body must not be read when no webhook secret is configured");
  };
  const target: UntouchableReq = { method, headers: {} };
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === "method" || prop === "headers") {
        return Reflect.get(obj, prop, receiver);
      }
      return forbidden;
    }
  });
}

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  ended: boolean;
  status(code: number): FakeRes;
  set(name: string, value: string): FakeRes;
  setHeader(name: string, value: string): FakeRes;
  type(t: string): FakeRes;
  send(body: unknown): FakeRes;
  json(obj: unknown): FakeRes;
  end(body?: unknown): FakeRes;
  writeHead(code: number, headers?: Record<string, string>): FakeRes;
  /** Minimal EventEmitter-shaped surface: real ServerResponse emits "finish" once its data has been flushed to the socket. Only the one event the module actually listens for is modeled. */
  once(event: "finish", listener: () => void): FakeRes;
}

/**
 * Accepts both the Express-style surface (status/set/type/send/json) and the
 * plain node:http ServerResponse surface (setHeader/end/writeHead), since the
 * module contract does not say which one D1 hands back.
 */
function createFakeRes(): FakeRes {
  const finishListeners: Array<() => void> = [];
  const emitFinish = () => {
    // Real ServerResponse's "finish" fires once the whole response has been
    // written to the underlying socket, not synchronously inside end() --
    // queueMicrotask keeps the fake honest about that ordering (the caller's
    // own res.once("finish", ...) registration always runs before this
    // fires, matching production, where the socket flush is inherently
    // asynchronous).
    queueMicrotask(() => {
      for (const listener of finishListeners.splice(0)) listener();
    });
  };
  const res: FakeRes = {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    status(code) {
      res.statusCode = code;
      return res;
    },
    set(name, value) {
      res.headers[name] = value;
      return res;
    },
    setHeader(name, value) {
      res.headers[name] = value;
      return res;
    },
    type(t) {
      res.headers["content-type"] = t;
      return res;
    },
    send(body) {
      res.body = body;
      res.ended = true;
      emitFinish();
      return res;
    },
    json(obj) {
      res.body = obj;
      res.ended = true;
      res.headers["content-type"] = res.headers["content-type"] ?? "application/json";
      emitFinish();
      return res;
    },
    end(body) {
      if (body !== undefined) res.body = body;
      res.ended = true;
      emitFinish();
      return res;
    },
    writeHead(code, headers) {
      res.statusCode = code;
      if (headers) Object.assign(res.headers, headers);
      return res;
    },
    once(event, listener) {
      if (event === "finish") finishListeners.push(listener);
      return res;
    }
  };
  return res;
}

/** Case-insensitive header lookup: the module contract doesn't pin header-name casing. */
function getHeader(res: FakeRes, name: string): string | undefined {
  const key = Object.keys(res.headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : res.headers[key];
}

/**
 * Best-effort JSON.parse of one logged line. The module contract shows a
 * `{route, result, ...}` shape but not an exact serialization, so this is
 * only used to read well-defined named fields (result, repo) -- never to
 * assert on line formatting itself.
 */
function parseLoggedLine(line: string): { result?: string; repo?: string; [key: string]: unknown } {
  try {
    return JSON.parse(line) as { result?: string; repo?: string };
  } catch {
    return { raw: line };
  }
}

// --- computeGithubSignature / verifyGithubSignature -----------------------

describe("computeGithubSignature / verifyGithubSignature", () => {
  const secret = "unit-test-secret";
  const body = Buffer.from(JSON.stringify({ hello: "world", n: 42 }));

  // AC-TST-1
  it("verifies a signature computed for the exact secret/body pair", () => {
    const signature = webhook.computeGithubSignature(secret, body);
    expect(signature.startsWith("sha256=")).toBe(true);
    expect(webhook.verifyGithubSignature(secret, body, signature)).toBe(true);
  });

  // AC-TST-2
  it("rejects a signature computed over a one-byte-mutated body", () => {
    const signature = webhook.computeGithubSignature(secret, body);
    const mutated = Buffer.from(body); // copy, not alias
    mutated[0] = (mutated[0] ?? 0) ^ 0xff;
    expect(webhook.verifyGithubSignature(secret, mutated, signature)).toBe(false);
  });

  // AC-TST-2
  it("rejects a signature computed with the wrong secret", () => {
    const signature = webhook.computeGithubSignature("a-different-secret", body);
    expect(webhook.verifyGithubSignature(secret, body, signature)).toBe(false);
  });

  // AC-TST-2
  it("rejects an empty-string signature header", () => {
    expect(webhook.verifyGithubSignature(secret, body, "")).toBe(false);
  });

  // AC-TST-2: "missing header" (headerValue undefined) is a distinct case
  // from the empty-string one above -- the contract says falsy either way.
  it("rejects a missing (undefined) signature header, without throwing", () => {
    expect(() => webhook.verifyGithubSignature(secret, body, undefined)).not.toThrow();
    expect(webhook.verifyGithubSignature(secret, body, undefined)).toBe(false);
  });

  // AC-TST-2: the guard-before-timingSafeEqual case the module contract calls out explicitly.
  it("rejects, without throwing, a header of a completely different length than the real digest", () => {
    const shortHeader = "sha256=deadbeef";
    expect(() => webhook.verifyGithubSignature(secret, body, shortHeader)).not.toThrow();
    expect(webhook.verifyGithubSignature(secret, body, shortHeader)).toBe(false);

    const longHeader = `sha256=${"ab".repeat(200)}`;
    expect(() => webhook.verifyGithubSignature(secret, body, longHeader)).not.toThrow();
    expect(webhook.verifyGithubSignature(secret, body, longHeader)).toBe(false);
  });
});

// --- resolveGithubWebhookMaxBytes -------------------------------------------

describe("resolveGithubWebhookMaxBytes", () => {
  it("returns the 1 MiB default when the env var is unset or blank", () => {
    expect(webhook.resolveGithubWebhookMaxBytes({})).toBe(1024 * 1024);
    expect(webhook.resolveGithubWebhookMaxBytes({ [webhook.GITHUB_WEBHOOK_MAX_BODY_BYTES_ENV]: "  " })).toBe(
      1024 * 1024
    );
  });

  it("returns the parsed override when set to a positive integer", () => {
    expect(webhook.resolveGithubWebhookMaxBytes({ [webhook.GITHUB_WEBHOOK_MAX_BODY_BYTES_ENV]: "2048" })).toBe(2048);
  });

  it("throws on a non-integer or non-positive override rather than silently falling back", () => {
    for (const bad of ["0", "-5", "not-a-number", "1.5"]) {
      expect(() => webhook.resolveGithubWebhookMaxBytes({ [webhook.GITHUB_WEBHOOK_MAX_BODY_BYTES_ENV]: bad })).toThrow(
        webhook.GITHUB_WEBHOOK_MAX_BODY_BYTES_ENV
      );
    }
  });
});

// --- readRawBody ------------------------------------------------------------

describe("readRawBody", () => {
  it("resolves with the exact concatenated body bytes", async () => {
    const payload = Buffer.from("hello world, this is the raw body");
    const req = createFakeReq({ method: "POST", headers: {}, body: payload });
    const result = await webhook.readRawBody(req);
    expect(result.equals(payload)).toBe(true);
  });

  it("rejects when the body exceeds a small maxBytes override", async () => {
    const payload = Buffer.from("this body is definitely longer than sixteen bytes");
    const req = createFakeReq({ method: "POST", headers: {}, body: payload });
    await expect(webhook.readRawBody(req, { maxBytes: 16 })).rejects.toThrow();
  });

  it("resolves with the exact concatenated bytes across multiple data chunks", async () => {
    const parts = [Buffer.from("chunk-one-"), Buffer.from("chunk-two-"), Buffer.from("chunk-three")];
    const req = Readable.from(parts);
    const result = await webhook.readRawBody(req as unknown as FakeIncomingMessage);
    expect(result.equals(Buffer.concat(parts))).toBe(true);
  });

  it("rejects when the read exceeds timeoutMs on a stream that never ends", async () => {
    // A stream that pushes nothing and never calls push(null): readRawBody
    // must reject via its own timer, not hang the test suite.
    const req = new Readable({ read() {} });
    await expect(
      webhook.readRawBody(req as unknown as FakeIncomingMessage, { timeoutMs: 30 })
    ).rejects.toThrow(/timed out/);
  });

  it("rejects when the stream emits an error", async () => {
    const req = new Readable({
      read() {
        this.destroy(new Error("simulated socket error"));
      }
    });
    await expect(webhook.readRawBody(req as unknown as FakeIncomingMessage)).rejects.toThrow();
  });

  // The exact production failure mode this suite otherwise couldn't see: a
  // body parser registered earlier in the request pipeline (e.g. the
  // wrapper's global express.json()) already consumed the stream before
  // readRawBody's own listeners attach. Without the readableEnded fast-fail
  // guard in the module, this would hang to the full default timeout
  // (10s) on every such request instead of failing immediately.
  it("rejects immediately (not via timeout) when the stream has already ended", async () => {
    const req = createFakeReq({ method: "POST", headers: {}, body: Buffer.from("already consumed") });
    // Drain the stream fully, exactly as express.json() would before this
    // module ever gets a chance to read it.
    req.resume();
    await new Promise<void>((resolve) => req.once("end", () => resolve()));
    expect(req.readableEnded).toBe(true);

    const start = Date.now();
    await expect(webhook.readRawBody(req)).rejects.toThrow(/already-ended/);
    expect(Date.now() - start).toBeLessThan(50); // fails fast, not via the 10s default timeout
  });
});

// --- handleGithubWebhookVerify -----------------------------------------------

describe("handleGithubWebhookVerify", () => {
  // AC-TST-3, AC-FN-3
  it("responds 404 without a configured secret and never touches the request body", async () => {
    const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    try {
      const req = createUntouchableReq("POST");
      const res = createFakeRes();
      // No `secret` key at all: exactOptionalPropertyTypes forbids `{ secret: undefined }`,
      // and omitting it exercises the real default (process.env.GITHUB_WEBHOOK_SECRET, unset above).
      await webhook.handleGithubWebhookVerify(req, res, {});
      expect(res.statusCode).toBe(404);
      expect(String(res.body).trim()).toBe("Not Found");
    } finally {
      if (originalSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
      else process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
    }
  });

  // A malformed GITHUB_WEBHOOK_MAX_BODY_BYTES is a deploy/config error, not
  // anything the client did -- must surface as 500, not the 400 used for a
  // client's own oversize/slow body.
  it("responds 500 when GITHUB_WEBHOOK_MAX_BODY_BYTES is malformed, not 400", async () => {
    const originalMaxBytes = process.env.GITHUB_WEBHOOK_MAX_BODY_BYTES;
    process.env.GITHUB_WEBHOOK_MAX_BODY_BYTES = "not-a-number";
    try {
      const rawBody = Buffer.from(JSON.stringify({ repository: { full_name: "someone/somewhere" } }));
      const signature = webhook.computeGithubSignature(TEST_SECRET, rawBody);
      const req = createFakeReq({ method: "POST", headers: { "x-hub-signature-256": signature }, body: rawBody });
      const res = createFakeRes();
      await webhook.handleGithubWebhookVerify(req, res, { secret: TEST_SECRET });
      expect(res.statusCode).toBe(500);
    } finally {
      if (originalMaxBytes === undefined) delete process.env.GITHUB_WEBHOOK_MAX_BODY_BYTES;
      else process.env.GITHUB_WEBHOOK_MAX_BODY_BYTES = originalMaxBytes;
    }
  });

  // The route the patch script actually injects calls
  // handleGithubWebhookVerify(req, res) with no options at all -- the
  // GITHUB_WEBHOOK_SECRET env var is the only secret source in production.
  // Every other test in this file passes secret explicitly via options,
  // which never exercises that real code path; a misspelled or
  // differently-cased env var name in the deployed image would pass every
  // one of those tests while being completely broken in production.
  it("verifies successfully via the GITHUB_WEBHOOK_SECRET env var with no options passed", async () => {
    const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;
    process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
    try {
      const payload = JSON.stringify({ repository: { full_name: "yuens1002/openclaw-control-plane" } });
      const rawBody = Buffer.from(payload);
      const signature = webhook.computeGithubSignature(TEST_SECRET, rawBody);
      const req = createFakeReq({ method: "POST", headers: { "x-hub-signature-256": signature }, body: rawBody });
      const res = createFakeRes();
      await webhook.handleGithubWebhookVerify(req, res); // no options object at all
      expect(res.statusCode).toBe(200);
    } finally {
      if (originalSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
      else process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
    }
  });

  // AC-TST-3
  it("responds 405 with an Allow: POST header for a non-POST method", async () => {
    const req = createFakeReq({ method: "GET", headers: {}, body: "" });
    const res = createFakeRes();
    await webhook.handleGithubWebhookVerify(req, res, { secret: TEST_SECRET });
    expect(res.statusCode).toBe(405);
    expect(getHeader(res, "Allow")).toBe("POST");
  });

  // AC-TST-3: default cap (no maxBytes override exposed on this options type per the contract),
  // exercised end-to-end with a real 1 MiB + 1 byte in-memory buffer -- fast (single chunk, no I/O).
  it("responds 400 when the body exceeds the default maxBytes cap", async () => {
    const oversized = Buffer.alloc(1024 * 1024 + 1, 0x61);
    const req = createFakeReq({ method: "POST", headers: {}, body: oversized });
    const res = createFakeRes();
    await webhook.handleGithubWebhookVerify(req, res, { secret: TEST_SECRET });
    expect(res.statusCode).toBe(400);
  });

  // AC-TST-3
  it("responds 200 and logs an accepted entry with the parsed repository.full_name for a valid signature", async () => {
    const payload = { action: "opened", repository: { full_name: "yuens1002/openclaw-control-plane" } };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = webhook.computeGithubSignature(TEST_SECRET, rawBody);
    const req = createFakeReq({
      method: "POST",
      headers: {
        "x-hub-signature-256": signature,
        "x-github-event": "pull_request",
        "x-github-delivery": "test-delivery-id"
      },
      body: rawBody
    });
    const res = createFakeRes();
    const logged: string[] = [];
    await webhook.handleGithubWebhookVerify(req, res, { secret: TEST_SECRET, log: (line) => logged.push(line) });

    expect(res.statusCode).toBe(200);
    expect(String(res.body).trim()).toBe("ok");
    expect(logged.length).toBeGreaterThan(0);
    const lastLine = logged[logged.length - 1];
    if (lastLine === undefined) throw new Error("unreachable: length checked above");
    const lastEntry = parseLoggedLine(lastLine);
    expect(lastEntry.result).toBe("accepted");
    expect(lastEntry.repo).toBe("yuens1002/openclaw-control-plane");
    expect(lastEntry.event).toBe("pull_request");
    expect(lastEntry.deliveryId).toBe("test-delivery-id");
  });

  // AC-TST-3
  it("responds 401 and logs no raw body/payload content for an invalid signature", async () => {
    const marker = "UNIQUE-MARKER-6f3a9c2e";
    const payload = { note: marker, repository: { full_name: "someone/somewhere" } };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const rejectedSignature = `sha256=${"0".repeat(64)}`; // syntactically valid shape, wrong digest
    const req = createFakeReq({
      method: "POST",
      headers: { "x-hub-signature-256": rejectedSignature },
      body: rawBody
    });
    const res = createFakeRes();
    const logged: string[] = [];
    await webhook.handleGithubWebhookVerify(req, res, { secret: TEST_SECRET, log: (line) => logged.push(line) });

    expect(res.statusCode).toBe(401);
    // The contract says a rejection logs {route, result:"rejected"} -- an
    // empty `logged` would make the "contains no marker" loop below pass
    // vacuously, so require an entry actually exists first.
    expect(logged.length).toBeGreaterThan(0);
    const lastLine = logged[logged.length - 1];
    if (lastLine === undefined) throw new Error("unreachable: length checked above");
    expect(parseLoggedLine(lastLine).result).toBe("rejected");
    for (const line of logged) {
      expect(line).not.toContain(marker);
      expect(line).not.toContain(rejectedSignature);
    }
  });

  it("responds 401 for a valid POST with no signature header at all", async () => {
    const rawBody = Buffer.from(JSON.stringify({ repository: { full_name: "someone/somewhere" } }));
    const req = createFakeReq({ method: "POST", headers: {}, body: rawBody });
    const res = createFakeRes();
    await webhook.handleGithubWebhookVerify(req, res, { secret: TEST_SECRET });

    expect(res.statusCode).toBe(401);
  });
});

// ============================================================================
// Issue #116 -- multi-secret verify -- and #117 -- dedup/session keys,
// dispatch allowlist, forwarding to /hooks/agent -- deliverable D4.
//
// Module contract: docs/plans/github-webhook-agent-dispatch/plan.md.
// ============================================================================

/** Captures one call a stub `fetch` implementation received, without ever touching the real network. */
interface CapturedFetchCall {
  url: string;
  init: Record<string, unknown>;
}

/**
 * A stub `fetchImpl` for forwardToAgentHook: records every call and answers
 * with a caller-supplied result (default `{ ok: true, status: 200 }`),
 * without ever touching the real network.
 */
function createStubFetch(respond?: (call: CapturedFetchCall) => { ok: boolean; status: number }) {
  const calls: CapturedFetchCall[] = [];
  const fetchImpl = (async (url: unknown, init?: unknown) => {
    const call: CapturedFetchCall = { url: String(url), init: (init ?? {}) as Record<string, unknown> };
    calls.push(call);
    const result = respond ? respond(call) : { ok: true, status: 200 };
    return { ok: result.ok, status: result.status } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Adversarial `pull_request` payload builder -- unicode repo name, arbitrary field values, never copied from any fixture. */
function prPayload(overrides: { repo?: string; number?: number; sha?: string; actor?: string; action?: string; body?: string } = {}) {
  const repo = overrides.repo ?? "adversarial-öwner/répo-🐙";
  const number = overrides.number ?? 4177;
  const sha = overrides.sha ?? "sha-adversarial-0001";
  return {
    action: overrides.action ?? "synchronize",
    number,
    pull_request: { number, head: { sha }, body: overrides.body ?? "PR-BODY-MARKER-should-never-be-forwarded" },
    repository: { full_name: repo },
    sender: { login: overrides.actor ?? "adversarial-actor" }
  };
}

/** Adversarial `issue_comment` payload builder -- unicode repo name, arbitrary field values, never copied from any fixture. */
function issueCommentPayload(
  overrides: { repo?: string; number?: number; commentId?: number | string; actor?: string; action?: string; body?: string } = {}
) {
  const repo = overrides.repo ?? "adversarial-öwner/répo-🐙";
  const number = overrides.number ?? 8842;
  return {
    action: overrides.action ?? "created",
    issue: { number },
    comment: { id: overrides.commentId ?? 555, body: overrides.body ?? "COMMENT-BODY-MARKER-should-never-be-forwarded" },
    repository: { full_name: repo },
    sender: { login: overrides.actor ?? "adversarial-actor" }
  };
}

function captureThrown(fn: () => unknown): { code?: unknown; message?: string } {
  try {
    fn();
    throw new Error("expected function to throw, but it did not");
  } catch (err) {
    if (err instanceof Error) return { code: (err as Error & { code?: unknown }).code, message: err.message };
    return {};
  }
}

// --- verifyAnyGithubSignature (#116, AC-FN-1, AC-SEC-1) ---------------------

describe("verifyAnyGithubSignature", () => {
  const body = Buffer.from(JSON.stringify({ adversarial: "payload with unicode ✅ and \"quotes\"" }));
  const secrets = ["adversarial-secret-alpha", "adversarial-secret-beta-🔑", "adversarial-secret-gamma"];

  it("verifies true when the header matches the FIRST configured secret", () => {
    const sig = webhook.computeGithubSignature(secrets[0] ?? "", body);
    expect(webhook.verifyAnyGithubSignature(secrets, body, sig)).toBe(true);
  });

  it("verifies true when the header matches a MIDDLE configured secret", () => {
    const sig = webhook.computeGithubSignature(secrets[1] ?? "", body);
    expect(webhook.verifyAnyGithubSignature(secrets, body, sig)).toBe(true);
  });

  it("verifies true when the header matches the LAST configured secret", () => {
    const sig = webhook.computeGithubSignature(secrets[2] ?? "", body);
    expect(webhook.verifyAnyGithubSignature(secrets, body, sig)).toBe(true);
  });

  it("verifies false when the header matches none of the configured secrets", () => {
    const sig = webhook.computeGithubSignature("a-secret-not-in-the-list", body);
    expect(webhook.verifyAnyGithubSignature(secrets, body, sig)).toBe(false);
  });

  it("always returns false for an empty secrets array, even with an otherwise-valid signature", () => {
    const sig = webhook.computeGithubSignature("irrelevant", body);
    expect(webhook.verifyAnyGithubSignature([], body, sig)).toBe(false);
  });

  // AC-SEC-1: every candidate is compared unconditionally, so a match at
  // index 0 does not short-circuit the loop -- this is a code-review
  // criterion (the source has no early `return true`), verified functionally
  // here as "matching at every position still returns true and never
  // throws," since the timing property itself isn't observable in a fast
  // in-process unit test.
  it("does not throw and still matches correctly regardless of a mutated candidate elsewhere in the list", () => {
    const sig = webhook.computeGithubSignature(secrets[0] ?? "", body);
    const withGarbageSecrets = ["", "not-a-real-secret", secrets[0] ?? "", "another-decoy"];
    expect(() => webhook.verifyAnyGithubSignature(withGarbageSecrets, body, sig)).not.toThrow();
    expect(webhook.verifyAnyGithubSignature(withGarbageSecrets, body, sig)).toBe(true);
  });
});

// --- resolveGithubWebhookSecrets (#116, AC-FN-2) ----------------------------

describe("resolveGithubWebhookSecrets", () => {
  it("prefers a valid GITHUB_WEBHOOK_SECRETS over legacy GITHUB_WEBHOOK_SECRET", () => {
    const secrets = webhook.resolveGithubWebhookSecrets({
      GITHUB_WEBHOOK_SECRETS: JSON.stringify(["secret-one", "secret-two-🔑"]),
      GITHUB_WEBHOOK_SECRET: "legacy-secret-should-be-ignored"
    });
    expect(secrets).toEqual(["secret-one", "secret-two-🔑"]);
  });

  it("resolves to a one-element array from GITHUB_WEBHOOK_SECRET when SECRETS is unset (unchanged single-secret behavior)", () => {
    expect(webhook.resolveGithubWebhookSecrets({ GITHUB_WEBHOOK_SECRET: "only-legacy-secret" })).toEqual([
      "only-legacy-secret"
    ]);
  });

  it("resolves to [] when neither var is set", () => {
    expect(webhook.resolveGithubWebhookSecrets({})).toEqual([]);
  });

  it("resolves to [] for a blank GITHUB_WEBHOOK_SECRETS, falling back to legacy", () => {
    expect(webhook.resolveGithubWebhookSecrets({ GITHUB_WEBHOOK_SECRETS: "   ", GITHUB_WEBHOOK_SECRET: "fallback" })).toEqual([
      "fallback"
    ]);
  });

  it("throws a tagged config error on invalid JSON, rather than treating the raw string as one secret", () => {
    const thrown = captureThrown(() => webhook.resolveGithubWebhookSecrets({ GITHUB_WEBHOOK_SECRETS: "{not valid json" }));
    expect(thrown.code).toBe("GITHUB_WEBHOOK_SECRETS_CONFIG_ERROR");
    expect(thrown.message).toContain("GITHUB_WEBHOOK_SECRETS");
  });

  it("throws when GITHUB_WEBHOOK_SECRETS parses to valid JSON that is not an array", () => {
    const thrown = captureThrown(() =>
      webhook.resolveGithubWebhookSecrets({ GITHUB_WEBHOOK_SECRETS: JSON.stringify({ oops: "an object, not an array" }) })
    );
    expect(thrown.code).toBe("GITHUB_WEBHOOK_SECRETS_CONFIG_ERROR");
  });

  it("throws when an element is a non-string", () => {
    const thrown = captureThrown(() => webhook.resolveGithubWebhookSecrets({ GITHUB_WEBHOOK_SECRETS: JSON.stringify(["ok", 12345]) }));
    expect(thrown.code).toBe("GITHUB_WEBHOOK_SECRETS_CONFIG_ERROR");
  });

  it("throws when an element is an empty string", () => {
    const thrown = captureThrown(() => webhook.resolveGithubWebhookSecrets({ GITHUB_WEBHOOK_SECRETS: JSON.stringify(["ok", ""]) }));
    expect(thrown.code).toBe("GITHUB_WEBHOOK_SECRETS_CONFIG_ERROR");
  });

  it("never silently falls back to legacy on a malformed GITHUB_WEBHOOK_SECRETS, even when legacy is also set", () => {
    expect(() =>
      webhook.resolveGithubWebhookSecrets({ GITHUB_WEBHOOK_SECRETS: "not json at all", GITHUB_WEBHOOK_SECRET: "would-be-wrong-to-use" })
    ).toThrow();
  });
});

// --- computeDedupKey (#117, AC-FN-4/5/7) ------------------------------------
//
// computeSessionKey was removed: /hooks/agent never resumes a session
// regardless of the label supplied, confirmed against the actual OpenClaw
// source (dispatchAgentHook hardcodes sessionTarget: "isolated") and
// verified empirically (identical sessionKey, two different session ids
// across two live calls). One dedup key now covers both the forward
// decision and the session-store label -- there is no separate stable key
// to test for cross-delivery agreement.

describe("computeDedupKey", () => {
  it("pull_request: dedup key includes repo + PR number + head sha, reproducible on an identical replay", () => {
    const payload = prPayload({ repo: "replay-owner/replay-repo", number: 101, sha: "sha-replay" });
    const replay = prPayload({ repo: "replay-owner/replay-repo", number: 101, sha: "sha-replay" });
    const key = webhook.computeDedupKey("pull_request", payload);
    expect(key).toBe("replay-owner/replay-repo#101@sha-replay");
    expect(webhook.computeDedupKey("pull_request", replay)).toBe(key);
  });

  it("pull_request: only the head sha changing produces a different dedup key", () => {
    const before = prPayload({ repo: "move-owner/move-repo", number: 55, sha: "sha-before-push" });
    const after = prPayload({ repo: "move-owner/move-repo", number: 55, sha: "sha-after-push" });
    expect(webhook.computeDedupKey("pull_request", before)).not.toBe(webhook.computeDedupKey("pull_request", after));
  });

  it("issue_comment: dedup key includes repo + resource number + comment id; a different comment on the same issue differs", () => {
    const c1 = issueCommentPayload({ repo: "comment-owner/comment-repo", number: 9, commentId: 111 });
    const c2 = issueCommentPayload({ repo: "comment-owner/comment-repo", number: 9, commentId: 222 });
    expect(webhook.computeDedupKey("issue_comment", c1)).toBe("comment-owner/comment-repo#9/comment-111");
    expect(webhook.computeDedupKey("issue_comment", c1)).not.toBe(webhook.computeDedupKey("issue_comment", c2));
  });

  // AC-FN-7: a payload missing a field its event type requires returns
  // undefined, never a key built from partial data.
  it("returns undefined for a pull_request payload with no pull_request.head.sha", () => {
    const malformed = { number: 42, pull_request: { number: 42 }, repository: { full_name: "malformed-owner/repo" } };
    expect(webhook.computeDedupKey("pull_request", malformed)).toBeUndefined();
  });

  it("returns undefined for an issue_comment payload with no comment.id", () => {
    const malformed = { issue: { number: 7 }, comment: {}, repository: { full_name: "malformed-owner/repo" } };
    expect(webhook.computeDedupKey("issue_comment", malformed)).toBeUndefined();
  });

  it("returns undefined when repository.full_name is missing entirely", () => {
    const malformed = prPayload();
    // @ts-expect-error -- deliberately constructing a malformed payload for the adversarial case
    delete malformed.repository;
    expect(webhook.computeDedupKey("pull_request", malformed)).toBeUndefined();
  });

  it("returns undefined for an entirely unsupported event type (e.g. push)", () => {
    const payload = { repository: { full_name: "some-owner/some-repo" }, ref: "refs/heads/main" };
    expect(webhook.computeDedupKey("push", payload)).toBeUndefined();
  });
});

// --- resolveDispatchAllowlist (#117, AC-FN-8) -------------------------------

describe("resolveDispatchAllowlist", () => {
  it("resolves to [] when unset or blank", () => {
    expect(webhook.resolveDispatchAllowlist({})).toEqual([]);
    expect(webhook.resolveDispatchAllowlist({ GITHUB_DISPATCH_ALLOWLIST: "  " })).toEqual([]);
  });

  it("parses a valid entry into the documented shape", () => {
    const entries = webhook.resolveDispatchAllowlist({
      GITHUB_DISPATCH_ALLOWLIST: JSON.stringify([
        {
          repo: "allow-owner/allow-repo",
          events: [
            { event: "pull_request", actions: ["opened", "synchronize"] },
            { event: "issue_comment", actions: ["created"], trustedMention: { actors: ["trusted-one"], pattern: "@bot\\b" } }
          ]
        }
      ])
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.repo).toBe("allow-owner/allow-repo");
  });

  it("throws a tagged config error on invalid JSON", () => {
    const thrown = captureThrown(() => webhook.resolveDispatchAllowlist({ GITHUB_DISPATCH_ALLOWLIST: "[not valid" }));
    expect(thrown.code).toBe("GITHUB_DISPATCH_ALLOWLIST_CONFIG_ERROR");
  });

  it("throws when an entry is missing events", () => {
    const thrown = captureThrown(() =>
      webhook.resolveDispatchAllowlist({ GITHUB_DISPATCH_ALLOWLIST: JSON.stringify([{ repo: "owner/repo" }]) })
    );
    expect(thrown.code).toBe("GITHUB_DISPATCH_ALLOWLIST_CONFIG_ERROR");
  });

  it("throws when an issue_comment entry has no trustedMention", () => {
    const thrown = captureThrown(() =>
      webhook.resolveDispatchAllowlist({
        GITHUB_DISPATCH_ALLOWLIST: JSON.stringify([
          { repo: "owner/repo", events: [{ event: "issue_comment", actions: ["created"] }] }
        ])
      })
    );
    expect(thrown.code).toBe("GITHUB_DISPATCH_ALLOWLIST_CONFIG_ERROR");
  });

  it("throws when the top-level value is not an array", () => {
    const thrown = captureThrown(() =>
      webhook.resolveDispatchAllowlist({ GITHUB_DISPATCH_ALLOWLIST: JSON.stringify({ repo: "owner/repo" }) })
    );
    expect(thrown.code).toBe("GITHUB_DISPATCH_ALLOWLIST_CONFIG_ERROR");
  });
});

// --- matchesDispatchAllowlist (#117, AC-FN-9/10, AC-SEC-3) ------------------

describe("matchesDispatchAllowlist", () => {
  const entries = [
    {
      repo: "match-owner/match-repo",
      events: [
        { event: "pull_request", actions: ["opened", "synchronize"] },
        {
          event: "issue_comment",
          actions: ["created"],
          trustedMention: { actors: ["trusted-actor-one", "trusted-actor-two"], pattern: "@review-bot\\b" }
        }
      ]
    }
  ];

  // AC-FN-9
  it("returns true only when the repo has an entry AND that entry permits the exact (event, action) pair", () => {
    expect(webhook.matchesDispatchAllowlist(entries, "pull_request", "opened", "match-owner/match-repo", "anyone", undefined)).toBe(
      true
    );
  });

  it("returns false for a repo that is not listed at all", () => {
    expect(webhook.matchesDispatchAllowlist(entries, "pull_request", "opened", "unlisted-owner/unlisted-repo", "anyone", undefined)).toBe(
      false
    );
  });

  it("returns false for an unlisted action on an otherwise-listed event", () => {
    expect(webhook.matchesDispatchAllowlist(entries, "pull_request", "closed", "match-owner/match-repo", "anyone", undefined)).toBe(
      false
    );
  });

  it("returns false for an event the repo's entry does not list at all", () => {
    expect(
      webhook.matchesDispatchAllowlist(entries, "pull_request_review", "submitted", "match-owner/match-repo", "anyone", undefined)
    ).toBe(false);
  });

  // AC-FN-10 -- adversarial actor/mention combinations constructed here, not copied from any fixture.
  it("issue_comment: true only when the actor is trusted AND the comment matches the mention pattern", () => {
    expect(
      webhook.matchesDispatchAllowlist(
        entries,
        "issue_comment",
        "created",
        "match-owner/match-repo",
        "trusted-actor-two",
        "please look at this, @review-bot"
      )
    ).toBe(true);
  });

  it("issue_comment: an UNTRUSTED actor with the correct mention still returns false", () => {
    expect(
      webhook.matchesDispatchAllowlist(
        entries,
        "issue_comment",
        "created",
        "match-owner/match-repo",
        "a-random-drive-by-commenter",
        "please look at this, @review-bot"
      )
    ).toBe(false);
  });

  it("issue_comment: a TRUSTED actor WITHOUT the mention still returns false", () => {
    expect(
      webhook.matchesDispatchAllowlist(
        entries,
        "issue_comment",
        "created",
        "match-owner/match-repo",
        "trusted-actor-one",
        "just a regular comment with no mention at all"
      )
    ).toBe(false);
  });

  it("issue_comment: a trusted actor's comment containing only a near-miss token (\\b boundary excludes it) returns false", () => {
    // "@review-botnet" does NOT satisfy pattern "@review-bot\\b" -- "net"
    // immediately follows "bot" with no word boundary between them. No
    // other mention appears anywhere else in the body.
    expect(
      webhook.matchesDispatchAllowlist(
        entries,
        "issue_comment",
        "created",
        "match-owner/match-repo",
        "trusted-actor-one",
        "hey @review-botnet, unrelated tool, please ignore"
      )
    ).toBe(false);
  });

  // AC-SEC-3: the function never returns the comment body itself, only a boolean.
  it("never returns the comment body -- only ever a boolean, even on a match", () => {
    const result = webhook.matchesDispatchAllowlist(
      entries,
      "issue_comment",
      "created",
      "match-owner/match-repo",
      "trusted-actor-one",
      "@review-bot please act on UNIQUE-COMMENT-MARKER-9f2a"
    );
    expect(typeof result).toBe("boolean");
  });
});

// --- forwardToAgentHook (#117, AC-FN-11/12) ---------------------------------

describe("forwardToAgentHook", () => {
  // AC-FN-11
  it("POSTs a body containing only sessionKey and trigger{event, repo, resource, actor, deliveryId} -- never the raw comment/PR body", async () => {
    const marker = "RAW-BODY-TEXT-MARKER-should-never-be-forwarded-3f8c";
    const { fetchImpl, calls } = createStubFetch();
    const payload = {
      repository: { full_name: "forward-owner/forward-repo" },
      issue: { number: 77 },
      sender: { login: "forward-actor" },
      comment: { id: 321, body: marker },
      deliveryId: "delivery-abc-123"
    };

    const result = await webhook.forwardToAgentHook("forward-owner/forward-repo#77", "issue_comment", payload, {
      hookUrl: "http://stub-target.invalid/hooks/agent",
      hookToken: "stub-token",
      fetchImpl
    });

    expect(result).toEqual({ forwarded: true });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("unreachable: length checked above");
    expect(call.url).toBe("http://stub-target.invalid/hooks/agent");
    const sentBody = JSON.parse(String(call.init["body"])) as { sessionKey: string; trigger: Record<string, unknown> };
    expect(sentBody).toEqual({
      sessionKey: "forward-owner/forward-repo#77",
      trigger: {
        event: "issue_comment",
        repo: "forward-owner/forward-repo",
        resource: 77,
        actor: "forward-actor",
        deliveryId: "delivery-abc-123"
      }
    });
    expect(JSON.stringify(sentBody)).not.toContain(marker);

    const headers = call.init["headers"] as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer stub-token");
  });

  it("omits the authorization header when no hook token is configured", async () => {
    const { fetchImpl, calls } = createStubFetch();
    await webhook.forwardToAgentHook("k#1", "pull_request", prPayload(), {
      hookUrl: "http://stub-target.invalid/hooks/agent",
      fetchImpl
    });
    const call = calls[0];
    if (call === undefined) throw new Error("unreachable");
    const headers = call.init["headers"] as Record<string, string>;
    expect(headers["authorization"]).toBeUndefined();
  });

  // AC-FN-12
  it("returns { forwarded: false } and never throws when the downstream fetch rejects", async () => {
    const fetchImpl = (async () => {
      throw new Error("simulated network failure reaching the gateway");
    }) as unknown as typeof fetch;

    await expect(
      webhook.forwardToAgentHook("k#1", "pull_request", prPayload(), { hookUrl: "http://stub-target.invalid/hooks/agent", fetchImpl })
    ).resolves.toEqual({ forwarded: false });
  });

  it("returns { forwarded: false } when the downstream responds non-2xx", async () => {
    const { fetchImpl } = createStubFetch(() => ({ ok: false, status: 503 }));
    const result = await webhook.forwardToAgentHook("k#1", "pull_request", prPayload(), {
      hookUrl: "http://stub-target.invalid/hooks/agent",
      fetchImpl
    });
    expect(result).toEqual({ forwarded: false });
  });
});

// --- resolveAgentHookUrl (#117) ---------------------------------------------

describe("resolveAgentHookUrl", () => {
  it("defaults to http://127.0.0.1:18789/hooks/agent, matching the pinned wrapper's own gateway-proxy default", () => {
    expect(webhook.resolveAgentHookUrl({})).toBe("http://127.0.0.1:18789/hooks/agent");
  });

  it("honors an explicit OPENCLAW_AGENT_HOOK_URL override", () => {
    expect(webhook.resolveAgentHookUrl({ OPENCLAW_AGENT_HOOK_URL: "http://explicit-override.invalid/custom-path" })).toBe(
      "http://explicit-override.invalid/custom-path"
    );
  });

  it("tracks INTERNAL_GATEWAY_HOST / INTERNAL_GATEWAY_PORT when the wrapper's own gateway target is overridden", () => {
    expect(webhook.resolveAgentHookUrl({ INTERNAL_GATEWAY_HOST: "10.1.2.3", INTERNAL_GATEWAY_PORT: "9999" })).toBe(
      "http://10.1.2.3:9999/hooks/agent"
    );
  });
});

// --- handleGithubWebhookVerify dispatch wiring (#117, AC-FN-13/14, AC-TST-2) ---

describe("handleGithubWebhookVerify -- dispatch wiring", () => {
  /** Builds a POST request whose raw body verifies against TEST_SECRET, with the given event/delivery headers. */
  function createSignedRequest(payload: unknown, headers: { event: string; deliveryId: string }) {
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = webhook.computeGithubSignature(TEST_SECRET, rawBody);
    return createFakeReq({
      method: "POST",
      headers: {
        "x-hub-signature-256": signature,
        "x-github-event": headers.event,
        "x-github-delivery": headers.deliveryId
      },
      body: rawBody
    });
  }

  function allowlistEnv(repo: string) {
    return {
      GITHUB_DISPATCH_ALLOWLIST: JSON.stringify([
        {
          repo,
          events: [
            { event: "pull_request", actions: ["opened", "synchronize"] },
            { event: "issue_comment", actions: ["created"], trustedMention: { actors: ["trusted-actor"], pattern: "@bot\\b" } }
          ]
        }
      ])
    };
  }

  // AC-FN-13 (allowed path)
  it("a verified, allowlisted, non-duplicate delivery results in exactly one forward call using the session key, and still responds 200", async () => {
    const originalAllowlist = process.env.GITHUB_DISPATCH_ALLOWLIST;
    const repo = "dispatch-owner/dispatch-repo-allowed";
    process.env.GITHUB_DISPATCH_ALLOWLIST = allowlistEnv(repo).GITHUB_DISPATCH_ALLOWLIST;
    try {
      const payload = prPayload({ repo, number: 200, sha: "sha-allowed" });
      const req = createSignedRequest(payload, { event: "pull_request", deliveryId: "delivery-allowed-1" });
      const res = createFakeRes();
      const { fetchImpl, calls } = createStubFetch();

      await webhook.handleGithubWebhookVerify(req, res, {
        secret: TEST_SECRET,
        dedupStore: new Set(),
        forward: { fetchImpl, hookUrl: "http://stub-target.invalid/hooks/agent" }
      });

      expect(res.statusCode).toBe(200);
      expect(calls).toHaveLength(1);
      const call = calls[0];
      if (call === undefined) throw new Error("unreachable");
      const sentBody = JSON.parse(String(call.init["body"])) as { sessionKey: string };
      expect(sentBody.sessionKey).toBe(webhook.computeDedupKey("pull_request", payload));
    } finally {
      if (originalAllowlist === undefined) delete process.env.GITHUB_DISPATCH_ALLOWLIST;
      else process.env.GITHUB_DISPATCH_ALLOWLIST = originalAllowlist;
    }
  });

  // AC-FN-13 (unenrolled: repo not in allowlist)
  it("a verified delivery for a repo NOT in the allowlist results in zero forward calls, and still responds 200", async () => {
    const originalAllowlist = process.env.GITHUB_DISPATCH_ALLOWLIST;
    process.env.GITHUB_DISPATCH_ALLOWLIST = allowlistEnv("some-other-owner/some-other-repo").GITHUB_DISPATCH_ALLOWLIST;
    try {
      const payload = prPayload({ repo: "unenrolled-owner/unenrolled-repo", number: 1, sha: "sha-x" });
      const req = createSignedRequest(payload, { event: "pull_request", deliveryId: "delivery-unenrolled-1" });
      const res = createFakeRes();
      const { fetchImpl, calls } = createStubFetch();

      await webhook.handleGithubWebhookVerify(req, res, {
        secret: TEST_SECRET,
        dedupStore: new Set(),
        forward: { fetchImpl }
      });

      expect(res.statusCode).toBe(200);
      expect(calls).toHaveLength(0);
    } finally {
      if (originalAllowlist === undefined) delete process.env.GITHUB_DISPATCH_ALLOWLIST;
      else process.env.GITHUB_DISPATCH_ALLOWLIST = originalAllowlist;
    }
  });

  // AC-FN-13 (unsupported event type)
  it("a verified delivery for an unsupported event type results in zero forward calls, and still responds 200", async () => {
    const payload = { repository: { full_name: "some-owner/some-repo" }, ref: "refs/heads/main" };
    const req = createSignedRequest(payload, { event: "push", deliveryId: "delivery-push-1" });
    const res = createFakeRes();
    const { fetchImpl, calls } = createStubFetch();

    await webhook.handleGithubWebhookVerify(req, res, { secret: TEST_SECRET, dedupStore: new Set(), forward: { fetchImpl } });

    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(0);
  });

  // AC-FN-13 (untrusted issue_comment actor)
  it("a verified issue_comment delivery from an untrusted actor results in zero forward calls, and still responds 200", async () => {
    const originalAllowlist = process.env.GITHUB_DISPATCH_ALLOWLIST;
    const repo = "dispatch-owner/dispatch-repo-untrusted";
    process.env.GITHUB_DISPATCH_ALLOWLIST = allowlistEnv(repo).GITHUB_DISPATCH_ALLOWLIST;
    try {
      const payload = issueCommentPayload({ repo, number: 5, commentId: 9, actor: "an-untrusted-drive-by-actor", body: "@bot please act" });
      const req = createSignedRequest(payload, { event: "issue_comment", deliveryId: "delivery-untrusted-1" });
      const res = createFakeRes();
      const { fetchImpl, calls } = createStubFetch();

      await webhook.handleGithubWebhookVerify(req, res, { secret: TEST_SECRET, dedupStore: new Set(), forward: { fetchImpl } });

      expect(res.statusCode).toBe(200);
      expect(calls).toHaveLength(0);
    } finally {
      if (originalAllowlist === undefined) delete process.env.GITHUB_DISPATCH_ALLOWLIST;
      else process.env.GITHUB_DISPATCH_ALLOWLIST = originalAllowlist;
    }
  });

  // AC-FN-13 (duplicate dedup key)
  it("a repeat delivery of an already-forwarded dedup key results in zero additional forward calls, and still responds 200", async () => {
    const originalAllowlist = process.env.GITHUB_DISPATCH_ALLOWLIST;
    const repo = "dispatch-owner/dispatch-repo-dup";
    process.env.GITHUB_DISPATCH_ALLOWLIST = allowlistEnv(repo).GITHUB_DISPATCH_ALLOWLIST;
    try {
      const payload = prPayload({ repo, number: 300, sha: "sha-dup" });
      const dedupStore = new Set<string>();
      const { fetchImpl, calls } = createStubFetch();

      const req1 = createSignedRequest(payload, { event: "pull_request", deliveryId: "delivery-dup-1" });
      const res1 = createFakeRes();
      await webhook.handleGithubWebhookVerify(req1, res1, { secret: TEST_SECRET, dedupStore, forward: { fetchImpl } });
      expect(res1.statusCode).toBe(200);
      expect(calls).toHaveLength(1);

      // Same payload again -- GitHub's own at-least-once delivery guarantee
      // means an identical redelivery is expected, not exotic.
      const req2 = createSignedRequest(payload, { event: "pull_request", deliveryId: "delivery-dup-1-redelivered" });
      const res2 = createFakeRes();
      await webhook.handleGithubWebhookVerify(req2, res2, { secret: TEST_SECRET, dedupStore, forward: { fetchImpl } });
      expect(res2.statusCode).toBe(200);
      expect(calls).toHaveLength(1); // still 1 -- the repeat did not forward again
    } finally {
      if (originalAllowlist === undefined) delete process.env.GITHUB_DISPATCH_ALLOWLIST;
      else process.env.GITHUB_DISPATCH_ALLOWLIST = originalAllowlist;
    }
  });

  // A malformed GITHUB_DISPATCH_ALLOWLIST must degrade to "do not forward,"
  // never a 500 to GitHub for a delivery it verified correctly.
  it("a malformed GITHUB_DISPATCH_ALLOWLIST results in zero forward calls but STILL responds 200 (never a 500 for this delivery)", async () => {
    const originalAllowlist = process.env.GITHUB_DISPATCH_ALLOWLIST;
    process.env.GITHUB_DISPATCH_ALLOWLIST = "{ this is not valid JSON";
    try {
      const payload = prPayload({ repo: "config-error-owner/config-error-repo", number: 1, sha: "sha-x" });
      const req = createSignedRequest(payload, { event: "pull_request", deliveryId: "delivery-config-error-1" });
      const res = createFakeRes();
      const { fetchImpl, calls } = createStubFetch();

      await webhook.handleGithubWebhookVerify(req, res, { secret: TEST_SECRET, dedupStore: new Set(), forward: { fetchImpl } });

      expect(res.statusCode).toBe(200);
      expect(calls).toHaveLength(0);
    } finally {
      if (originalAllowlist === undefined) delete process.env.GITHUB_DISPATCH_ALLOWLIST;
      else process.env.GITHUB_DISPATCH_ALLOWLIST = originalAllowlist;
    }
  });

  // AC-SEC-2: the dispatch outcome logged alongside {route, result} is a
  // bounded value, and no log line ever includes the session key, dedup
  // key, raw allowlist config, or comment body.
  it("logs a bounded dispatch outcome and never leaks the session key, allowlist config, or comment body", async () => {
    const originalAllowlist = process.env.GITHUB_DISPATCH_ALLOWLIST;
    const repo = "log-hygiene-owner/log-hygiene-repo";
    process.env.GITHUB_DISPATCH_ALLOWLIST = allowlistEnv(repo).GITHUB_DISPATCH_ALLOWLIST;
    try {
      const secretMarker = "UNIQUE-COMMENT-BODY-MARKER-should-never-be-logged-7ad2";
      const payload = issueCommentPayload({ repo, number: 12, commentId: 1, actor: "trusted-actor", body: `@bot ${secretMarker}` });
      const req = createSignedRequest(payload, { event: "issue_comment", deliveryId: "delivery-log-hygiene-1" });
      const res = createFakeRes();
      const { fetchImpl } = createStubFetch();
      const logged: string[] = [];

      await webhook.handleGithubWebhookVerify(req, res, {
        secret: TEST_SECRET,
        dedupStore: new Set(),
        forward: { fetchImpl },
        log: (line) => logged.push(line)
      });

      expect(logged.length).toBeGreaterThan(0);
      const dispatchLine = logged.find((line) => parseLoggedLine(line).dispatch !== undefined);
      expect(dispatchLine).toBeDefined();
      const parsedDispatch = dispatchLine === undefined ? undefined : parseLoggedLine(dispatchLine).dispatch;
      expect(["forwarded", "not-enrolled", "no-match", "duplicate", "config-error"]).toContain(parsedDispatch);
      for (const line of logged) {
        expect(line).not.toContain(secretMarker);
        expect(line).not.toContain(webhook.computeDedupKey("issue_comment", payload) ?? "unreachable-dedup-key");
      }
    } finally {
      if (originalAllowlist === undefined) delete process.env.GITHUB_DISPATCH_ALLOWLIST;
      else process.env.GITHUB_DISPATCH_ALLOWLIST = originalAllowlist;
    }
  });

  // AC-TST-2 -- the retro rule from #108: a fixture built fresh-only misses
  // "already wired into the pipeline" bugs. This drives the SAME shared
  // request-stream resource `readRawBody`'s own tests already cover in
  // isolation into an already-drained (post-side-effect) state BEFORE
  // handling it, but this time through the full, newly-extended
  // handleGithubWebhookVerify -- proving the new multi-secret-resolution and
  // dispatch wiring added in this deliverable never gets far enough to run
  // (no signature check, no dedup/allowlist consult, no forward call) when
  // an earlier pipeline stage (modeled here exactly as #108's own docs
  // describe: e.g. a body parser registered ahead of this route) has
  // already consumed the request stream.
  it("responds 400 and attempts NO dispatch when the request stream was already drained by an earlier pipeline stage", async () => {
    const req = createFakeReq({ method: "POST", headers: { "x-github-event": "pull_request" }, body: Buffer.from("already consumed") });
    // Model the exact prior-stage effect: an earlier body-parser fully
    // drains the stream before this handler's own readRawBody ever attaches
    // its listeners -- the same scenario #108's own review documented.
    req.resume();
    await new Promise<void>((resolve) => req.once("end", () => resolve()));
    expect(req.readableEnded).toBe(true);

    const res = createFakeRes();
    const { fetchImpl, calls } = createStubFetch();
    await webhook.handleGithubWebhookVerify(req, res, { secret: TEST_SECRET, dedupStore: new Set(), forward: { fetchImpl } });

    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0); // dispatch wiring never ran -- the response short-circuited before it
  });

  // A second angle on AC-TST-2: the dedupStore itself is a resource that can
  // already carry a prior side effect (a previous request in this same
  // process already forwarded this exact key) BEFORE this call ever runs --
  // proven here by pre-seeding it directly, rather than only via a first
  // live call as the AC-FN-13 duplicate test above does.
  it("treats a dedupStore pre-seeded with the delivery's own dedup key (a prior side effect from before this call) as a duplicate", async () => {
    const originalAllowlist = process.env.GITHUB_DISPATCH_ALLOWLIST;
    const repo = "preseeded-owner/preseeded-repo";
    process.env.GITHUB_DISPATCH_ALLOWLIST = allowlistEnv(repo).GITHUB_DISPATCH_ALLOWLIST;
    try {
      const payload = prPayload({ repo, number: 9001, sha: "sha-preseeded" });
      const dedupKey = webhook.computeDedupKey("pull_request", payload);
      if (dedupKey === undefined) throw new Error("unreachable: payload is well-formed");
      const dedupStore = new Set<string>([dedupKey]); // pre-seeded BEFORE the handler ever runs

      const req = createSignedRequest(payload, { event: "pull_request", deliveryId: "delivery-preseeded-1" });
      const res = createFakeRes();
      const { fetchImpl, calls } = createStubFetch();

      await webhook.handleGithubWebhookVerify(req, res, { secret: TEST_SECRET, dedupStore, forward: { fetchImpl } });

      expect(res.statusCode).toBe(200);
      expect(calls).toHaveLength(0);
    } finally {
      if (originalAllowlist === undefined) delete process.env.GITHUB_DISPATCH_ALLOWLIST;
      else process.env.GITHUB_DISPATCH_ALLOWLIST = originalAllowlist;
    }
  });

  // AC-FN-3 parity: with GITHUB_WEBHOOK_SECRETS resolving to exactly one
  // secret (the new multi-secret path, not the options.secret override),
  // the response contract is unchanged from single-secret behavior.
  it("AC-FN-3 parity: a single secret configured via GITHUB_WEBHOOK_SECRETS (not options.secret) verifies exactly like the legacy single-secret path", async () => {
    const originalSecrets = process.env.GITHUB_WEBHOOK_SECRETS;
    const originalLegacy = process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    process.env.GITHUB_WEBHOOK_SECRETS = JSON.stringify([TEST_SECRET]);
    try {
      const payload = { repository: { full_name: "parity-owner/parity-repo" } };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const signature = webhook.computeGithubSignature(TEST_SECRET, rawBody);
      const req = createFakeReq({ method: "POST", headers: { "x-hub-signature-256": signature }, body: rawBody });
      const res = createFakeRes();
      await webhook.handleGithubWebhookVerify(req, res); // no options at all -- purely env-driven
      expect(res.statusCode).toBe(200);
    } finally {
      if (originalSecrets === undefined) delete process.env.GITHUB_WEBHOOK_SECRETS;
      else process.env.GITHUB_WEBHOOK_SECRETS = originalSecrets;
      if (originalLegacy === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
      else process.env.GITHUB_WEBHOOK_SECRET = originalLegacy;
    }
  });

  it("responds 500 and attempts no dispatch when GITHUB_WEBHOOK_SECRETS is malformed", async () => {
    const originalSecrets = process.env.GITHUB_WEBHOOK_SECRETS;
    process.env.GITHUB_WEBHOOK_SECRETS = "not valid json";
    try {
      const req = createUntouchableReq("POST");
      const res = createFakeRes();
      await webhook.handleGithubWebhookVerify(req, res, {});
      expect(res.statusCode).toBe(500);
    } finally {
      if (originalSecrets === undefined) delete process.env.GITHUB_WEBHOOK_SECRETS;
      else process.env.GITHUB_WEBHOOK_SECRETS = originalSecrets;
    }
  });

  // Regression: an earlier revision interpolated JSON.parse's own error
  // message into the thrown config error. V8's SyntaxError echoes short
  // unparseable inputs back in full, so a misconfigured GITHUB_WEBHOOK_SECRETS
  // (an operator setting the raw secret string instead of `["<secret>"]`)
  // wrote the secret itself into this console.error line. Assert the actual
  // logged text, not just the status code the earlier test only checked.
  it("never logs the raw GITHUB_WEBHOOK_SECRETS value, even one short enough for V8 to echo in full on a parse failure", async () => {
    const originalSecrets = process.env.GITHUB_WEBHOOK_SECRETS;
    const leakCandidate = "s3cr3t-webhook-value";
    process.env.GITHUB_WEBHOOK_SECRETS = leakCandidate; // a raw secret, not JSON -- the exact misconfiguration this feature exists to reject
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const req = createUntouchableReq("POST");
      const res = createFakeRes();
      await webhook.handleGithubWebhookVerify(req, res, {});
      expect(res.statusCode).toBe(500);
      expect(errorSpy).toHaveBeenCalled();
      const loggedText = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(loggedText).not.toContain(leakCandidate);
    } finally {
      errorSpy.mockRestore();
      if (originalSecrets === undefined) delete process.env.GITHUB_WEBHOOK_SECRETS;
      else process.env.GITHUB_WEBHOOK_SECRETS = originalSecrets;
    }
  });

  it("never logs the raw GITHUB_DISPATCH_ALLOWLIST value on a parse failure", async () => {
    const originalAllowlist = process.env.GITHUB_DISPATCH_ALLOWLIST;
    const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;
    const leakCandidate = "not-json-and-short";
    process.env.GITHUB_DISPATCH_ALLOWLIST = leakCandidate;
    process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const payload = { repository: { full_name: "parity-owner/parity-repo" }, action: "opened" };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const signature = webhook.computeGithubSignature(TEST_SECRET, rawBody);
      const req = createFakeReq({
        method: "POST",
        headers: { "x-hub-signature-256": signature, "x-github-event": "pull_request" },
        body: rawBody,
      });
      const res = createFakeRes();
      await webhook.handleGithubWebhookVerify(req, res, {});
      // A malformed allowlist fails closed on the DISPATCH decision only --
      // the delivery itself still verified, so the HTTP response is 200.
      expect(res.statusCode).toBe(200);
      const loggedText = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(loggedText).not.toContain(leakCandidate);
    } finally {
      errorSpy.mockRestore();
      if (originalAllowlist === undefined) delete process.env.GITHUB_DISPATCH_ALLOWLIST;
      else process.env.GITHUB_DISPATCH_ALLOWLIST = originalAllowlist;
      if (originalSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
      else process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
    }
  });
});

// --- AC-FN-14: no dependency beyond node:* built-ins + forwardToAgentHook's own HTTP call ---

describe("module dependency constraint (AC-FN-14)", () => {
  it("imports nothing beyond node:* built-ins", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(webhookModulePath, "utf8");
    const importLines = source.split("\n").filter((line) => /^\s*import\s/.test(line));
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line).toMatch(/from\s+"node:/);
    }
    // No call resembling a workflow-state/database/runtime API -- the only
    // external call this module makes is forwardToAgentHook's own fetch to
    // the configured hook URL.
    for (const forbidden of ["workflow-state", "prisma", "postgres", "mongodb", "redis"]) {
      expect(source.toLowerCase()).not.toContain(forbidden);
    }
  });
});
