// Local, deterministic feature-hashing embeddings.
// No network, no model download, no text leaves the machine. This is a
// lexical baseline for hybrid retrieval, not a semantic model.
export const DEFAULT_EMBEDDING_DIM = 256;

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function tokens(text) {
  const value = String(text ?? '').toLowerCase();
  const out = [];
  const words = value.match(/[a-z0-9]{2,}/g) ?? [];
  out.push(...words);
  const cjk = value.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length; i += 1) out.push(cjk[i]);
  for (let i = 0; i + 2 <= cjk.length; i += 1) out.push(cjk.slice(i, i + 2));
  return out;
}

export function embedText(text, dim = DEFAULT_EMBEDDING_DIM) {
  const vector = new Float32Array(dim);
  for (const token of tokens(text)) {
    const hash = fnv1a(token);
    const index = hash % dim;
    const sign = (hash & 0x80000000) ? -1 : 1;
    vector[index] += sign;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i += 1) vector[i] /= norm;
  return Array.from(vector);
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}
