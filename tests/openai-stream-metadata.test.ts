import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = readFileSync(join(root, "fixtures/openai-stream-metadata/openai-completions.ts.txt"), "utf8");
const helperPath = join(root, "scripts/openai-stream-metadata.ts");
const patchPath = join(root, "scripts/patch-openai-stream-metadata.mjs");
const patch = createRequire(import.meta.url)(patchPath) as {
  patchOpenAIStreamMetadata(source: string): string;
  instrumentOpenAIStreamMetadata(source: string): string;
};
interface Collector {
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
let adapterModuleCount = 0;

// Execute the real, patched upstream stream function with a mock SDK iterable.
// Dependency mocks deliberately do not reimplement the normalization branch.
async function runAdapter(chunks: unknown[], settings: {
  enabled?: string; provider?: string; failBefore?: boolean; failDuring?: boolean;
  aborted?: boolean; throwingWriter?: boolean;
} = {}) {
  const summaries: string[] = [];
  const events: Record<string, any>[] = [];
  let ended!: () => void;
  const done = new Promise<void>(resolve => { ended = resolve; });
  const patched = patch.patchOpenAIStreamMetadata(fixture);
  const functionSource = patched.slice(patched.indexOf("export const streamOpenAICompletions:"),
    patched.indexOf("export const streamSimpleOpenAICompletions:"));
  let request: unknown;
  const dependencies = {
    createOpenAIStreamMetadata: createCollector,
    process: { env: { OPENCLAW_STREAM_METADATA_DIAGNOSTICS: settings.enabled ?? "1" } },
    console: { error(line: string) { if (settings.throwingWriter) throw new Error("sink"); summaries.push(line); } },
    AssistantMessageEventStream: class {
      push(event: Record<string, any>) { events.push(event); }
      end() { ended(); }
    },
    getEnvApiKey: () => "never-log-this-key",
    getCompat: () => ({}), resolveCacheRetention: () => "none",
    buildParams: () => ({ model: "openrouter/auto", messages: [{ content: "secret prompt" }] }),
    createClient: () => ({ chat: { completions: { create(payload: unknown) {
      request = payload;
      return { async withResponse() {
        if (settings.failBefore) throw new Error("secret provider error");
        return { response: { status: 200, headers: {} }, data: (async function* () {
          for (const chunk of chunks) yield chunk;
          if (settings.failDuring) throw new Error("secret stream error");
        })() };
      } };
    } } } }),
    createFirstStreamEventAbortController: () => ({ signal: {}, abort() {}, dispose() {} }),
    headersToRecord: () => ({}),
    withFirstStreamEventTimeout: (stream: unknown) => stream,
    getFirstStreamEventTimeoutMs: () => 0, getFirstStreamEventTimeoutHandler: () => undefined,
    parseStreamingJson: (value: string) => { try { return JSON.parse(value); } catch { return {}; } },
    createReasoningTagTextPartitioner: () => ({
      push: (text: string) => [{ kind: "text", text }],
      pushVisible: (text: string) => [{ kind: "text", text }],
      flush: () => [], isInsideReasoning: () => false, markStrict() {},
    }),
    mapOpenAIStopReason: (value: string) => ({ stopReason: value === "tool_calls" ? "toolUse" : value }),
    parseChunkUsage: (value: unknown) => value,
  };
  const compiledAdapter = join(compiledDirectory, `adapter-${adapterModuleCount++}.cjs`);
  // Compile trusted fixture code into an ordinary module; inject only mocked
  // dependencies, leaving the upstream stream/normalization body intact.
  writeFileSync(compiledAdapter, `module.exports = (dependencies) => {\nconst { ${Object.keys(dependencies).join(", ")} } = dependencies;\nconst exports = {};\n${compile(functionSource).outputText}\nreturn exports;\n};`);
  const moduleExports = nativeRequire(compiledAdapter)(dependencies) as Record<string, any>;
  const amendedRequest = { model: "openrouter/auto", max_tokens: 123, messages: [], tools: [], stream_options: { include_usage: true } };
  moduleExports.streamOpenAICompletions({ provider: settings.provider ?? "openrouter", id: "openrouter/auto", api: "openai-completions", reasoning: true }, {}, {
    signal: { aborted: settings.aborted ?? false }, reasoningEffort: "low", onPayload: () => amendedRequest,
  });
  await done;
  expect(request).toBe(amendedRequest); // instrumentation did not replace the request
  return { summaries: summaries.map(line => JSON.parse(line)), events };
}

const chunk = (delta: unknown, finish = "stop") => ({ id: "gen-test-1", model: "test/model", choices: [{ delta, finish_reason: finish }] });

describe("OpenAI stream metadata", () => {
  it("typechecks the copied helper independently of the control-plane project", () => {
    const program = ts.createProgram([helperPath], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true });
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  });

  it.each(["0", "true", ""]) ("does not collect when flag is %s", async enabled => {
    expect((await runAdapter([chunk({ content: "ok" })], { enabled })).summaries).toEqual([]);
    expect(createCollector(false, "model", () => { throw new Error("unreachable"); })).toBeUndefined();
  });
  it("does not collect for another provider", async () => {
    expect((await runAdapter([chunk({ content: "ok" })], { provider: "openai" })).summaries).toEqual([]);
  });
  it("records successful output and the final onPayload request scalars", async () => {
    const result = await runAdapter([chunk({ content: "private answer" })]);
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]).toMatchObject({ deltaTextChars: 14, request: { maxTokens: 123 },
      beforeNormalization: { text: 1 }, final: { text: 1, stopReason: "stop" } });
    expect(result.events.at(-1)?.type).toBe("done");
  });
  it("distinguishes empty length from partial tool blocks discarded on length", async () => {
    const empty = (await runAdapter([chunk({}, "length")])).summaries[0];
    const partial = (await runAdapter([chunk({ tool_calls: [{ index: 0, id: "call-1",
      function: { name: "private_tool", arguments: '{"secret":' } }] }, "length")])).summaries[0];
    expect(empty).toMatchObject({ deltaToolEntries: 0, beforeNormalization: { toolCall: 0 }, final: { toolCall: 0 } });
    expect(partial).toMatchObject({ deltaToolEntries: 1, beforeNormalization: { toolCall: 1 }, final: { toolCall: 0, stopReason: "length" } });
  });
  it("retains successful tool-call semantics", async () => {
    const result = await runAdapter([chunk({ tool_calls: [{ index: 0, id: "call-1", function: { name: "tool", arguments: "{}" } }] }, "tool_calls")]);
    expect(result.summaries[0].final).toMatchObject({ toolCall: 1, stopReason: "toolUse" });
  });
  it("observes reasoning-only length and message fallback refusal without logging them", async () => {
    const reasoning = (await runAdapter([chunk({ reasoning_text: "hidden" }, "length")])).summaries[0];
    expect(reasoning).toMatchObject({ deltaReasoningChars: 6, final: { thinking: 1 } });
    const fallback = (await runAdapter([{ choices: [{ message: { refusal: "refused", content: null }, finish_reason: "stop" }] }])).summaries[0];
    expect(fallback).toMatchObject({ messageRefusalChars: 7, final: { text: 1 } });
    expect(JSON.stringify([reasoning, fallback])).not.toContain("hidden");
    expect(JSON.stringify([reasoning, fallback])).not.toContain("refused");
  });
  it("distinguishes absent usage from explicit zero including choice fallback", async () => {
    const absent = (await runAdapter([chunk({}, "length")])).summaries[0];
    const zero = (await runAdapter([{ ...chunk({}, "length"), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }])).summaries[0];
    const fallback = (await runAdapter([{ choices: [{ delta: {}, finish_reason: "length", usage: { completion_tokens: 8 } }] }])).summaries[0];
    expect(absent).toMatchObject({ chunkUsageSeen: false, chunkUsage: null, choiceUsage: null });
    expect(zero).toMatchObject({ chunkUsageSeen: true, chunkUsage: { input: 0, output: 0, total: 0, reasoning: null } });
    expect(fallback).toMatchObject({ choiceUsageSeen: true, choiceUsage: { output: 8 } });
  });
  it.each([{ failBefore: true }, { failDuring: true }, { aborted: true }])("finishes once on failure %j", async settings => {
    const result = await runAdapter([], settings);
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0].final.stopReason).toBe(settings.aborted ? "aborted" : "error");
    expect(result.events.at(-1)?.type).toBe("error");
    expect(JSON.stringify(result.summaries)).not.toContain("secret");
  });
  it("does not change a completion when logging throws", async () => {
    const result = await runAdapter([chunk({ content: "ok" })], { throwingWriter: true });
    expect(result.events.at(-1)?.type).toBe("done");
    expect(result.events.at(-1)?.message.content[0].text).toBe("ok");
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

describe("adapter build patch", () => {
  it("applies to the complete pinned source and emits syntactically valid TS", () => {
    expect(compile(patch.patchOpenAIStreamMetadata(fixture)).diagnostics).toEqual([]);
    expect(() => patch.patchOpenAIStreamMetadata(fixture + "\n")).toThrow(/drift/);
    expect(() => patch.patchOpenAIStreamMetadata(patch.patchOpenAIStreamMetadata(fixture))).toThrow(/drift/);
    expect(() => patch.instrumentOpenAIStreamMetadata(fixture.replace("firstEventAbort?.dispose();", ""))).toThrow(/anchor/);
  });
  it("CLI installs the companion and rejects reapplication without changing files", () => {
    const directory = mkdtempSync(join(tmpdir(), "stream-metadata-test-"));
    try {
      const providerDir = join(directory, "packages/ai/src/providers");
      mkdirSync(providerDir, { recursive: true });
      const target = join(providerDir, "openai-completions.ts");
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
