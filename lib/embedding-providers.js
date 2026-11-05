// Embedding provider registry. Local hash is the only default.
// External providers are disabled unless `allowExternal: true` is explicitly
// present; even then, embed() is the only method that sends text.
import { DEFAULT_EMBEDDING_DIM, embedText } from './embedding.js';

export class HashEmbeddingProvider {
  constructor({ dim = DEFAULT_EMBEDDING_DIM } = {}) {
    this.name = 'hash-local';
    this.dim = dim;
  }
  async embed(text) {
    return embedText(text, this.dim);
  }
}

export class ExternalEmbeddingProvider {
  constructor({
    endpoint, apiKey, model = 'text-embedding-3-small', dim = 1536,
    allowExternal = false, timeoutMs = 15000, cacheTtlMs = 300000,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (allowExternal !== true) throw new Error('external-embedding-disabled');
    if (!endpoint) throw new Error('external-embedding-endpoint-required');
    this.name = `external:${model}`;
    this.dim = dim;
    this.endpoint = String(endpoint);
    this.apiKey = apiKey ? String(apiKey) : '';
    this.model = model;
    this.timeoutMs = Math.max(100, Number(timeoutMs) || 15000);
    this.cacheTtlMs = Math.max(0, Number(cacheTtlMs) || 0);
    this.fetchImpl = fetchImpl;
    this.cache = new Map();
  }
  async embed(text) {
    const input = String(text);
    const cached = this.cache.get(input);
    if (cached && cached.expiresAt > Date.now()) return cached.vector;
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('embedding-timeout'));
      }, this.timeoutMs);
    });
    try {
      const response = await Promise.race([
        this.fetchImpl(this.endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({ model: this.model, input }),
        }),
        timeout,
      ]);
      if (!response.ok) throw new Error(`embedding-http-${response.status}`);
      const body = await response.json();
      const vector = body?.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length !== this.dim) throw new Error('embedding-invalid-response');
      if (this.cacheTtlMs > 0) this.cache.set(input, { vector, expiresAt: Date.now() + this.cacheTtlMs });
      return vector;
    } catch (error) {
      if (error?.name === 'AbortError' || error?.message === 'embedding-timeout') throw new Error('embedding-timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createEmbeddingProvider(config = {}) {
  const provider = String(config.provider || 'hash-local');
  if (provider === 'hash-local') return new HashEmbeddingProvider({ dim: config.dim });
  if (provider === 'openai-compatible') {
    return new ExternalEmbeddingProvider({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      model: config.model,
      dim: config.dim,
      allowExternal: config.allowExternal,
      timeoutMs: config.timeoutMs,
      cacheTtlMs: config.cacheTtlMs,
      fetchImpl: config.fetchImpl,
    });
  }
  throw new Error('embedding-provider-unknown');
}
