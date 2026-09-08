// Applies only to the inspected upstream source. Ref bumps deliberately fail
// until this patch is re-verified; never silently instrument a different loop.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_SHA256 = "58e0341a8283863b7e7443c43a246871ec9c699a176c89828523ccd3a2d12b5c";
export function patchOpenAIStreamMetadata(source) {
  if (createHash("sha256").update(source).digest("hex") !== SOURCE_SHA256) {
    throw new Error("OpenAI adapter source drift or already patched; re-verify against the pinned upstream revision.");
  }
  return instrumentOpenAIStreamMetadata(source);
}

// Exposed separately for executable synthetic-fixture tests. Production CLI
// always uses the hash-gated entry point above.
export function instrumentOpenAIStreamMetadata(source) {
  const changes = [
    ['import OpenAI from "openai";', 'import { createOpenAIStreamMetadata } from "./openai-stream-metadata.js";\nimport OpenAI from "openai";'],
    ['    let firstEventAbort:', '    const streamMetadata = createOpenAIStreamMetadata(\n      process.env.OPENCLAW_STREAM_METADATA_DIAGNOSTICS === "1" && model.provider === "openrouter",\n      model.id, (line) => console.error(line),\n    );\n    let firstEventAbort:'],
    ['      firstEventAbort = createFirstStreamEventAbortController(options?.signal);', '      streamMetadata?.request(params);\n      firstEventAbort = createFirstStreamEventAbortController(options?.signal);'],
    ['      for await (const chunk of guardedOpenaiStream) {', '      for await (const chunk of guardedOpenaiStream) {\n        streamMetadata?.chunk(chunk);'],
    ['      const hasToolCalls = output.content.some', '      streamMetadata?.beforeNormalization(output);\n      const hasToolCalls = output.content.some'],
    ['      firstEventAbort?.dispose();', '      streamMetadata?.finish(output);\n      firstEventAbort?.dispose();'],
  ];
  // Check every anchor before changing anything on disk.
  for (const [anchor] of changes) {
    if (source.split(anchor).length !== 2) throw new Error(`Expected exactly one adapter anchor: ${anchor}`);
  }
  for (const [anchor, replacement] of changes) source = source.replace(anchor, replacement);
  return source;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2];
  if (!root) throw new Error("usage: node patch-openai-stream-metadata.mjs <openclaw-root>");
  const providerDir = join(root, "packages/ai/src/providers");
  const target = join(providerDir, "openai-completions.ts");
  const companion = join(providerDir, "openai-stream-metadata.ts");
  if (existsSync(companion)) throw new Error("Diagnostic companion already exists; refusing overwrite.");
  const rewritten = patchOpenAIStreamMetadata(readFileSync(target, "utf8"));
  const helper = join(dirname(fileURLToPath(import.meta.url)), "openai-stream-metadata.ts");
  // Read helper before any write so a missing build input cannot half-patch.
  readFileSync(helper, "utf8");
  copyFileSync(helper, companion);
  writeFileSync(target, rewritten);
}
