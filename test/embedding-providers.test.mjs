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
