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

test('local embedding is deterministic and cosine-safe', async (t) => {
  const { embedText, cosine } = await import('../lib/embedding.js');
  const a = embedText('喜欢：手冲咖啡');
  const b = embedText('喜欢：手冲咖啡');
  assert.deepEqual(a, b);
  assert.ok(cosine(a, b) > 0.999);
  assert.equal(a.length, 256);
});

test('as-of recall respects valid_from/valid_until', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:9', displayName: 'nine' });
  const base = Date.now();
  core.remember(db, { personId: 'urn:person:qq:9', kind: 'fact', text: '住在：A', validFrom: base + 10000, validUntil: base + 20000 });
  assert.equal(core.recall(db, { personId: 'urn:person:qq:9', asOf: base }).length, 0);
  assert.equal(core.recall(db, { personId: 'urn:person:qq:9', asOf: base + 15000 }).length, 1);
  assert.equal(core.recall(db, { personId: 'urn:person:qq:9', asOf: base + 25000 }).length, 0);
});

test('relations support as-of and deletion', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:1', displayName: 'A' });
  core.ensurePerson(db, { id: 'urn:person:qq:2', displayName: 'B' });
  const rel = core.upsertRelation(db, { fromPersonId: 'urn:person:qq:1', toPersonId: 'urn:person:qq:2', kind: 'friend', since: 1000 });
  assert.ok(rel);
  assert.equal(core.listRelations(db, 'urn:person:qq:1', { asOf: 500 }).length, 0);
  assert.equal(core.listRelations(db, 'urn:person:qq:1', { asOf: 2000 }).length, 1);
  assert.equal(core.listRelations(db, 'urn:person:qq:2', { asOf: 2000 }).length, 1);
  assert.equal(core.deleteRelation(db, rel.id), true);
  assert.equal(core.listRelations(db, 'urn:person:qq:1', { asOf: 2000 }).length, 0);
});

test('feedback confirms, denies and corrects memories', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:9', displayName: 'nine' });
  const a = core.remember(db, { personId: 'urn:person:qq:9', kind: 'fact', text: '住在：A' });
  assert.equal(core.applyFeedback(db, { personId: 'urn:person:qq:9', itemId: a.item.id, action: 'confirm' }).ok, true);
  assert.equal(core.applyFeedback(db, { personId: 'urn:person:qq:9', itemId: a.item.id, action: 'deny' }).ok, true);
  assert.equal(core.listItems(db, 'urn:person:qq:9').length, 0);
  const b = core.remember(db, { personId: 'urn:person:qq:9', kind: 'fact', text: '住在：B' });
  const fixed = core.applyFeedback(db, { personId: 'urn:person:qq:9', itemId: b.item.id, action: 'correct', text: '住在：C' });
  assert.equal(fixed.ok, true);
  assert.equal(core.listItems(db, 'urn:person:qq:9')[0].text, '住在：C');
});

test('decay lowers old importance; consolidation removes exact duplicates', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:9', displayName: 'nine' });
  const item = core.remember(db, { personId: 'urn:person:qq:9', kind: 'fact', text: '住在：A', importance: 0.8 });
  db.prepare('UPDATE memory_items SET updated_at=? WHERE id=?').run(Date.now() - 200 * 24 * 3600 * 1000, item.item.id);
  const result = core.decayMemory(db, { personId: 'urn:person:qq:9', halfLifeDays: 90 });
  assert.ok(result.changed >= 1);
  assert.ok(core.listItems(db, 'urn:person:qq:9')[0].importance < 0.8);
  db.prepare("INSERT INTO memory_items(person_id,kind,text,normalized_text,confidence,importance,visibility,public_audiences,layer,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?, 'active',?,?)")
    .run('urn:person:qq:9', 'fact', '重复：A', '重复a', 0.7, 0.5, 'private', '[]', 'learned', Date.now(), Date.now());
  db.prepare("INSERT INTO memory_items(person_id,kind,text,normalized_text,confidence,importance,visibility,public_audiences,layer,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?, 'active',?,?)")
    .run('urn:person:qq:9', 'fact', '重复：A', '重复a', 0.7, 0.5, 'private', '[]', 'learned', Date.now(), Date.now());
  assert.equal(core.consolidatePerson(db, { personId: 'urn:person:qq:9' }).merged, 1);
});

