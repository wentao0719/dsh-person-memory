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
  constructor({ endpoint, apiKey, model = 'text-embedding-3-small', dim = 1536, allowExternal = false } = {}) {
    if (allowExternal !== true) throw new Error('external-embedding-disabled');
    if (!endpoint) throw new Error('external-embedding-endpoint-required');
    this.name = `external:${model}`;
    this.dim = dim;
    this.endpoint = String(endpoint);
    this.apiKey = apiKey ? String(apiKey) : '';
    this.model = model;
  }
  async embed(text) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, input: String(text) }),
    });
    if (!response.ok) throw new Error(`embedding-http-${response.status}`);
    const body = await response.json();
    const vector = body?.data?.[0]?.embedding;
    if (!Array.isArray(vector)) throw new Error('embedding-invalid-response');
    return vector;
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
    });
  }
  throw new Error('embedding-provider-unknown');
}
