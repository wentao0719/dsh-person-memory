import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../lib/core.js';

function makeStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-person-memory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return core.openStore(join(dir, 'memory.sqlite'));
}

test('ensurePerson / resolvePerson via id, alias and external id', (t) => {
  const db = makeStore(t);
  const person = core.ensurePerson(db, {
    id: 'urn:person:qq:162',
    displayName: 'ty',
    aliases: ['小t'],
    externalIds: { qq: '1621861622' },
    timezone: 'Asia/Shanghai',
    relationship: 'friend',
  });
  assert.equal(person.displayName, 'ty');
  assert.deepEqual(core.resolvePerson(db, 'urn:person:qq:162').id, 'urn:person:qq:162');
  assert.deepEqual(core.resolvePerson(db, '小t').id, 'urn:person:qq:162');
  assert.deepEqual(core.resolvePerson(db, '1621861622').id, 'urn:person:qq:162');
  assert.equal(core.resolvePerson(db, 'nobody'), null);
});

test('remember dedupes identical normalized facts', (t) => {
  const db = makeStore(t);
  const first = core.remember(db, { personId: 'p1', text: '她喜欢弹琴', kind: 'preference' });
  assert.equal(first.status, 'created');
  const second = core.remember(db, { personId: 'p1', text: '她 喜欢 弹琴 ', kind: 'preference' });
  assert.equal(second.status, 'already-known');
  assert.equal(core.listItems(db, 'p1').length, 1);
});

test('sensitive content is rejected', (t) => {
  const db = makeStore(t);
  const result = core.remember(db, { personId: 'p1', text: '他的密码是 123456', kind: 'fact' });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'sensitive');
});

test('visibility scoping: private never appears in group context', (t) => {
  const db = makeStore(t);
  core.remember(db, { personId: 'p1', text: '住在温哥华', kind: 'fact', visibility: 'private' });
  core.remember(db, { personId: 'p1', text: '公开：喜欢猫', kind: 'preference', visibility: 'public' });

  const privateCtx = core.recall(db, { personId: 'p1', audience: 'private', queryText: '哪里 猫', limit: 10 });
  assert.equal(privateCtx.length, 2);

  const groupCtx = core.recall(db, { personId: 'p1', audience: 'group', audienceKey: 'g1', queryText: '哪里 猫', limit: 10 });
  assert.equal(groupCtx.length, 1);
  assert.equal(groupCtx[0].text, '公开：喜欢猫');
});

test('publicAudiences limits group visibility to the listed audiences', (t) => {
  const db = makeStore(t);
  core.remember(db, { personId: 'p1', text: '只对 g1 公开', kind: 'fact', visibility: 'public', publicAudiences: ['g1'] });
  assert.equal(core.recall(db, { personId: 'p1', audience: 'group', audienceKey: 'g1' }).length, 1);
  assert.equal(core.recall(db, { personId: 'p1', audience: 'group', audienceKey: 'g2' }).length, 0);
  assert.equal(core.recall(db, { personId: 'p1', audience: 'group', audienceKey: '' }).length, 0);
});

test('explicit supersede marks the old item superseded', (t) => {
  const db = makeStore(t);
  const first = core.remember(db, { personId: 'p1', text: '她住在上海', kind: 'fact' });
  const second = core.remember(db, { personId: 'p1', text: '她住在杭州', kind: 'fact', supersedeId: first.item.id });
  assert.equal(second.status, 'created');
  const items = core.listItems(db, 'p1');
  assert.equal(items.length, 1);
  assert.equal(items[0].text, '她住在杭州');
  const all = core.listItems(db, 'p1', { statuses: ['active', 'superseded'] });
  assert.equal(all.length, 2);
});

test('temporal same-kind fact supersedes older active fact but not core', (t) => {
  const db = makeStore(t);
  const base = Date.now() - 100000;
  core.remember(db, { personId: 'p1', text: '职业：学生', kind: 'fact', validFrom: base, layer: 'core' });
  const newer = core.remember(db, { personId: 'p1', text: '职业：工程师', kind: 'fact', validFrom: Date.now() });
  assert.equal(newer.status, 'created'); // core protected
  assert.equal(core.listItems(db, 'p1').length, 2);

  const base2 = Date.now() - 200000;
  core.remember(db, { personId: 'p2', text: '住在 A 市', kind: 'fact', validFrom: base2 });
  const newer2 = core.remember(db, { personId: 'p2', text: '住在 B 市', kind: 'fact', validFrom: Date.now() });
  assert.equal(newer2.status, 'superseded');
  assert.equal(core.listItems(db, 'p2').length, 1);
  assert.equal(core.listItems(db, 'p2')[0].text, '住在 B 市');
});

test('forget soft-deletes and is audited', (t) => {
  const db = makeStore(t);
  const item = core.remember(db, { personId: 'p1', text: '她喜欢榴莲', kind: 'preference' });
  assert.equal(core.forget(db, { personId: 'p1', id: item.item.id, reason: '她说已经不喜欢了' }), true);
  assert.equal(core.listItems(db, 'p1').length, 0);
  const log = core.auditLog(db, { personId: 'p1' });
  assert.ok(log.some((row) => row.action === 'memory.forgotten'));
});

