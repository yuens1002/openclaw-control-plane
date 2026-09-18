import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// scripts/patch-wrapper-gateway-image-auth.mjs, exercised through its real
// surface (`node <script> <server.js>`) against a fixture carrying the pinned
// wrapper's requireDashboardAuth and attachGatewayAuthHeader exactly as the
// Dockerfile's earlier sed patches leave them (copied from the built image's
// src/server.js). The patched functions are then executed with fake
// request/response objects, so the assertions cover behaviour -- which
// requests reach the gateway, with which Authorization header -- not just
// the presence of injected text.

const patchPath = fileURLToPath(new URL("../scripts/patch-wrapper-gateway-image-auth.mjs", import.meta.url));

const WRAPPER_AUTH_FIXTURE = `function requireDashboardAuth(req, res, next) {
  if (req.path === "/healthz" || req.path === "/setup/healthz") return next();
  if (req.path.startsWith("/hooks")) return next(); // allow OpenClaw webhook endpoints to bypass dashboard auth
  if (req.path.startsWith("/avatar/")) return next(); // see comments above and below this RUN step for why each path is exempted
  if (req.path.startsWith("/provider-icons/")) return next(); // see comment above this RUN step for why
  if (req.path === "/__openclaw__/assistant-media") return next(); // exact match, not prefix -- see comment above this RUN step for why
  if (["/manifest.webmanifest", "/favicon.ico", "/favicon.svg", "/favicon-16.png", "/favicon-32.png", "/apple-touch-icon.png", "/sw.js", "/control-ui-config.json"].includes(req.path)) return next(); // see comments above and below this RUN step for why each path is exempted
  if (!SETUP_PASSWORD) return next(); // no password configured → open
  { const authHeader = req.headers.authorization || ""; const [authScheme, authValue] = authHeader.split(" "); if (authScheme === "Bearer" && OPENCLAW_GATEWAY_TOKEN && authValue === OPENCLAW_GATEWAY_TOKEN) return next(); }
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Dashboard"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Dashboard"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

function attachGatewayAuthHeader(req) {
  if (OPENCLAW_GATEWAY_TOKEN) {
    req.headers.authorization = \`Bearer \${OPENCLAW_GATEWAY_TOKEN}\`;
  }
}
`;

const SETUP_PASSWORD = "setup-secret";
const GATEWAY_TOKEN = "gateway-secret";
const DEVICE_TOKEN = "paired-device-token";
const BASIC = `Basic ${Buffer.from(`openclaw:${SETUP_PASSWORD}`).toString("base64")}`;

interface WrapperAuth {
  requireDashboardAuth(req: FakeRequest, res: FakeResponse, next: () => void): unknown;
  attachGatewayAuthHeader(req: FakeRequest): void;
}
interface FakeRequest {
  path: string;
  headers: { authorization?: string };
  openclawClientBearerPassthrough?: boolean;
}
interface FakeResponse {
  statusCode?: number;
  headers: Record<string, string>;
  set(name: string, value: string): FakeResponse;
  status(code: number): FakeResponse;
  send(body: string): FakeResponse;
}

function loadWrapperAuth(source: string): WrapperAuth {
  const context = vm.createContext({ SETUP_PASSWORD, OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN, Buffer });
  return vm.runInContext(`${source}\n;({ requireDashboardAuth, attachGatewayAuthHeader });`, context) as WrapperAuth;
}

/** Runs one request through the gate and, if it passes, the proxy's header step. */
function dispatch(auth: WrapperAuth, path: string, authorization?: string) {
  const req: FakeRequest = { path, headers: authorization === undefined ? {} : { authorization } };
  const res: FakeResponse = {
    headers: {},
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send() {
      return this;
    }
  };
  let proxied = false;
  auth.requireDashboardAuth(req, res, () => {
    proxied = true;
  });
  if (proxied) auth.attachGatewayAuthHeader(req);
  return {
    proxied,
    status: res.statusCode,
    challenge: res.headers["WWW-Authenticate"],
    forwardedAuthorization: proxied ? req.headers.authorization : undefined
  };
}

const IMAGE_PATHS = [
  "/__openclaw__/workspace-icon/agent%3Amain%3Amain",
  "/__openclaw__/workspace-icon/agent:main:main",
  "/__openclaw__/link-favicon/docs.openclaw.ai",
  "/__openclaw__/plugin-icon/openrouter",
  "/__openclaw__/catalog-icon/some-icon",
  "/__openclaw__/channel-avatar/agent%3Amain%3Aslack",
  "/api/users/gateway-owner/avatar"
];

