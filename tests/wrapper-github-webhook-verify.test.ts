import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Issue #108 (github-webhook-verify), deliverable D3.
//
// Direct unit tests of scripts/wrapper-github-webhook-verify.mjs's exported
// functions (D1). D1 is authored in parallel, against the module contract
// pinned in docs/plans/github-webhook-verify/plan.md -- this file is written
// against that stated contract, not against D1's source.
//
// Loaded the same way tests/openclaw-railway-wrapper-patches.test.ts loads
// scripts/wrapper-state-export.mjs: createRequire(...)(computedPath) rather
// than a static `import ... from "../scripts/*.mjs"`. tests/tsconfig.json has
// rootDir "." and no allowJs, so a static import of an untyped .mjs path
// cannot be typechecked by `tsc -b`/`pretest`; createRequire hands the file
// to Node's own loader instead, so the missing-module failure (D1 does not
// exist yet in this worktree) surfaces as a single runtime error scoped to
// this file when vitest collects it, without breaking `tsc -b` for the rest
// of the suite.
const nativeRequire = createRequire(import.meta.url);
const webhookModulePath = fileURLToPath(new URL("../scripts/wrapper-github-webhook-verify.mjs", import.meta.url));

interface WebhookVerifyModule {
  computeGithubSignature(secret: string, rawBody: Buffer): string;
  verifyGithubSignature(secret: string, rawBody: Buffer, headerValue: string | undefined): boolean;
  readRawBody(req: FakeIncomingMessage, opts?: { maxBytes?: number; timeoutMs?: number }): Promise<Buffer>;
  handleGithubWebhookVerify(
    req: FakeIncomingMessage | UntouchableReq,
    res: FakeRes,
    options?: { secret?: string; log?: (line: string) => void }
  ): Promise<void>;
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
}

/**
 * Accepts both the Express-style surface (status/set/type/send/json) and the
 * plain node:http ServerResponse surface (setHeader/end/writeHead), since the
 * module contract does not say which one D1 hands back.
 */
function createFakeRes(): FakeRes {
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
      return res;
    },
    json(obj) {
      res.body = obj;
      res.ended = true;
      res.headers["content-type"] = res.headers["content-type"] ?? "application/json";
      return res;
    },
    end(body) {
      if (body !== undefined) res.body = body;
      res.ended = true;
      return res;
    },
    writeHead(code, headers) {
      res.statusCode = code;
      if (headers) Object.assign(res.headers, headers);
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
  });

  // AC-TST-3
  it("responds 401 and logs no raw body/payload content for an invalid signature", async () => {
    const marker = "UNIQUE-MARKER-6f3a9c2e";
    const payload = { note: marker, repository: { full_name: "someone/somewhere" } };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const req = createFakeReq({
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}` }, // syntactically valid shape, wrong digest
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
    }
  });
});
