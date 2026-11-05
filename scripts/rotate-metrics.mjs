#!/usr/bin/env node
import { existsSync, renameSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const path = process.argv[2] || process.env.PERSON_MEMORY_METRICS
  || '/Users/wentaohu/dsh-bootstrap-20261102/state/logs/person-memory-metrics.jsonl';
const maxBytes = Number(process.env.METRICS_MAX_BYTES || 5 * 1024 * 1024);
const keep = Math.max(1, Number(process.env.METRICS_KEEP || 5));
if (!existsSync(path)) {
  console.log(JSON.stringify({ rotated: false, reason: 'missing', path }));
  process.exit(0);
}
const size = statSync(path).size;
if (size <= maxBytes) {
  console.log(JSON.stringify({ rotated: false, size, maxBytes, path }));
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = `${path}.${stamp}`;
renameSync(path, target);
const dir = dirname(path);
const prefix = `${basename(path)}.`;
const backups = readdirSync(dir)
  .filter((name) => name.startsWith(prefix))
  .map((name) => join(dir, name))
  .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
while (backups.length > keep) unlinkSync(backups.shift());
console.log(JSON.stringify({ rotated: true, size, target, kept: Math.min(backups.length, keep) }));