test('person merge expands recall, requires consent and is reversible', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:1', displayName: 'A' });
  core.ensurePerson(db, { id: 'urn:person:qq:2', displayName: 'B' });
  core.remember(db, { personId: 'urn:person:qq:2', kind: 'fact', text: '住在：B城' });
  assert.equal(core.mergePersons(db, { primaryPersonId: 'urn:person:qq:1', mergedPersonId: 'urn:person:qq:2' }).ok, false);
  const merged = core.mergePersons(db, { primaryPersonId: 'urn:person:qq:1', mergedPersonId: 'urn:person:qq:2', consent: true });
  assert.equal(merged.ok, true);
  assert.equal(core.recall(db, { personId: 'urn:person:qq:1' }).length, 1);
  assert.equal(core.mergePersons(db, { primaryPersonId: 'urn:person:qq:1', mergedPersonId: 'urn:person:qq:2', consent: true }).ok, false);
  assert.equal(core.revertMerge(db, merged.id).ok, true);
  assert.equal(core.recall(db, { personId: 'urn:person:qq:1' }).length, 0);
});

test('hard delete writes a non-identifying tombstone and exportAll is complete', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:9', displayName: 'nine' });
  core.remember(db, { personId: 'urn:person:qq:9', kind: 'fact', text: '住在：A' });
  const result = core.deletePerson(db, 'urn:person:qq:9');
  assert.equal(result.deleted, true);
  assert.match(result.personHash, /^[a-f0-9]{32}$/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM person_tombstones').get().n, 1);
  const all = core.exportAll(db);
  assert.equal(all.persons.length, 0);
  assert.equal(all.items.length, 0);
  assert.equal(all.tombstones.length, 1);
});

test('pruneAudit removes only old audit rows', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:9', displayName: 'nine' });
  core.remember(db, { personId: 'urn:person:qq:9', kind: 'fact', text: '住在：A' });
  db.prepare('UPDATE memory_audit SET at=?').run(Date.now() - 200 * 24 * 3600 * 1000);
  const result = core.pruneAudit(db, { olderThanDays: 90 });
  assert.ok(result.deleted >= 1);
  assert.equal(core.auditLog(db, { personId: 'urn:person:qq:9' }).length, 0);
});

test('metrics record recall without person text', async (t) => {
  const { metricsSnapshot, resetMetrics } = await import('../lib/metrics.js');
  resetMetrics();
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:9', displayName: 'nine' });
  core.remember(db, { personId: 'urn:person:qq:9', kind: 'fact', text: '住在：A' });
  core.recall(db, { personId: 'urn:person:qq:9', queryText: 'A', audience: 'private' });
  const snap = metricsSnapshot();
  assert.equal(snap.totals.recall, 1);
  assert.ok(snap.recent.some((event) => event.name === 'recall' && event.ms >= 0));
  assert.equal(JSON.stringify(snap).includes('住在'), false);
});

test('recallTrace exposes score, source and visibility', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:9', displayName: 'nine' });
  core.remember(db, { personId: 'urn:person:qq:9', kind: 'fact', text: '住在：A', source: { channel: 'unit' } });
  const trace = core.recallTrace(db, { personId: 'urn:person:qq:9', queryText: 'A', audience: 'private' });
  assert.equal(trace.audience, 'private');
  assert.equal(trace.items[0].text, '住在：A');
  assert.equal(trace.items[0].sourceChannel, 'unit');
  assert.equal(typeof trace.items[0].score, 'number');
});

test('evidence metadata attaches to an item and is exported/deleted with person', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:9', displayName: 'nine' });
  const item = core.remember(db, { personId: 'urn:person:qq:9', kind: 'fact', text: '住在：A' });
  const attached = core.attachEvidence(db, { personId: 'urn:person:qq:9', itemId: item.item.id, kind: 'image', mediaType: 'image/jpeg', sha256: 'a'.repeat(64), size: 123, ref: 'media/abc' });
  assert.equal(attached.ok, true);
  assert.equal(core.listEvidence(db, 'urn:person:qq:9', item.item.id).length, 1);
  assert.equal(core.exportPerson(db, 'urn:person:qq:9').evidence.length, 1);
  assert.equal(core.attachEvidence(db, { personId: 'urn:person:qq:9', itemId: item.item.id, kind: 'nope' }).ok, false);
  core.deletePerson(db, 'urn:person:qq:9');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_evidence').get().n, 0);
});

test('relation candidates only resolve known persons and never auto-write', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:1', displayName: 'A', aliases: ['小A'] });
  core.ensurePerson(db, { id: 'urn:person:qq:2', displayName: 'B' });
  core.ensurePerson(db, { id: 'urn:person:qq:3', displayName: 'C' });
  const out = core.extractRelationCandidates(db, 'A是B的朋友，小A和C是同事，D是B的朋友');
  assert.equal(out.candidates.length, 2);
  assert.deepEqual(out.candidates.map((c) => c.kind).sort(), ['colleague', 'friend']);
  assert.equal(out.unresolved.length, 1);
  assert.equal(core.listRelations(db, 'urn:person:qq:1').length, 0);
});

