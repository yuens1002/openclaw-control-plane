// Runs shipped code, not copied resolver/transport functions. Network is confined
// to a loopback synthetic SSE server; run Docker with --network none as well.
// Usage: node /checks/test-selected-transport.mjs [/openclaw/dist] [--expect-uninstrumented]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = resolvePath(process.argv[2] ?? '/openclaw/dist');
const expectUninstrumented = process.argv.includes('--expect-uninstrumented');
const candidates = readdirSync(dist).filter(name => name.endsWith('.js')).map(name => ({
  name, source: readFileSync(`${dist}/${name}`, 'utf8'),
})).filter(({ source }) => source.includes('function resolveEmbeddedAgentStreamFn('));
assert.equal(candidates.length, 1, 'Exactly one shipped resolver implementation is required');
const candidate = candidates[0];
const alias = candidate.source.match(/resolveEmbeddedAgentStreamFn as (\w+)/)?.[1];
assert.ok(alias, 'The real bundled resolver must be exported; fail closed if packaging changes');
const resolver = (await import(pathToFileURL(`${dist}/${candidate.name}`)))[alias];
assert.equal(typeof resolver, 'function');
const originalError = console.error;
const previousFlag = process.env.OPENCLAW_STREAM_METADATA_DIAGNOSTICS;
const secretMarker = 'SYNTHETIC_PRIVATE_CONTENT';
const chunk = (delta = {}, finish = null, extra = {}) => ({
  id: 'synthetic-response', model: 'synthetic-model',
  choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
});
const scenarios = [
  { name: 'visible', chunks: [chunk({ content: 'Hello' }, 'stop')], text: 5, blocks: 1, finish: 'stop' },
  { name: 'structured-content', chunks: [chunk({ content: [{ type: 'text', text: secretMarker }] }, 'stop')], arrayEntries: 1, finish: 'stop' },
  { name: 'empty-length', chunks: [chunk({}, 'length')], text: 0, blocks: 0, finish: 'length' },
  { name: 'reasoning-suppressed', chunks: [chunk({ reasoning: secretMarker }, 'length')], reasoning: secretMarker.length, blocks: 0, finish: 'length' },
  { name: 'partial-tool-length', chunks: [chunk({ tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function', function: { name: 'synthetic_tool', arguments: '{"value":' } }] }, 'length')], tool: 1, blocks: 0, finish: 'length' },
  { name: 'usage-absent', chunks: [chunk({}, 'stop')], usage: false, blocks: 0, finish: 'stop' },
  { name: 'usage-zero', chunks: [chunk({}, 'stop', { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })], usage: true, blocks: 0, finish: 'stop' },
  { name: 'eof-no-finish', chunks: [chunk({ content: 'Hello' })], noDone: true, text: 5, blocks: 1, finish: null },
  { name: 'pre-stream-error', status: 400, chunks: [], error: true },
  { name: 'mid-stream-error', chunks: [chunk({ content: 'Hello' })], destroy: true, error: true },
  { name: 'abort', chunks: [chunk({ content: 'Hello' })], abort: true, error: true },
  { name: 'adversarial', chunks: [chunk({ content: secretMarker, refusal: secretMarker }, 'stop', { id: `bad\n${secretMarker}`, model: '<script>secret</script>' })], text: secretMarker.length, blocks: 1, finish: 'stop', adversarial: true },
];

async function runScenario(scenario, { enabled = true, provider = 'openrouter', throwingSink = false, failSetup = false } = {}) {
  const records = [];
  const requests = [];
  const events = [];
  const abort = new AbortController();
  let streamingResponse;
  let server;
  try {
    console.error = (...args) => {
      let record;
      if (typeof args[0] === 'string' && args[0].startsWith('{')) {
        try { record = JSON.parse(args[0]); } catch { /* unrelated stderr */ }
      }
      if (record?.event === 'openai_stream_metadata') {
        records.push(record);
        if (throwingSink) throw new Error(secretMarker);
      } else originalError(...args);
    };
    process.env.OPENCLAW_STREAM_METADATA_DIAGNOSTICS = enabled ? '1' : '0';
    server = createServer(async (request, response) => {
      let body = '';
      for await (const part of request) body += part;
      requests.push({ method: request.method, path: request.url, payload: JSON.parse(body) });
      if (scenario.status) {
        response.writeHead(scenario.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: secretMarker } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const value of scenario.chunks) response.write(`data: ${JSON.stringify(value)}\n\n`);
      if (scenario.destroy || scenario.abort) {
        // Terminate only once the real consumer observes its first text delta.
        streamingResponse = response;
        return;
      }
      response.end(scenario.noDone ? '' : 'data: [DONE]\n\n');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (failSetup) throw new Error('synthetic setup failure');
    const model = {
      id: 'synthetic-model', name: 'Synthetic', api: 'openai-completions', provider,
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: false,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096, maxTokens: 100,
    };
    if (scenario.name === 'visible' && enabled && !throwingSink && provider === 'openrouter') {
      // Unrelated malformed/valid JSON logs must not abort or become diagnostics.
      console.error('{synthetic malformed JSON');
      console.error('{"event":"synthetic_unrelated"}');
    }
    const streamFn = resolver({ sessionId: 'synthetic-session', model, resolvedApiKey: 'synthetic-no-secret', signal: abort.signal });
    const stream = await streamFn(model, { messages: [{ role: 'user', content: secretMarker, timestamp: 0 }] }, {
      maxTokens: 100,
      onPayload: payload => ({ ...payload, max_completion_tokens: 37 }),
    });
    for await (const event of stream) {
      events.push(event.type);
      if (event.type === 'text_delta' && streamingResponse) {
        if (scenario.abort) abort.abort();
        else if (scenario.destroy) streamingResponse.destroy();
      }
    }
    const output = await stream.result();
    // Time is incidental; all remaining final fields and event order must match.
    delete output.timestamp;
    assert.equal(requests.length, 1, `${scenario.name}: no extra request/retry`);
    assert.equal(requests[0].payload.max_completion_tokens, 37, 'Real request includes final payload hook');
    const expectedCount = enabled && provider === 'openrouter' && !expectUninstrumented ? 1 : 0;
    assert.equal(records.length, expectedCount, `${scenario.name}: selected resolver must reach diagnostic exactly once`);
    if (scenario.blocks !== undefined) assert.equal(output.content.length, scenario.blocks, scenario.name);
    if (scenario.error) assert.ok(['error', 'aborted'].includes(output.stopReason), scenario.name);
    if (records[0]) {
      const record = records[0];
      assert.equal(record.request.maxCompletionTokens, 37);
      assert.equal(record.chunkCount, scenario.chunks.length);
      if (scenario.finish !== undefined) assert.equal(record.finishReason, scenario.finish);
      if (scenario.arrayEntries !== undefined) assert.equal(record.deltaContentArrayEntries, scenario.arrayEntries);
      if (scenario.text !== undefined) assert.equal(record.deltaTextChars, scenario.text);
      if (scenario.reasoning !== undefined) {
        assert.equal(record.deltaReasoningChars, scenario.reasoning);
        assert.equal(record.emitReasoning, false);
        assert.equal(record.final.thinking, 0);
      }
      if (scenario.tool) {
        assert.equal(record.deltaToolEntries, 1);
        assert.equal(record.beforeNormalization.toolCall, 1);
        assert.equal(record.final.toolCall, 0);
      }
      if (scenario.usage !== undefined) {
        assert.equal(record.chunkUsageSeen, scenario.usage);
        assert.equal(record.chunkUsage?.total ?? null, scenario.usage ? 0 : null);
      }
      if (scenario.adversarial) {
        assert.equal(record.responseId, null);
        assert.equal(record.responseModel, null);
      }
      assert.ok(!JSON.stringify(record).includes(secretMarker), 'No synthetic private content escapes');
      assert.ok(JSON.stringify(record).length < 4096, 'Bounded diagnostic');
      assert.equal(record.final.stopReason, output.stopReason);
    }
    return { requests, events, output };
  } finally {

    console.error = originalError;
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
  }
}

try {
  for (const scenario of scenarios) {
    const enabled = await runScenario(scenario);
    const disabled = await runScenario(scenario, { enabled: false });
    assert.deepEqual(enabled, disabled, `${scenario.name}: diagnostics must not change requests/events/output`);
    console.log(`PASS ${scenario.name}: real resolver/network; enabled-disabled equivalent`);
  }
  await runScenario(scenarios[0], { provider: 'synthetic-other' });
  await runScenario(scenarios[0], { throwingSink: true });
  await assert.rejects(runScenario(scenarios[0], { failSetup: true }), /synthetic setup failure/);
  assert.equal(console.error, originalError, 'Setup failure restores stderr capture');
  console.log(`PASS ${scenarios.length + 3} cases; shipped resolver ${candidate.name}; ${expectUninstrumented ? 'baseline has no metadata' : 'selected-path diagnostics reached'}`);
} finally {
  console.error = originalError;
  if (previousFlag === undefined) delete process.env.OPENCLAW_STREAM_METADATA_DIAGNOSTICS;
  else process.env.OPENCLAW_STREAM_METADATA_DIAGNOSTICS = previousFlag;
}
