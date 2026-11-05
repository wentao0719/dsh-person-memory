#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const path = process.argv[2] || process.env.PERSON_MEMORY_METRICS
  || '/Users/wentaohu/dsh-bootstrap-20261102/state/logs/person-memory-metrics.jsonl';
const p95Limit = Number(process.env.ALERT_P95_MS || 250);
const minEvents = Number(process.env.ALERT_MIN_EVENTS || 20);
const maxErrorRate = Number(process.env.ALERT_MAX_ERROR_RATE || 0.1);

let rows = [];
try {
  rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
} catch {
  rows = [];
}
const values = rows.filter((row) => row.name === 'recall' && Number.isFinite(row.ms)).map((row) => row.ms).sort((a, b) => a - b);
const p95 = values.length ? values[Math.min(values.length - 1, Math.floor(values.length * 0.95))] : null;
const recalls = rows.filter((row) => row.name === 'recall').length;
const failures = rows.filter((row) => row.name === 'remember' && row.status && row.status !== 'created').length;
const writes = rows.filter((row) => row.name === 'remember').length;
const errorRate = writes ? failures / writes : 0;
const violations = [];
if (values.length >= minEvents && p95 > p95Limit) violations.push(`p95 ${p95}ms > ${p95Limit}ms`);
if (writes >= minEvents && errorRate > maxErrorRate) violations.push(`write error rate ${errorRate.toFixed(3)} > ${maxErrorRate}`);
const output = { path, events: rows.length, recalls, p95, p95Limit, minEvents, writes, errorRate, maxErrorRate, pass: violations.length === 0, violations };
console.log(JSON.stringify(output, null, 2));
process.exitCode = output.pass ? 0 : 1;
