import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmbeddingProvider, HashEmbeddingProvider } from '../lib/embedding-providers.js';

test('default provider is local hash and does not touch network', async () => {
  const provider = createEmbeddingProvider();
  assert.equal(provider.name, 'hash-local');
  const vector = await provider.embed('喜欢：咖啡');
  assert.equal(vector.length, 256);
});

test('external provider requires explicit opt-in', () => {
  assert.throws(() => createEmbeddingProvider({ provider: 'openai-compatible', endpoint: 'https://example.invalid/v1/embeddings' }), /external-embedding-disabled/);
  const provider = createEmbeddingProvider({ provider: 'openai-compatible', endpoint: 'https://example.invalid/v1/embeddings', allowExternal: true });
  assert.ok(provider instanceof Object);
});

test('unknown provider is rejected', () => {
  assert.throws(() => createEmbeddingProvider({ provider: 'nope' }), /embedding-provider-unknown/);
});

test('external provider caches and times out', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ data: [{ embedding: new Array(4).fill(0.25) }] }) };
  };
  const provider = createEmbeddingProvider({
    provider: 'openai-compatible', endpoint: 'https://example.invalid/v1/embeddings',
    allowExternal: true, dim: 4, fetchImpl, cacheTtlMs: 60000,
  });
  const a = await provider.embed('same');
  const b = await provider.embed('same');
  assert.deepEqual(a, b);
  assert.equal(calls, 1);

  const slow = createEmbeddingProvider({
    provider: 'openai-compatible', endpoint: 'https://example.invalid/v1/embeddings',
    allowExternal: true, dim: 4, timeoutMs: 100,
    fetchImpl: async () => new Promise((resolve) => setTimeout(resolve, 1000)),
  });
  await assert.rejects(slow.embed('x'), /embedding-timeout/);
});
