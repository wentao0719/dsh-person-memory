#!/usr/bin/env node
import { openStore, stats, listItems, getPerson, exportPerson, deletePerson, forget, auditLog, listRelations } from '../lib/core.js';
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
  } else if (cmd === 'relations') {
    console.log(JSON.stringify(listRelations(db, args[1], { asOf: args[2] ? Number(args[2]) : undefined }), null, 2));
  } else if (cmd === 'audit') {
    console.log(JSON.stringify(auditLog(db, { personId: args[1], limit: Number(args[2] || 100) }), null, 2));
  } else {
    console.error('usage: memory-admin.mjs stats|list|show <person>|export <person> [out]|relations <person> [asOfMs]|forget <person> <id>|delete <person> --confirm|audit <person> [limit]');
    process.exit(2);
  }
} finally {
  db.close();
}
