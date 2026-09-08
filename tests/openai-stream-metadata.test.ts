import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = readFileSync(join(root, "fixtures/openai-stream-metadata/openai-transport-stream.ts.txt"), "utf8");
const helperPath = join(root, "scripts/openai-stream-metadata.ts");
const patchPath = join(root, "scripts/patch-openai-stream-metadata.mjs");
const patch = createRequire(import.meta.url)(patchPath) as {
  patchOpenAIStreamMetadata(source: string): string;
  instrumentOpenAIStreamMetadata(source: string): string;
};
interface Collector {
  context(emitReasoning: boolean): void;
  request(payload: unknown): void;
  chunk(chunk: unknown): void;
  beforeNormalization(output: unknown): void;
  finish(output: unknown): void;
}
type CreateCollector = (enabled: boolean, model: unknown, write: (line: string) => void) => Collector | undefined;
function compile(source: string) {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
}
const compiledDirectory = mkdtempSync(join(tmpdir(), "stream-metadata-modules-"));
const nativeRequire = createRequire(import.meta.url);
const compiledHelper = join(compiledDirectory, "metadata.cjs");
writeFileSync(compiledHelper, compile(readFileSync(helperPath, "utf8")).outputText);
const createCollector = (nativeRequire(compiledHelper) as { createOpenAIStreamMetadata: CreateCollector }).createOpenAIStreamMetadata;
afterAll(() => { rmSync(compiledDirectory, { recursive: true, force: true }); });
describe("OpenAI stream metadata", () => {
  it("typechecks the copied helper independently of the control-plane project", () => {
    const program = ts.createProgram([helperPath], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true });
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  });

  it("returns no collector when disabled", () => {
    expect(createCollector(false, "model", () => { throw new Error("unreachable"); })).toBeUndefined();
  });
  it("captures scalar request and reasoning context without payloads", () => {
    const lines: string[] = [];
    const collector = createCollector(true, "test/model", line => lines.push(line))!;
    collector.context(false);
    collector.request({ model: "test/model", max_completion_tokens: 123, messages: [{}], tools: [{}, {}], stream_options: { include_usage: true } });
    collector.finish({ content: [], stopReason: "length" });
    expect(JSON.parse(lines[0]!)).toMatchObject({ schemaVersion: 2, emitReasoning: false,
      request: { maxCompletionTokens: 123, messageCount: 1, toolCount: 2, includeUsage: true } });
  });
  it("distinguishes missing usage from explicit zero and bounds finalization", () => {
    const records: any[] = [];
    for (const chunk of [{ choices: [] }, { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }]) {
      const collector = createCollector(true, "test/model", line => records.push(JSON.parse(line)))!;
      collector.chunk(chunk);
      collector.finish({});
      collector.finish({});
    }
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ chunkUsageSeen: false, chunkUsage: null });
    expect(records[1]).toMatchObject({ chunkUsageSeen: true, chunkUsage: { input: 0, output: 0, total: 0 } });
  });
  it("isolates a throwing log sink", () => {
    const collector = createCollector(true, "test/model", () => { throw new Error("sink"); })!;
    expect(() => collector.finish({ stopReason: "stop" })).not.toThrow();
  });
  it("retains choice-level usage when top-level usage is absent", () => {
    const lines: string[] = [];
    const collector = createCollector(true, "test/model", line => lines.push(line))!;
    collector.chunk({ choices: [{ delta: {}, finish_reason: "stop",
      usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 } }] });
    collector.finish({ content: [], stopReason: "stop" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ chunkUsageSeen: false, chunkUsage: null,
      choiceUsageSeen: true, choiceUsage: { input: 5, output: 8, total: 13 } });
  });
  it("excludes payload secrets, bounds records and ignores invalid metadata", () => {
    const lines: string[] = [];
    const collector = createCollector(true, "bad\nmodel", line => lines.push(line))!;
    const secret = "DO_NOT_LOG_PRIVATE_CONTENT";
    collector.request({ messages: [{ content: secret }], tools: [{ description: secret }], headers: { authorization: secret }, max_tokens: Infinity });
    for (let i = 0; i < 10000; i++) collector.chunk({ id: secret.repeat(10), model: "\n" + secret,
      error: secret, usage: { completion_tokens: -1 }, choices: [{ delta: { content: secret, reasoning: secret,
        tool_calls: [{ function: { name: secret, arguments: secret } }] }, finish_reason: secret }] });
    collector.finish({ content: [], errorMessage: secret, stopReason: "error" });
    collector.finish({});
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(secret);
    expect(lines[0]!.length).toBeLessThan(3000);
    expect(JSON.parse(lines[0]!)).toMatchObject({ responseId: null, responseModel: null, finishReason: "other", chunkUsage: { output: null } });
  });
});

describe("selected transport build patch", () => {
  it("applies to the complete pinned source and emits syntactically valid TS", () => {
    expect(compile(patch.patchOpenAIStreamMetadata(fixture)).diagnostics).toEqual([]);
    expect(() => patch.patchOpenAIStreamMetadata(fixture + "\n")).toThrow(/drift/);
    expect(() => patch.patchOpenAIStreamMetadata(patch.patchOpenAIStreamMetadata(fixture))).toThrow(/drift/);
    expect(() => patch.instrumentOpenAIStreamMetadata(fixture.replace("export function createOpenAICompletionsTransportStreamFn(): StreamFn {", ""))).toThrow(/anchor/);
  });
  it("CLI installs the companion and rejects reapplication without changing files", () => {
    const directory = mkdtempSync(join(tmpdir(), "stream-metadata-test-"));
    try {
      const providerDir = join(directory, "src/agents");
      mkdirSync(providerDir, { recursive: true });
      const target = join(providerDir, "openai-transport-stream.ts");
      writeFileSync(target, fixture);
      const run = () => spawnSync(process.execPath, [patchPath, directory], { encoding: "utf8" });
      expect(run().status).toBe(0);
      const patched = readFileSync(target, "utf8");
      expect(patched).toBe(patch.patchOpenAIStreamMetadata(fixture));
      expect(existsSync(join(providerDir, "openai-stream-metadata.ts"))).toBe(true);
      expect(run().status).not.toBe(0);
      expect(readFileSync(target, "utf8")).toBe(patched);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
