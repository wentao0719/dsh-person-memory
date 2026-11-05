#!/usr/bin/env node
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, ensurePerson, remember, recall } from '../lib/core.js';

const k = Number(process.env.EVAL_K || 5);
const minRecall = Number(process.env.EVAL_MIN_RECALL || 0.8);
const fixtures = JSON.parse(readFileSync(new URL('../test/eval-fixtures.json', import.meta.url), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-eval-'));
const db = openStore(join(dir, 'eval.sqlite'));
try {
  for (const person of fixtures.persons) ensurePerson(db, person);
  for (const item of fixtures.items) {
    remember(db, {
      personId: item.person,
      kind: item.kind,
      text: item.text,
      visibility: item.visibility,
      publicAudiences: item.audiences ?? [],
      source: { channel: 'eval' },
    });
  }
  const results = [];
  let hits = 0;
  let scored = 0;
  let leaks = 0;
  for (const query of fixtures.queries) {
    const items = recall(db, {
      personId: query.person,
      audience: query.audience,
      audienceKey: query.audienceKey,
      queryText: query.query,
      limit: k,
    });
    if (query.audience === 'group' && items.some((item) => item.visibility !== 'public')) {
      leaks += 1;
    }
    if (query.expected) {
      scored += 1;
      const hit = items.some((item) => item.text === query.expected);
      if (hit) hits += 1;
      results.push({ query: query.query, audience: query.audience, expected: query.expected, hit, returned: items.map((item) => item.text) });
    } else {
      results.push({ query: query.query, audience: query.audience, expected: null, hit: true, returned: items.map((item) => item.text) });
    }
  }
  const recallAtK = scored ? hits / scored : 1;
  const output = { k, queries: fixtures.queries.length, scored, hits, recallAtK, privacyLeaks: leaks, minRecall, pass: recallAtK >= minRecall && leaks === 0, results };
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = output.pass ? 0 : 1;
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
