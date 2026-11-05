#!/usr/bin/env node
import { openStore, stats, listItems, getPerson, exportPerson, deletePerson, forget, auditLog, listRelations, applyFeedback, decayMemory, consolidatePerson, listFeedback, mergePersons, revertMerge, listMerges, exportAll, pruneAudit, recallTrace, attachEvidence, listEvidence, extractRelationCandidates, upsertRelation } from '../lib/core.js';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const cmd = args[0] || 'stats';
const dbPath = process.env.PERSON_MEMORY_DB || '/Users/wentaohu/dsh-bootstrap-20261102/state/person-memory.sqlite';
const db = openStore(dbPath);

try {
  if (cmd === 'stats') {
    console.log(JSON.stringify(stats(db), null, 2));
  } else if (cmd === 'list') {
    const rows = db.prepare(
      "SELECT p.id,p.display_name,COUNT(m.id) AS n FROM persons p LEFT JOIN memory_items m ON m.person_id=p.id AND m.status='active' GROUP BY p.id ORDER BY p.id"
    ).all();
    console.log(JSON.stringify(rows, null, 2));
  } else if (cmd === 'show') {
    const person = getPerson(db, args[1]);
    console.log(JSON.stringify({ person, items: listItems(db, args[1], { statuses: ['active', 'superseded', 'forgotten', 'quarantined', 'pending_review', 'rejected'] }) }, null, 2));
  } else if (cmd === 'export') {
    const bundle = exportPerson(db, args[1]);
    if (!bundle) throw new Error('person not found');
    const out = args[2] || `person-${args[1].replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
    writeFileSync(out, JSON.stringify(bundle, null, 2), { mode: 0o600 });
    console.log(out);
  } else if (cmd === 'forget') {
    const ok = forget(db, { personId: args[1], id: Number(args[2]), reason: 'admin-cli', actor: 'admin-cli' });
    console.log(JSON.stringify({ forgotten: ok }));
  } else if (cmd === 'delete') {
    if (!args.includes('--confirm')) throw new Error('delete requires --confirm');
    console.log(JSON.stringify(deletePerson(db, args[1])));
  } else if (cmd === 'relation-candidates') {
    console.log(JSON.stringify(extractRelationCandidates(db, args.slice(1).join(' ')), null, 2));
  } else if (cmd === 'relation-add') {
    if (!args.includes('--confirm')) throw new Error('relation-add requires --confirm');
    console.log(JSON.stringify(upsertRelation(db, { fromPersonId: args[1], toPersonId: args[2], kind: args[3], evidence: 'admin-cli' })));
  } else if (cmd === 'evidence') {
    console.log(JSON.stringify(listEvidence(db, args[1], args[2] ? Number(args[2]) : null), null, 2));
  } else if (cmd === 'evidence-add') {
    console.log(JSON.stringify(attachEvidence(db, { personId: args[1], itemId: Number(args[2]), kind: args[3], ref: args[4], sha256: args[5] })));
  } else if (cmd === 'trace') {
    console.log(JSON.stringify(recallTrace(db, { personId: args[1], queryText: args[2], audience: args[3] === 'group' ? 'group' : 'private', limit: Number(args[4] || 5) }), null, 2));
  } else if (cmd === 'export-all') {
    const out = args[1] || 'person-memory-export-all.json';
    writeFileSync(out, JSON.stringify(exportAll(db), null, 2), { mode: 0o600 });
    console.log(out);
  } else if (cmd === 'prune-audit') {
    console.log(JSON.stringify(pruneAudit(db, { olderThanDays: Number(args[1] || 90) })));
  } else if (cmd === 'tombstones') {
    console.log(JSON.stringify(db.prepare('SELECT person_hash,deleted_at,reason FROM person_tombstones ORDER BY id').all(), null, 2));
  } else if (cmd === 'merge') {
    if (!args.includes('--confirm')) throw new Error('merge requires --confirm (consent)');
    console.log(JSON.stringify(mergePersons(db, { primaryPersonId: args[1], mergedPersonId: args[2], consent: true, actor: 'admin-cli' })));
  } else if (cmd === 'unmerge') {
    console.log(JSON.stringify(revertMerge(db, Number(args[1]), { actor: 'admin-cli' })));
  } else if (cmd === 'merges') {
    console.log(JSON.stringify(listMerges(db, args[1]), null, 2));
  } else if (cmd === 'feedback') {
    console.log(JSON.stringify(applyFeedback(db, { personId: args[1], itemId: Number(args[2]), action: args[3], text: args[4], actor: 'admin-cli' })));
  } else if (cmd === 'feedback-list') {
    console.log(JSON.stringify(listFeedback(db, args[1], Number(args[2] || 100)), null, 2));
  } else if (cmd === 'decay') {
    console.log(JSON.stringify(decayMemory(db, { personId: args[1], halfLifeDays: Number(args[2] || 90), actor: 'admin-cli' })));
  } else if (cmd === 'consolidate') {
    console.log(JSON.stringify(consolidatePerson(db, { personId: args[1], actor: 'admin-cli' })));
  } else if (cmd === 'relations') {
    console.log(JSON.stringify(listRelations(db, args[1], { asOf: args[2] ? Number(args[2]) : undefined }), null, 2));
  } else if (cmd === 'audit') {
    console.log(JSON.stringify(auditLog(db, { personId: args[1], limit: Number(args[2] || 100) }), null, 2));
  } else {
    console.error('usage: memory-admin.mjs stats|list|show <person>|export <person> [out]|trace <person> <query> [private|group] [k]|relation-candidates <text>|relation-add <from> <to> <kind> --confirm|evidence <person> [item]|evidence-add <person> <item> <kind> <ref> [sha256]|export-all [out]|prune-audit [days]|tombstones|relations <person> [asOfMs]|merge <primary> <merged> --confirm|unmerge <id>|merges <person>|feedback <person> <id> <confirm|deny|irrelevant|correct> [text]|feedback-list <person>|decay <person> [days]|consolidate <person>|forget <person> <id>|delete <person> --confirm|audit <person> [limit]');
    process.exit(2);
  }
} finally {
  db.close();
}
