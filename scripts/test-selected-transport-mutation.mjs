// Run only in a disposable verification container. Since OpenClaw v2026.9.x the
// selected transport ships in the @openclaw/ai workspace package, which the app
// bundles import through node_modules, so a copied dist cannot redirect it. The
// collector constructor is therefore removed in place and restored afterwards;
// the ordinary harness must reject that mutant.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dist = resolve(process.argv[2] ?? '/openclaw/dist');
const aiDist = realpathSync(join(dist, '..', 'node_modules', '@openclaw', 'ai', 'dist'));
const matches = readdirSync(aiDist).filter(name => /\.m?js$/.test(name)).map(name => ({
  name, source: readFileSync(join(aiDist, name), 'utf8'),
})).filter(({ source }) => source.includes('function createOpenAICompletionsTransportStreamFn('));
assert.equal(matches.length, 1, 'One selected transport bundle must exist');
const { name, source } = matches[0];
const target = join(aiDist, name);
const constructor = /const streamMetadata = createOpenAIStreamMetadata\([\s\S]*?\);/g;
assert.equal([...source.matchAll(constructor)].length, 1, 'Exactly one selected collector constructor');
try {
  writeFileSync(target, source.replace(constructor, 'const streamMetadata = undefined;'));
  const harness = join(dirname(fileURLToPath(import.meta.url)), 'test-selected-transport.mjs');
  const result = spawnSync(process.execPath, [harness, dist], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 1, `Mutant must fail diagnostic assertion, not crash or timeout: ${result.error ?? ''}`);
  assert.match(result.stderr, /visible: selected resolver must reach diagnostic exactly once/);
  assert.match(result.stderr, /0 !== 1/);
  console.log('PASS mutation: removing selected transport collector makes real resolver diagnostic test fail (0 !== 1)');
} finally {
  writeFileSync(target, source);
}
