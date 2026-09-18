// Patch the application-owned completions transport selected by embedded-agent
// resolution (`boundary-aware:openai-completions`). Since OpenClaw v2026.9.x the
// transport lives in the @openclaw/ai workspace package, split across two files:
// the factory (request setup, final cleanup) and the stream processor (chunk loop,
// tool-call finalization). Both are hash-pinned; the build fails closed on drift.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TRANSPORT_DIR = "packages/ai/src/transports";
export const SOURCES = {
  transport: { file: "openai-completions-transport.ts", sha256: "aed08a98d7b5af914901b34ed0435aad8982f9f9d01c217954cbb8eaac46d39d" },
  stream: { file: "openai-completions-stream.ts", sha256: "66dda2b657026cc7028027dd2113fbd59fff7f6f398c1962303cb6b58c58d3e5" },
};

export function patchOpenAIStreamMetadata(sources) {
  for (const [key, { file, sha256 }] of Object.entries(SOURCES)) {
    if (createHash("sha256").update(sources[key]).digest("hex") !== sha256) {
      throw new Error(`OpenAI transport source drift or already patched (${file}); re-verify the pinned upstream revision.`);
    }
  }
  return instrumentOpenAIStreamMetadata(sources);
}
function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error(`Expected exactly one transport anchor: ${anchor}`);
  return source.replace(anchor, () => replacement);
}
function applyAll(source, edits) {
  // Check every anchor before rewriting so a partial edit is never returned.
  for (const [anchor] of edits) {
    if (source.split(anchor).length !== 2) throw new Error(`Expected exactly one transport anchor: ${anchor}`);
  }
  return edits.reduce((text, [anchor, replacement]) => replaceOnce(text, anchor, replacement), source);
}
export function instrumentOpenAIStreamMetadata({ transport, stream }) {
  const factoryStart = "export function createOpenAICompletionsTransportStreamFn(): StreamFn {";
  const firstEventAbortDecl = "      let firstEventAbort:";
  if (transport.split(factoryStart).length !== 2) throw new Error(`Expected exactly one transport anchor: ${factoryStart}`);
  if (!(transport.indexOf(factoryStart) < transport.indexOf(firstEventAbortDecl))) throw new Error("Transport anchor order changed");
  const patchedTransport = applyAll(transport, [
    [firstEventAbortDecl,
      '      const streamMetadata = createOpenAIStreamMetadata(\n        process.env.OPENCLAW_STREAM_METADATA_DIAGNOSTICS === "1" && model.provider === "openrouter",\n        model.id, (line) => console.error(line),\n      );\n      let firstEventAbort:'],
    ["        firstEventAbort = createFirstStreamEventAbortController(options?.signal);",
      "        streamMetadata?.context(emitReasoning);\n        streamMetadata?.request(params);\n        firstEventAbort = createFirstStreamEventAbortController(options?.signal);"],
    ["          emitReasoning,", "          emitReasoning,\n          streamMetadata,"],
    ["        firstEventAbort?.dispose();", "        streamMetadata?.finish(output);\n        firstEventAbort?.dispose();"],
    ['import { randomUUID } from "node:crypto";',
      'import { createOpenAIStreamMetadata } from "./openai-stream-metadata.js";\nimport { randomUUID } from "node:crypto";'],
  ]);
  const patchedStream = applyAll(stream, [
    ["  emitReasoning?: boolean;",
      "  emitReasoning?: boolean;\n  streamMetadata?: ReturnType<typeof createOpenAIStreamMetadata>;"],
    ["  for await (const rawChunk of guardedStream) {",
      "  for await (const rawChunk of guardedStream) {\n    options?.streamMetadata?.chunk(rawChunk);"],
    // Tool-call finalization is the normalization step that can drop parsed blocks.
    ["  // Only an explicit stop or observed SSE terminal may authorize silent tool calls.\n  finalizeOpenAICompletionsToolCalls(output, {",
      "  options?.streamMetadata?.beforeNormalization(output);\n  // Only an explicit stop or observed SSE terminal may authorize silent tool calls.\n  finalizeOpenAICompletionsToolCalls(output, {"],
    ['import { randomUUID } from "node:crypto";',
      'import type { createOpenAIStreamMetadata } from "./openai-stream-metadata.js";\nimport { randomUUID } from "node:crypto";'],
  ]);
  return { transport: patchedTransport, stream: patchedStream };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2];
  if (!root) throw new Error("usage: node patch-openai-stream-metadata.mjs <openclaw-root>");
  const transportDir = join(root, TRANSPORT_DIR);
  const targets = Object.fromEntries(Object.entries(SOURCES).map(([key, { file }]) => [key, join(transportDir, file)]));
  const companion = join(transportDir, "openai-stream-metadata.ts");
  if (existsSync(companion)) throw new Error("Diagnostic companion already exists; refusing overwrite.");
  const rewritten = patchOpenAIStreamMetadata(
    Object.fromEntries(Object.entries(targets).map(([key, path]) => [key, readFileSync(path, "utf8")])),
  );
  const helper = join(dirname(fileURLToPath(import.meta.url)), "openai-stream-metadata.ts");
  // Validate all source anchors and the helper before touching the target tree.
  readFileSync(helper, "utf8");
  copyFileSync(helper, companion);
  for (const [key, path] of Object.entries(targets)) writeFileSync(path, rewritten[key]);
}
