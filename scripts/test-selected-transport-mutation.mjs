// Run only in a disposable verification container. Copy dist beside itself so
// relative runtime dependencies remain real, then remove the selected-path
// collector constructor. The ordinary harness must reject this mutant.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dist = resolve(process.argv[2] ?? '/openclaw/dist');
const scratch = mkdtempSync(join(dirname(dist), 'selected-transport-mutation-'));
try {
  cpSync(dist, scratch, { recursive: true });
  const matches = readdirSync(scratch).filter(name => name.endsWith('.js')).map(name => ({
    name, source: readFileSync(join(scratch, name), 'utf8'),
  })).filter(({ source }) => source.includes('function createOpenAICompletionsTransportStreamFn('));
  assert.equal(matches.length, 1, 'One selected transport bundle must exist');
  const { name, source } = matches[0];
  const start = source.indexOf('function createOpenAICompletionsTransportStreamFn(');
  const end = source.indexOf('async function processOpenAICompletionsStream(', start);
  assert.ok(end > start, 'Selected factory boundary must be identifiable');
  const factory = source.slice(start, end);
  const constructor = /const streamMetadata = createOpenAIStreamMetadata\([\s\S]*?\);/g;
  assert.equal([...factory.matchAll(constructor)].length, 1, 'Exactly one selected collector constructor');
  const mutated = factory.replace(constructor, 'const streamMetadata = undefined;');
  writeFileSync(join(scratch, name), source.slice(0, start) + mutated + source.slice(end));
  const harness = join(dirname(fileURLToPath(import.meta.url)), 'test-selected-transport.mjs');
  const result = spawnSync(process.execPath, [harness, scratch], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 1, `Mutant must fail diagnostic assertion, not crash or timeout: ${result.error ?? ''}`);
  assert.match(result.stderr, /visible: selected resolver must reach diagnostic exactly once/);
  assert.match(result.stderr, /0 !== 1/);
  console.log('PASS mutation: removing selected transport collector makes real resolver diagnostic test fail (0 !== 1)');
} finally {
  // mkdtempSync created this exact private directory directly beside dist.
  rmSync(scratch, { recursive: true, force: true });
}
