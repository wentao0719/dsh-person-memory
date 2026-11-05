import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendDiary, readDiary, listDiary } from '../lib/diary.js';

test('diary appends and reads owner-private markdown', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'diary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = appendDiary({ dir, date: '2026-11-06', title: '安静的一天', mood: '平静', body: '今天没有发生什么。', now: new Date('2026-11-06T12:00:00+09:00') });
  assert.equal(a.ok, true);
  appendDiary({ dir, date: '2026-11-06', title: '晚上', body: '又想起来一点事。', now: new Date('2026-11-06T23:00:00+09:00') });
  const r = readDiary({ dir, date: '2026-11-06' });
  assert.equal(r.ok, true);
  assert.ok(r.content.includes('安静的一天'));
  assert.ok(r.content.includes('又想起来一点事'));
  assert.equal(listDiary({ dir }).length, 1);
  const raw = readFileSync(join(dir, '2026-11-06.md'), 'utf8');
  assert.ok(raw.startsWith('# 2026-11-06'));
});
