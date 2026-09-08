// Build-time companion to patch-openai-stream-metadata.mjs. No raw payloads
// escape this module: SDK chunks are inspected synchronously, never retained.
type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields =>
  value !== null && typeof value === "object" ? value as Fields : {};
const entries = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const chars = (value: unknown): number => typeof value === "string" ? value.length : 0;
const identifier = (value: unknown): string | null =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(value) ? value : null;
const present = (value: unknown): boolean => value !== null && value !== undefined;
const reason = (value: unknown): string | null => {
  if (!present(value)) return null;
  if (typeof value === "string" && ["stop", "length", "tool_calls", "function_call", "content_filter",
    "toolUse", "error", "aborted"].includes(value)) return value;
  return "other";
};
const usage = (value: unknown) => {
  const reported = fields(value);
  return {
    input: number(reported.prompt_tokens), output: number(reported.completion_tokens),
    total: number(reported.total_tokens),
    reasoning: number(fields(reported.completion_tokens_details).reasoning_tokens),
  };
};
const blocks = (value: unknown) => {
  const content = entries(fields(value).content);
  return {
    text: content.filter(block => fields(block).type === "text").length,
    thinking: content.filter(block => fields(block).type === "thinking").length,
    toolCall: content.filter(block => fields(block).type === "toolCall").length,
    stopReason: reason(fields(value).stopReason),
  };
};

export function createOpenAIStreamMetadata(
  enabled: boolean,
  requestedModel: unknown,
  write: (line: string) => void,
) {
  if (!enabled) return undefined;
  const summary = {
    event: "openai_stream_metadata", schemaVersion: 2,
    emitReasoning: null as boolean | null,
    startedAt: new Date().toISOString(), requestedModel: identifier(requestedModel),
    responseId: null as string | null, responseModel: null as string | null,
    request: null as Fields | null,
    chunkCount: 0, primaryChoiceCount: 0, finishReason: null as string | null,
    chunkUsageSeen: false, choiceUsageSeen: false,
    chunkUsage: null as ReturnType<typeof usage> | null,
    choiceUsage: null as ReturnType<typeof usage> | null,
    deltaTextChars: 0, deltaReasoningChars: 0, deltaRefusalChars: 0,
    deltaContentArrayEntries: 0, messageContentArrayEntries: 0,
    deltaToolEntries: 0, deltaToolArgumentChars: 0,
    messageTextChars: 0, messageToolEntries: 0, messageReasoningChars: 0,
    messageRefusalChars: 0, messageToolArgumentChars: 0,
    reasoningDetailEntries: 0,
    beforeNormalization: null as ReturnType<typeof blocks> | null,
    final: null as ReturnType<typeof blocks> | null,
  };
  let finished = false;
  // Diagnostics must never replace the adapter's result, including on bad
  // SDK objects or a closed stderr sink. No promise is introduced or awaited.
  const observe = (operation: () => void) => { try { operation(); } catch { /* diagnostic only */ } };
  const add = (key: "chunkCount" | "primaryChoiceCount" | "deltaTextChars" |
    "deltaReasoningChars" | "deltaRefusalChars" | "deltaToolEntries" |
    "deltaToolArgumentChars" | "messageTextChars" | "messageToolEntries" |
    "reasoningDetailEntries" | "messageReasoningChars" | "messageRefusalChars" |
    "messageToolArgumentChars" | "deltaContentArrayEntries" | "messageContentArrayEntries", amount: number) => {
    summary[key] = Math.min(Number.MAX_SAFE_INTEGER, summary[key] + amount);
  };
  return {
    context(emitReasoning: boolean) {
      observe(() => { summary.emitReasoning = typeof emitReasoning === "boolean" ? emitReasoning : null; });
    },
    request(payload: unknown) {
      observe(() => {
        const request = fields(payload);
        summary.request = {
          model: identifier(request.model),
          maxTokens: number(request.max_tokens),
          maxCompletionTokens: number(request.max_completion_tokens),
          includeUsage: fields(request.stream_options).include_usage === true,
          messageCount: entries(request.messages).length,
          toolCount: entries(request.tools).length,
        };
      });
    },
    chunk(value: unknown) {
      observe(() => {
        add("chunkCount", 1);
        const chunk = fields(value);
        summary.responseId ??= identifier(chunk.id);
        summary.responseModel ??= identifier(chunk.model);
        if (present(chunk.usage)) {
          summary.chunkUsageSeen = true;
          summary.chunkUsage = usage(chunk.usage);
        }
        const choices = entries(chunk.choices);
        if (choices.length === 0) return;
        add("primaryChoiceCount", 1);
        const choice = fields(choices[0]);
        if (present(choice.finish_reason)) summary.finishReason = reason(choice.finish_reason);
        if (present(choice.usage)) {
          summary.choiceUsageSeen = true;
          summary.choiceUsage = usage(choice.usage);
        }
        const delta = fields(choice.delta);
        const message = fields(choice.message);
        add("deltaTextChars", chars(delta.content));
        add("deltaContentArrayEntries", entries(delta.content).length);
        add("messageContentArrayEntries", entries(message.content).length);
        add("deltaReasoningChars", chars(delta.reasoning_content) + chars(delta.reasoning) + chars(delta.reasoning_text));
        add("deltaRefusalChars", chars(delta.refusal));
        add("reasoningDetailEntries", entries(delta.reasoning_details).length);
        const toolEntries = entries(delta.tool_calls);
        add("deltaToolEntries", toolEntries.length);
        for (const tool of toolEntries) add("deltaToolArgumentChars", chars(fields(fields(tool).function).arguments));
        add("messageTextChars", chars(message.content));
        add("messageToolEntries", entries(message.tool_calls).length);
        add("messageReasoningChars", chars(message.reasoning_content) + chars(message.reasoning) + chars(message.reasoning_text));
        add("messageRefusalChars", chars(message.refusal));
        for (const tool of entries(message.tool_calls)) add("messageToolArgumentChars", chars(fields(fields(tool).function).arguments));
      });
    },
    beforeNormalization(output: unknown) {
      observe(() => { summary.beforeNormalization = blocks(output); });
    },
    finish(output: unknown) {
      if (finished) return;
      finished = true;
      observe(() => {
        summary.final = blocks(output);
        write(JSON.stringify(summary));
      });
    },
  };
}
