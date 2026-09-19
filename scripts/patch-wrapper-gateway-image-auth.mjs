// Patches the pinned Railway wrapper so the OpenClaw gateway's own
// authenticated image routes (added in v2026.9.x) are authorized by the
// gateway itself instead of by the wrapper's dashboard Basic-Auth gate.
//
// The 9.x Control UI loads these images with fetch() and an explicit
// `Authorization: Bearer <candidate>` header (ui/src/pages/plugins/icon-loader.ts,
// resolveControlUiAuthCandidates), where the candidate is usually the paired
// device token -- not OPENCLAW_GATEWAY_TOKEN. The wrapper's gate only accepts
// Basic auth or a Bearer equal to OPENCLAW_GATEWAY_TOKEN, so every such fetch
// 401s with `WWW-Authenticate: Basic` and Chrome re-opens its native sign-in
// popup. Exempting the paths outright (as /avatar/ is) would be an auth
// bypass here: attachGatewayAuthHeader always overwrites Authorization with
// the gateway token before proxying, so an exempted anonymous request would
// reach the gateway with full shared-secret auth.
//
// Instead, only for these exact route shapes AND only when the request
// carries its own Bearer credential: skip the wrapper gate, mark the
// request, and have attachGatewayAuthHeader leave that credential untouched.
// The gateway then validates it (authorizeControlUiReadRequestOrReply:
// shared token or paired device token; in the token auth mode the wrapper
// always configures, a loopback source grants nothing on its own). A request
// with no Bearer still hits the wrapper's Basic-Auth gate exactly as before,
// and the gateway's own 401 carries no WWW-Authenticate header, so a
// rejected token cannot trigger the browser popup.
//
// The same two hooks also carry OpenClaw's public device-pairing join link,
// /j/<22-char shortcode>. The gateway serves it anonymously by design (the
// shortcode is the credential, rate-limited per client), and `openclaw doctor`
// requires an edge proxy to let it through without identity auth -- otherwise
// a phone opening the link hits the wrapper's Basic challenge. It skips the
// wrapper gate and is forwarded with NO Authorization header at all, so the
// gateway sees exactly the anonymous request it expects rather than one the
// wrapper silently upgraded to the gateway token.
//
// Same contract as the sibling patch-wrapper-*.mjs scripts: exact literal
// anchors, each guarded to exactly one occurrence plus an already-applied
// marker, all guards evaluated before anything is written. The anchors are
// the text produced by the Dockerfile's earlier `sed` patches, so this
// script must run after them.

import fs from "node:fs";

const targetPath = process.argv[2];
if (!targetPath) {
  console.error("usage: node patch-wrapper-gateway-image-auth.mjs <path-to-server.js>");
  process.exit(1);
}

// Mirrors CONTROL_UI_RESOURCE_ROUTES in OpenClaw's
// src/gateway/control-ui-resource-routes.ts (one encoded segment each, no
// base path -- the Control UI is root-mounted here). /avatar/ and
// /__openclaw__/assistant-media are deliberately absent: the wrapper already
// exempts them outright (see the Dockerfile).
// OpenClaw's device-pairing join shortcode: 16 random bytes, base64url
// (src/pairing/join-code.ts). Exact shape only -- this is an auth bypass.
const JOIN_PATTERN = String.raw`/^\/j\/[A-Za-z0-9_-]{22}$/`;
const ROUTE_PATTERN = String.raw`/^\/(?:__openclaw__\/(?:workspace-icon|link-favicon|plugin-icon|catalog-icon|channel-avatar)\/[^/]+|api\/users\/[^/]+\/avatar)$/`;

const replacements = [
  {
    label: "requireDashboardAuth definition (anchor for the gateway image route pattern)",
    oldBlock: `function requireDashboardAuth(req, res, next) {`,
    newBlock: `// Control-plane patch (scripts/patch-wrapper-gateway-image-auth.mjs): the
// gateway's own authenticated Control UI image routes and its public
// device-pairing join link. See requireDashboardAuth and
// attachGatewayAuthHeader below for how requests to them are handled.
const GATEWAY_AUTHED_IMAGE_PATH = ${ROUTE_PATTERN};
const GATEWAY_PUBLIC_JOIN_PATH = ${JOIN_PATTERN};

function requireDashboardAuth(req, res, next) {`,
    marker: `const GATEWAY_AUTHED_IMAGE_PATH =`,
  },
  {
    label: "assistant-media exemption line (anchor for the Bearer pass-through check)",
    oldBlock: `  if (req.path === "/__openclaw__/assistant-media") return next(); // exact match, not prefix -- see comment above this RUN step for why`,
    newBlock: `  if (req.path === "/__openclaw__/assistant-media") return next(); // exact match, not prefix -- see comment above this RUN step for why
  if (GATEWAY_AUTHED_IMAGE_PATH.test(req.path) && /^Bearer \\S+$/.test(req.headers.authorization || "")) { req.openclawClientBearerPassthrough = true; return next(); } // gateway validates this request's own Bearer -- see scripts/patch-wrapper-gateway-image-auth.mjs
  if (GATEWAY_PUBLIC_JOIN_PATH.test(req.path)) { req.openclawStripAuthorization = true; return next(); } // public pairing join link, forwarded anonymously -- see scripts/patch-wrapper-gateway-image-auth.mjs`,
    marker: `req.openclawClientBearerPassthrough = true`,
  },
  {
    label: "attachGatewayAuthHeader token overwrite (anchor for the pass-through guard)",
    oldBlock: `function attachGatewayAuthHeader(req) {
  if (OPENCLAW_GATEWAY_TOKEN) {`,
    newBlock: `function attachGatewayAuthHeader(req) {
  if (req.openclawClientBearerPassthrough) return; // keep the client's own Bearer for the gateway to validate -- never upgrade it to the gateway token
  if (req.openclawStripAuthorization) { delete req.headers.authorization; return; } // public join link: the gateway must see it anonymously
  if (OPENCLAW_GATEWAY_TOKEN) {`,
    marker: `if (req.openclawClientBearerPassthrough) return;`,
  },
];

const content = fs.readFileSync(targetPath, "utf8");

let failed = false;
for (const { label, oldBlock, marker } of replacements) {
  const alreadyApplied = content.split(marker).length - 1;
  if (alreadyApplied !== 0) {
    failed = true;
    console.error(
      `the ${label} replacement is already present in ${targetPath} (found ${alreadyApplied} occurrence(s) of the injected block); ` +
        "refusing to apply the gateway-image-auth patch twice.",
    );
    continue;
  }
  const occurrences = content.split(oldBlock).length - 1;
  if (occurrences !== 1) {
    failed = true;
    console.error(
      `expected exactly 1 occurrence of the ${label} in ${targetPath}, found ${occurrences}. ` +
        "The pinned wrapper's source (or an earlier Dockerfile sed patch) may have changed -- re-verify this patch before proceeding.",
    );
  }
}
if (failed) process.exit(1);

let patched = content;
for (const { oldBlock, newBlock } of replacements) {
  // Replacer function: a plain string replacement would interpret `$`-sequences in newBlock.
  patched = patched.replace(oldBlock, () => newBlock);
}
fs.writeFileSync(targetPath, patched);
console.log(`patched ${targetPath} with gateway-validated Bearer pass-through for the Control UI image routes and anonymous pairing join links`);
