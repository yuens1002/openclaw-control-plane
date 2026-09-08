// Patch the application-owned transport selected by embedded-agent resolution.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_SHA256 = "cae1fafff86da4e75e4bd14b4fb449adf35263c005375d5f2df0958dfb71562b";
export function patchOpenAIStreamMetadata(source) {
  if (createHash("sha256").update(source).digest("hex") !== SOURCE_SHA256) {
    throw new Error("OpenAI transport source drift or already patched; re-verify the pinned upstream revision.");
  }
  return instrumentOpenAIStreamMetadata(source);
}
function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error(`Expected exactly one transport anchor: ${anchor}`);
  return source.replace(anchor, replacement);
}
export function instrumentOpenAIStreamMetadata(source) {
  const factoryStart = "export function createOpenAICompletionsTransportStreamFn(): StreamFn {";
  const processorStart = "async function processOpenAICompletionsStream(";
  const processorEnd = "type CompletionsReasoningDelta =";
  for (const anchor of [factoryStart, processorStart, processorEnd]) {
    if (source.split(anchor).length !== 2) throw new Error(`Expected exactly one transport anchor: ${anchor}`);
  }
  const start = source.indexOf(factoryStart);
  const middle = source.indexOf(processorStart);
  const end = source.indexOf(processorEnd);
  if (!(start < middle && middle < end)) throw new Error("Transport anchor order changed");
  let factory = source.slice(start, middle);
  let processor = source.slice(middle, end);
  factory = replaceOnce(factory, "      let firstEventAbort:",
    '      const streamMetadata = createOpenAIStreamMetadata(\n        process.env.OPENCLAW_STREAM_METADATA_DIAGNOSTICS === "1" && model.provider === "openrouter",\n        model.id, (line) => console.error(line),\n      );\n      let firstEventAbort:');
  factory = replaceOnce(factory, "        firstEventAbort = createFirstStreamEventAbortController(options?.signal);",
    "        streamMetadata?.context(emitReasoning);\n        streamMetadata?.request(params);\n        firstEventAbort = createFirstStreamEventAbortController(options?.signal);");
  factory = replaceOnce(factory, "          emitReasoning,", "          emitReasoning,\n          streamMetadata,");
  factory = replaceOnce(factory, "        firstEventAbort?.dispose();", "        streamMetadata?.finish(output);\n        firstEventAbort?.dispose();");
  processor = replaceOnce(processor, "    emitReasoning?: boolean;", "    emitReasoning?: boolean;\n    streamMetadata?: ReturnType<typeof createOpenAIStreamMetadata>;");
  processor = replaceOnce(processor, "  for await (const rawChunk of guardedStream) {", "  for await (const rawChunk of guardedStream) {\n    options?.streamMetadata?.chunk(rawChunk);");
  processor = replaceOnce(processor, "  const hasToolCalls = output.content.some", "  options?.streamMetadata?.beforeNormalization(output);\n  const hasToolCalls = output.content.some");
  const rewritten = source.slice(0, start) + factory + processor + source.slice(end);
  return replaceOnce(rewritten, 'import { randomUUID } from "node:crypto";',
    'import { createOpenAIStreamMetadata } from "./openai-stream-metadata.js";\nimport { randomUUID } from "node:crypto";');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2];
  if (!root) throw new Error("usage: node patch-openai-stream-metadata.mjs <openclaw-root>");
  const transportDir = join(root, "src/agents");
  const target = join(transportDir, "openai-transport-stream.ts");
  const companion = join(transportDir, "openai-stream-metadata.ts");
  if (existsSync(companion)) throw new Error("Diagnostic companion already exists; refusing overwrite.");
  const rewritten = patchOpenAIStreamMetadata(readFileSync(target, "utf8"));
  const helper = join(dirname(fileURLToPath(import.meta.url)), "openai-stream-metadata.ts");
  // Validate all source anchors and the helper before touching the target tree.
  readFileSync(helper, "utf8");
  copyFileSync(helper, companion);
  writeFileSync(target, rewritten);
}