test('relation graph traverses depth from center', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:1', displayName: 'A' });
  core.ensurePerson(db, { id: 'urn:person:qq:2', displayName: 'B' });
  core.ensurePerson(db, { id: 'urn:person:qq:3', displayName: 'C' });
  core.upsertRelation(db, { fromPersonId: 'urn:person:qq:1', toPersonId: 'urn:person:qq:2', kind: 'friend' });
  core.upsertRelation(db, { fromPersonId: 'urn:person:qq:2', toPersonId: 'urn:person:qq:3', kind: 'colleague' });
  const one = core.relationGraph(db, { centerPersonId: 'urn:person:qq:1', depth: 1 });
  assert.deepEqual(one.nodes.map((n) => n.id).sort(), ['urn:person:qq:1', 'urn:person:qq:2']);
  const two = core.relationGraph(db, { centerPersonId: 'urn:person:qq:1', depth: 2 });
  assert.equal(two.nodes.length, 3);
  assert.equal(two.edges.length, 2);
});

test('pruneEvidence removes only old metadata', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:9', displayName: 'nine' });
  const item = core.remember(db, { personId: 'urn:person:qq:9', kind: 'fact', text: '住在：A' });
  core.attachEvidence(db, { personId: 'urn:person:qq:9', itemId: item.item.id, kind: 'image', ref: 'old' });
  db.prepare('UPDATE memory_evidence SET created_at=?').run(Date.now() - 90 * 24 * 3600 * 1000);
  assert.equal(core.pruneEvidence(db, { olderThanDays: 30 }).deleted, 1);
  assert.equal(core.listEvidence(db, 'urn:person:qq:9').length, 0);
});

test('merge preview token is required when supplied and expires', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:1', displayName: 'A' });
  core.ensurePerson(db, { id: 'urn:person:qq:2', displayName: 'B' });
  const preview = core.previewMerge(db, { primaryPersonId: 'urn:person:qq:1', mergedPersonId: 'urn:person:qq:2' });
  assert.equal(preview.ok, true);
  assert.equal(preview.primaryItems, 0);
  const bad = core.mergePersons(db, { primaryPersonId: 'urn:person:qq:1', mergedPersonId: 'urn:person:qq:2', consent: true, previewToken: 'nope' });
  assert.equal(bad.reason, 'preview-invalid');
  const merged = core.mergePersons(db, { primaryPersonId: 'urn:person:qq:1', mergedPersonId: 'urn:person:qq:2', consent: true, previewToken: preview.token });
  assert.equal(merged.ok, true);
  const again = core.mergePersons(db, { primaryPersonId: 'urn:person:qq:1', mergedPersonId: 'urn:person:qq:2', consent: true, previewToken: preview.token });
  assert.equal(again.ok, false);
});

test('relation candidates can be approved or rejected without auto-write', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:1', displayName: 'A' });
  core.ensurePerson(db, { id: 'urn:person:qq:2', displayName: 'B' });
  db.prepare("INSERT INTO relation_candidates(from_person_id,to_person_id,kind,evidence,source_channel,status,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)")
    .run('urn:person:qq:1', 'urn:person:qq:2', 'friend', 'A是B的朋友', 'test', Date.now(), Date.now());
  const pending = core.listRelationCandidates(db);
  assert.equal(pending.length, 1);
  assert.equal(core.listRelations(db, 'urn:person:qq:1').length, 0);
  assert.equal(core.approveRelationCandidate(db, pending[0].id).ok, true);
  assert.equal(core.listRelations(db, 'urn:person:qq:1').length, 1);
  assert.equal(core.listRelationCandidates(db).length, 0);
});

test('evidence can carry OCR text', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:9', displayName: 'nine' });
  const item = core.remember(db, { personId: 'urn:person:qq:9', kind: 'fact', text: '住在：A' });
  core.attachEvidence(db, { personId: 'urn:person:qq:9', itemId: item.item.id, kind: 'image', ref: 'x', ocrText: 'Hello 2026' });
  assert.equal(core.listEvidence(db, 'urn:person:qq:9')[0].ocr_text, 'Hello 2026');
});

test('evidence candidates require explicit item approval', (t) => {
  const db = makeStore(t);
  core.ensurePerson(db, { id: 'urn:person:qq:9', displayName: 'nine' });
  const item = core.remember(db, { personId: 'urn:person:qq:9', kind: 'fact', text: '住在：A' });
  const q = core.queueEvidenceCandidate(db, { personId: 'urn:person:qq:9', kind: 'image', sha256: 'b'.repeat(64), size: 10, ref: 'x' });
  assert.equal(q.ok, true);
  assert.equal(core.listEvidence(db, 'urn:person:qq:9').length, 0);
  assert.equal(core.approveEvidenceCandidate(db, q.id, { itemId: item.item.id }).ok, true);
  assert.equal(core.listEvidence(db, 'urn:person:qq:9').length, 1);
  assert.equal(core.listEvidenceCandidates(db).length, 0);
});