// Near misses: a prefix-shaped or extended variant must not inherit the pass-through.
const NON_IMAGE_PATHS = [
  "/__openclaw__/workspace-icon/a/b",
  "/__openclaw__/workspace-icon/",
  "/__openclaw__/workspace-icon-extra/x",
  "/__openclaw__/link-favicon",
  "/api/users/gateway-owner/avatar/extra",
  "/api/users/gateway-owner/profile",
  "/api/users//avatar",
  "/v1/chat/completions",
  "/"
];

describe("patch-wrapper-gateway-image-auth", () => {
  let dir: string;
  let serverPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wrapper-image-auth-"));
    serverPath = join(dir, "server.js");
    writeFileSync(serverPath, WRAPPER_AUTH_FIXTURE);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const runPatch = () => spawnSync(process.execPath, [patchPath, serverPath], { encoding: "utf8" });

  it("applies once, keeps valid syntax, and refuses a second run", () => {
    const first = runPatch();
    expect(first.status, first.stderr).toBe(0);
    const check = spawnSync(process.execPath, ["--check", serverPath], { encoding: "utf8" });
    expect(check.status, check.stderr).toBe(0);

    const second = runPatch();
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain("refusing to apply the gateway-image-auth patch twice");
  });

  it("fails without writing when an anchor is missing", () => {
    const withoutAnchor = WRAPPER_AUTH_FIXTURE.replace(
      '  if (req.path === "/__openclaw__/assistant-media")',
      '  if (req.path === "/__openclaw__/assistant-media-renamed")'
    );
    writeFileSync(serverPath, withoutAnchor);
    const result = runPatch();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("found 0");
    expect(readFileSync(serverPath, "utf8")).toBe(withoutAnchor);
  });

  it("without a target path prints usage and exits non-zero", () => {
    const result = spawnSync(process.execPath, [patchPath], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("usage:");
  });

  describe("patched behaviour", () => {
    let unpatched: WrapperAuth;
    let patched: WrapperAuth;

    beforeEach(() => {
      unpatched = loadWrapperAuth(WRAPPER_AUTH_FIXTURE);
      expect(runPatch().status).toBe(0);
      patched = loadWrapperAuth(readFileSync(serverPath, "utf8"));
    });

    it("reproduces the popup before the patch: a device-token image fetch gets a Basic challenge", () => {
      for (const path of IMAGE_PATHS) {
        expect(dispatch(unpatched, path, `Bearer ${DEVICE_TOKEN}`)).toMatchObject({
          proxied: false,
          status: 401,
          challenge: 'Basic realm="OpenClaw Dashboard"'
        });
      }
    });

    it("forwards a device-token image fetch with its own Bearer, never the gateway token", () => {
      for (const path of IMAGE_PATHS) {
        expect(dispatch(patched, path, `Bearer ${DEVICE_TOKEN}`)).toEqual({
          proxied: true,
          status: undefined,
          challenge: undefined,
          forwardedAuthorization: `Bearer ${DEVICE_TOKEN}`
        });
      }
    });

    it("still requires dashboard auth for an image route without a Bearer", () => {
      for (const path of IMAGE_PATHS) {
        expect(dispatch(patched, path)).toMatchObject({ proxied: false, status: 401 });
        expect(dispatch(patched, path, "Bearer ")).toMatchObject({ proxied: false, status: 401 });
        expect(dispatch(patched, path, "Basic d3Jvbmc6d3Jvbmc=")).toMatchObject({ proxied: false, status: 401 });
      }
    });

    it("keeps Basic-authed image requests on the existing gateway-token path", () => {
      for (const path of IMAGE_PATHS) {
        expect(dispatch(patched, path, BASIC)).toMatchObject({
          proxied: true,
          forwardedAuthorization: `Bearer ${GATEWAY_TOKEN}`
        });
      }
    });

    it("does not extend the pass-through to any other path", () => {
      for (const path of NON_IMAGE_PATHS) {
        expect(dispatch(patched, path, `Bearer ${DEVICE_TOKEN}`), path).toMatchObject({
          proxied: false,
          status: 401
        });
      }
    });

    it("leaves the unrelated gates unchanged", () => {
      expect(dispatch(patched, "/setup/healthz")).toMatchObject({ proxied: true });
      expect(dispatch(patched, "/api/anything", `Bearer ${GATEWAY_TOKEN}`)).toMatchObject({
        proxied: true,
        forwardedAuthorization: `Bearer ${GATEWAY_TOKEN}`
      });
      expect(dispatch(patched, "/api/anything", BASIC)).toMatchObject({
        proxied: true,
        forwardedAuthorization: `Bearer ${GATEWAY_TOKEN}`
      });
    });
  });
});
