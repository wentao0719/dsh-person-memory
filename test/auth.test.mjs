import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePersonAccess, resolveRecallAudience, resolveStatusPerson } from '../lib/auth.js';

test('person access: no binding rejects', () => {
  assert.equal(resolvePersonAccess(null, 'urn:person:x').ok, false);
  assert.equal(resolvePersonAccess(null, '').reason, 'no-binding');
});

test('person access: bound person only', () => {
  const b = { personId: 'urn:person:qq:1', audience: 'private' };
  assert.deepEqual(resolvePersonAccess(b, ''), { ok: true, personId: 'urn:person:qq:1', binding: b });
  assert.equal(resolvePersonAccess(b, 'urn:person:qq:1').ok, true);
  assert.equal(resolvePersonAccess(b, 'urn:person:qq:2').reason, 'cross-person-denied');
});

test('recall audience is forced to binding', () => {
  const b = { personId: 'urn:person:qq:1', audience: 'group', audienceKey: 'g1' };
  assert.deepEqual(resolveRecallAudience(b, ''), { ok: true, audience: 'group', audienceKey: 'g1' });
  assert.equal(resolveRecallAudience(b, 'private').reason, 'audience-denied');
  const p = { personId: 'urn:person:qq:1', audience: 'private', audienceKey: '' };
  assert.equal(resolveRecallAudience(p, 'group').reason, 'audience-denied');
});

test('status: aggregate only without binding; no cross person', () => {
  assert.deepEqual(resolveStatusPerson(null, ''), { ok: true, personId: '' });
  assert.equal(resolveStatusPerson(null, 'urn:person:x').reason, 'no-binding');
  assert.equal(resolveStatusPerson({ personId: 'a' }, 'b').reason, 'cross-person-denied');
  assert.deepEqual(resolveStatusPerson({ personId: 'a' }, 'a'), { ok: true, personId: 'a' });
});