test('recall ranks by query terms and respects budgets', (t) => {
  const db = makeStore(t);
  core.remember(db, { personId: 'p1', text: '她在学吉他', kind: 'fact', importance: 0.8 });
  core.remember(db, { personId: 'p1', text: '她养了一只猫', kind: 'fact', importance: 0.5 });
  const items = core.recall(db, { personId: 'p1', audience: 'private', queryText: '吉他', limit: 5 });
  assert.equal(items[0].text, '她在学吉他');

  const budget = core.recall(db, { personId: 'p1', audience: 'private', queryText: '吉他 猫', limit: 5, maxChars: 12 });
  assert.ok(budget.length < 2);
});

test('stats and sections', (t) => {
  const db = makeStore(t);
  const person = core.ensurePerson(db, { id: 'p1', displayName: 'ty', timezone: 'Asia/Shanghai', relationship: 'friend' });
  core.remember(db, { personId: 'p1', text: '她喜欢冰奶茶', kind: 'preference', visibility: 'public' });
  const s = core.stats(db);
  assert.equal(s.persons, 1);
  assert.equal(s.activeItems, 1);
  assert.ok(core.profileSection(person).includes('ty'));
  const items = core.recall(db, { personId: 'p1', audience: 'private' });
  assert.ok(core.recallSection(items).includes('她喜欢冰奶茶'));
});

test('openStore is idempotent (migration re-run)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-person-memory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'memory.sqlite');
  core.openStore(path);
  const db = core.openStore(path); // migration re-run must not throw
  core.remember(db, { personId: 'p1', text: '她能跑十公里', kind: 'fact' });
  assert.equal(core.stats(db).activeItems, 1);
});

test('exportPerson returns a complete, self-contained bundle', (t) => {
  const db = makeStore(t);
  const person = core.ensurePerson(db, { id: 'urn:person:qq:9', displayName: 'nine' });
  core.remember(db, { personId: person.id, text: '喜欢茶', kind: 'preference' });
  const bundle = core.exportPerson(db, person.id);
  assert.equal(bundle.format, 'dsh-person-memory-export');
  assert.equal(bundle.person.id, person.id);
  assert.equal(bundle.items.length, 1);
  assert.ok(bundle.audit.length >= 1);
  assert.equal(core.exportPerson(db, 'missing'), null);
});

test('deletePerson removes person, items and audit atomically', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:9', displayName: 'nine' });
  core.remember(db, { personId: 'urn:person:qq:9', text: '喜欢茶' });
  const result = core.deletePerson(db, 'urn:person:qq:9');
  assert.equal(result.deleted, true);
  assert.equal(core.getPerson(db, 'urn:person:qq:9'), null);
  assert.equal(core.listItems(db, 'urn:person:qq:9', { statuses: ['active', 'superseded', 'forgotten'] }).length, 0);
  assert.equal(core.auditLog(db, { personId: 'urn:person:qq:9' }).length, 0);
  assert.equal(core.deletePerson(db, 'urn:person:qq:9').deleted, false);
});

test('fact conflicts supersede by label, preferences do not', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:9', displayName: 'nine' });
  const first = core.remember(db, { personId: 'urn:person:qq:9', kind: 'fact', text: '住在：A' });
  const second = core.remember(db, { personId: 'urn:person:qq:9', kind: 'fact', text: '住在：B' });
  assert.equal(first.status, 'created');
  assert.equal(second.status, 'superseded');
  const active = core.listItems(db, 'urn:person:qq:9');
  assert.deepEqual(active.map((item) => item.text), ['住在：B']);
  const tea = core.remember(db, { personId: 'urn:person:qq:9', kind: 'preference', text: '喜欢：茶' });
  const coffee = core.remember(db, { personId: 'urn:person:qq:9', kind: 'preference', text: '喜欢：咖啡' });
  assert.equal(tea.status, 'created');
  assert.equal(coffee.status, 'created');
});

test('active items are capped per person without touching core', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:9', displayName: 'nine' });
  for (let i = 0; i < 15; i += 1) {
    core.remember(db, { personId: 'urn:person:qq:9', kind: 'fact', text: `标签${i}：值${i}`, maxItemsPerPerson: 10 });
  }
  const active = core.listItems(db, 'urn:person:qq:9');
  assert.equal(active.length, 10);
});

test('recall uses FTS candidates for long queries and falls back for short ones', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:9', displayName: 'nine' });
  core.remember(db, { personId: 'urn:person:qq:9', kind: 'preference', text: '喜欢：手冲咖啡' });
  core.remember(db, { personId: 'urn:person:qq:9', kind: 'fact', text: '住在：温哥华' });
  const long = core.recall(db, { personId: 'urn:person:qq:9', queryText: '手冲咖啡', audience: 'private' });
  assert.equal(long[0].text, '喜欢：手冲咖啡');
  const short = core.recall(db, { personId: 'urn:person:qq:9', queryText: '咖啡', audience: 'private' });
  assert.ok(short.some((item) => item.text === '喜欢：手冲咖啡'));
});
