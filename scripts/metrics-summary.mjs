#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const path = process.argv[2] || process.env.PERSON_MEMORY_METRICS
  || '/Users/wentaohu/dsh-bootstrap-20261102/state/logs/person-memory-metrics.jsonl';
const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
const rows = lines.map((line) => {
  try { return JSON.parse(line); } catch { return null; }
}).filter(Boolean);
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
const byName = {};
for (const row of rows) {
  const entry = byName[row.name] ??= { count: 0, ms: [] };
  entry.count += 1;
  if (Number.isFinite(row.ms)) entry.ms.push(row.ms);
}
for (const entry of Object.values(byName)) {
  entry.p50 = percentile(entry.ms, 0.5);
  entry.p95 = percentile(entry.ms, 0.95);
  delete entry.ms;
}
console.log(JSON.stringify({ file: path, events: rows.length, byName }, null, 2));
