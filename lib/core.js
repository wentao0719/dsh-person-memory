// dsh-person-memory core
// Framework-free store / admission / retrieval / audit. DSH glue lives in index.js.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_EMBEDDING_DIM, embedText, cosine } from './embedding.js';
import { createHash } from 'node:crypto';
import { recordMetric } from './metrics.js';

export const KINDS = ['profile', 'preference', 'fact', 'relationship', 'episode'];
export const LAYERS = ['core', 'learned', 'mood'];
export const VISIBILITIES = ['private', 'public'];
export const STATUSES = ['active', 'superseded', 'forgotten', 'quarantined', 'pending_review', 'rejected'];

const MAX_ACTIVE_PER_PERSON = Math.max(10, Number(process.env.PERSON_MEMORY_MAX_ITEMS || 500));

const SENSITIVE = /(api[_-]?key|secret|token|passw(or)?d|passwd|access[_-]?key|private[_-]?key|cookie|bearer\s+[a-z0-9._-]{12,}|身份证|银行卡|手机号|密码(?!学)|口令|密钥)/i;

export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

export function sanitizeKind(kind) {
  return KINDS.includes(kind) ? kind : 'fact';
}
export function sanitizeLayer(layer) {
  return LAYERS.includes(layer) ? layer : 'learned';
}
export function sanitizeVisibility(visibility) {
  return VISIBILITIES.includes(visibility) ? visibility : 'private';
}

export function isSensitive(text) {
  return SENSITIVE.test(text);
}

function nowMs() {
  return Date.now();
}

export function openStore(dbPath) {
  const path = String(dbPath || './person-memory.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL');
  } catch {
    // WAL is an optimization; some filesystems do not support it.
  }
  db.exec('PRAGMA busy_timeout = 3000');
  migrate(db);
  backfillEmbeddings(db);
  return db;
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS persons (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      aliases TEXT NOT NULL DEFAULT '[]',
      external_ids TEXT NOT NULL DEFAULT '{}',
      timezone TEXT,
      locale TEXT,
      relationship TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.7,
      importance REAL NOT NULL DEFAULT 0.5,
      visibility TEXT NOT NULL DEFAULT 'private',
      public_audiences TEXT NOT NULL DEFAULT '[]',
      layer TEXT NOT NULL DEFAULT 'learned',
      source_channel TEXT NOT NULL DEFAULT 'manual',
      source_session TEXT,
      source_message TEXT,
      source_audience TEXT,
      evidence TEXT,
      valid_from INTEGER,
      valid_until INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      superseded_by INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS person_tombstones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_hash TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tombstone_at ON person_tombstones(deleted_at);

    CREATE TABLE IF NOT EXISTS person_merges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      primary_person_id TEXT NOT NULL,
      merged_person_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      note TEXT,
      created_at INTEGER NOT NULL,
      reverted_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_pair
      ON person_merges(primary_person_id, merged_person_id);
    CREATE INDEX IF NOT EXISTS idx_merge_status ON person_merges(status);

    CREATE TABLE IF NOT EXISTS memory_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      media_type TEXT,
      sha256 TEXT,
      size INTEGER,
      ref TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_item ON memory_evidence(item_id, created_at);

    CREATE TABLE IF NOT EXISTS memory_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      note TEXT,
      actor TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_item ON memory_feedback(item_id, created_at);

    CREATE TABLE IF NOT EXISTS memory_embeddings (
      item_id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_person_id TEXT NOT NULL,
      to_person_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      since INTEGER,
      until INTEGER,
      confidence REAL NOT NULL DEFAULT 0.7,
      evidence TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_relation_unique
      ON relations(from_person_id, to_person_id, kind);
    CREATE INDEX IF NOT EXISTS idx_relation_from ON relations(from_person_id, status);
    CREATE INDEX IF NOT EXISTS idx_relation_to ON relations(to_person_id, status);

    CREATE TABLE IF NOT EXISTS memory_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      action TEXT NOT NULL,
      person_id TEXT,
      item_id INTEGER,
      detail TEXT,
      actor TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_items_person ON memory_items(person_id, status, id);
    CREATE INDEX IF NOT EXISTS idx_items_visibility ON memory_items(person_id, visibility, status);
    CREATE INDEX IF NOT EXISTS idx_audit_at ON memory_audit(at);
  `);

  // Optional FTS index; core scoring uses LIKE, FTS kept for future embedding/keyword adapters.
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
        text, content='memory_items', content_rowid='id', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
        INSERT INTO memory_items_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
        INSERT INTO memory_items_fts(memory_items_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE OF text ON memory_items BEGIN
        INSERT INTO memory_items_fts(memory_items_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO memory_items_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `);
  } catch {
    // FTS is optional; never break the store.
  }
  try {
    const ftsCount = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_items_fts').get()?.n ?? 0);
    const itemCount = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_items').get()?.n ?? 0);
    if (ftsCount === 0 && itemCount > 0) {
      db.exec("INSERT INTO memory_items_fts(memory_items_fts) VALUES('rebuild')");
    }
  } catch {
    // FTS is optional.
  }
  // Schema version 1 includes visibility + canonical person schema.
  // Future migrations branch on this value instead of re-running DDL blindly.
  db.exec('PRAGMA user_version = 1');
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value ?? fallback);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function rowToPerson(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    aliases: parseJson(row.aliases, []),
    externalIds: parseJson(row.external_ids, {}),
    timezone: row.timezone || undefined,
    locale: row.locale || undefined,
    relationship: row.relationship || undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToItem(row) {
  return {
    id: Number(row.id),
    personId: row.person_id,
    kind: row.kind,
    text: row.text,
    normalizedText: row.normalized_text,
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    visibility: row.visibility,
    publicAudiences: parseJson(row.public_audiences, []),
    layer: row.layer,
    source: {
      channel: row.source_channel,
      sessionId: row.source_session || undefined,
      messageId: row.source_message || undefined,
      audienceKey: row.source_audience || undefined,
    },
    evidence: row.evidence || undefined,
    validFrom: row.valid_from ? Number(row.valid_from) : undefined,
    validUntil: row.valid_until ? Number(row.valid_until) : undefined,
    status: row.status,
    supersededBy: row.superseded_by ? Number(row.superseded_by) : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastUsedAt: row.last_used_at ? Number(row.last_used_at) : undefined,
  };
}

function audit(db, action, { personId, itemId, detail, actor } = {}) {
  db.prepare(
    'INSERT INTO memory_audit(at, action, person_id, item_id, detail, actor) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(nowMs(), action, personId ?? null, itemId ?? null, detail ?? null, actor ?? null);
}

export function ensurePerson(db, person) {
  const id = String(person.id ?? '').trim();
  if (!id) throw new Error('person.id is required');
  const now = nowMs();
  const existing = db.prepare('SELECT * FROM persons WHERE id = ?').get(id);
  if (!existing) {
    db.prepare(
      `INSERT INTO persons(id, display_name, aliases, external_ids, timezone, locale, relationship, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      String(person.displayName || id),
      JSON.stringify(person.aliases ?? []),
      JSON.stringify(person.externalIds ?? {}),
      person.timezone ?? null,
      person.locale ?? null,
      person.relationship ?? null,
      now,
      now,
    );
    audit(db, 'person.created', { personId: id });
  } else {
    const aliases = Array.from(new Set([...(parseJson(existing.aliases, [])), ...(person.aliases ?? [])]));
    const externalIds = { ...parseJson(existing.external_ids, {}), ...(person.externalIds ?? {}) };
    const nextDisplay = String(person.displayName || existing.display_name);
    const nextTimezone = person.timezone ?? existing.timezone ?? null;
    const nextLocale = person.locale ?? existing.locale ?? null;
    const nextRelationship = person.relationship ?? existing.relationship ?? null;
    const changed = nextDisplay !== existing.display_name
      || JSON.stringify(aliases) !== JSON.stringify(parseJson(existing.aliases, []))
      || JSON.stringify(externalIds) !== JSON.stringify(parseJson(existing.external_ids, {}))
      || nextTimezone !== (existing.timezone ?? null)
      || nextLocale !== (existing.locale ?? null)
      || nextRelationship !== (existing.relationship ?? null);
    if (changed) {
      db.prepare(
        `UPDATE persons SET display_name = ?, aliases = ?, external_ids = ?,
         timezone = ?, locale = ?, relationship = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        nextDisplay,
        JSON.stringify(aliases),
        JSON.stringify(externalIds),
        nextTimezone,
        nextLocale,
        nextRelationship,
        now,
        id,
      );
      audit(db, 'person.updated', { personId: id });
    }
  }
  return rowToPerson(db.prepare('SELECT * FROM persons WHERE id = ?').get(id));
}

export function getPerson(db, id) {
  const row = db.prepare('SELECT * FROM persons WHERE id = ?').get(String(id));
  return row ? rowToPerson(row) : null;
}

export function resolvePerson(db, key) {
  const k = String(key ?? '').trim();
  if (!k) return null;
  const direct = db.prepare('SELECT * FROM persons WHERE id = ?').get(k);
  if (direct) return rowToPerson(direct);
  for (const row of db.prepare('SELECT * FROM persons').all()) {
    if (parseJson(row.aliases, []).includes(k)) return rowToPerson(row);
    if (Object.values(parseJson(row.external_ids, {})).includes(k)) return rowToPerson(row);
  }
  return null;
}

function subjectOf(text) {
  const match = String(text ?? '').match(/^([^：:]{1,20})[：:]/);
  return match ? match[1].trim().toLowerCase() : '';
}

function pruneActive(db, personId, limit) {
  const count = Number(db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE person_id=? AND status='active'").get(personId)?.n ?? 0);
  if (count <= limit) return 0;
  const victims = db.prepare(
    "SELECT id FROM memory_items WHERE person_id=? AND status='active' AND layer!='core' ORDER BY importance ASC, updated_at ASC, id ASC LIMIT ?"
  ).all(personId, Math.min(count - limit, 50));
  const now = nowMs();
  for (const row of victims) {
    db.prepare("UPDATE memory_items SET status='forgotten', updated_at=? WHERE id=?").run(now, Number(row.id));
    audit(db, 'memory.pruned', { personId, itemId: Number(row.id), detail: 'capacity' });
  }
  return victims.length;
}

/**
 * Remember one atomic fact. Returns { status, item, reason }.
 * status: created | already-known | superseded | rejected
 */
export function remember(db, options) {
  const personId = String(options.personId ?? '').trim();
  const text = String(options.text ?? '').replace(/\s+/g, ' ').trim();
  if (!personId) return { status: 'rejected', reason: 'person-required' };
  if (!text) return { status: 'rejected', reason: 'text-required' };
  if (text.length > 400) return { status: 'rejected', reason: 'too-long' };
  if (isSensitive(text)) return { status: 'rejected', reason: 'sensitive' };

  const kind = sanitizeKind(options.kind);
  const layer = sanitizeLayer(options.layer);
  const visibility = sanitizeVisibility(options.visibility);
  const publicAudiences = visibility === 'public'
    ? (Array.isArray(options.publicAudiences) ? options.publicAudiences.map(String) : [])
    : [];
  const normalized = normalizeText(text);
  const confidence = Math.min(1, Math.max(0, Number(options.confidence ?? 0.7)));
  const importance = Math.min(1, Math.max(0, Number(options.importance ?? 0.5)));
  const now = nowMs();
  const source = options.source ?? {};

  const existing = db.prepare(
    "SELECT * FROM memory_items WHERE person_id = ? AND kind = ? AND normalized_text = ? AND status = 'active' LIMIT 1"
  ).get(personId, kind, normalized);
  if (existing) {
    db.prepare('UPDATE memory_items SET updated_at = ?, last_used_at = ? WHERE id = ?').run(now, now, existing.id);
    audit(db, 'memory.already-known', { personId, itemId: existing.id });
    return { status: 'already-known', item: rowToItem(db.prepare('SELECT * FROM memory_items WHERE id = ?').get(existing.id)) };
  }

  let supersededId = null;
  if (Number.isInteger(options.supersedeId)) {
    const old = db.prepare("SELECT * FROM memory_items WHERE id = ? AND person_id = ? AND status = 'active'").get(options.supersedeId, personId);
    if (old) supersededId = Number(old.id);
  }

  const insert = db.prepare(
    `INSERT INTO memory_items(
      person_id, kind, text, normalized_text, confidence, importance, visibility, public_audiences,
      layer, source_channel, source_session, source_message, source_audience, evidence,
      valid_from, valid_until, status, created_at, updated_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  );
  const result = insert.run(
    personId, kind, text, normalized, confidence, importance, visibility, JSON.stringify(publicAudiences),
    layer,
    String(source.channel ?? 'manual'),
    source.sessionId ? String(source.sessionId) : null,
    source.messageId ? String(source.messageId) : null,
    source.audienceKey ? String(source.audienceKey) : null,
    options.evidence ? String(options.evidence).slice(0, 1000) : null,
    options.validFrom ? Number(options.validFrom) : null,
    options.validUntil ? Number(options.validUntil) : null,
    now, now, now,
  );
  const itemId = Number(result.lastInsertRowid);
  saveEmbedding(db, itemId, text);

  if (supersededId) {
    db.prepare("UPDATE memory_items SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(itemId, now, supersededId);
    audit(db, 'memory.superseded', { personId, itemId: supersededId, detail: `superseded-by:${itemId}` });
  } else if (kind === 'fact') {
    // A newer fact with the same label (e.g. 住在：A -> 住在：B) wins by default.
    // Preferences are not mutually exclusive, so they are excluded.
    const subject = subjectOf(text);
    if (subject) {
      const candidates = db.prepare(
        "SELECT * FROM memory_items WHERE person_id=? AND kind='fact' AND status='active' AND layer!='core' AND id!=?"
      ).all(personId, itemId);
      const stale = candidates.find((row) => subjectOf(row.text) === subject);
      if (stale) {
        db.prepare("UPDATE memory_items SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(itemId, now, Number(stale.id));
        audit(db, 'memory.superseded', { personId, itemId: Number(stale.id), detail: `superseded-by:${itemId}` });
        return { status: 'superseded', item: rowToItem(db.prepare('SELECT * FROM memory_items WHERE id = ?').get(itemId)) };
      }
    }
    // Explicit temporal updates keep the old validFrom contract.
    if (options.validFrom) {
      const stale = db.prepare(
        "SELECT * FROM memory_items WHERE person_id = ? AND kind = ? AND status = 'active' AND layer != 'core' AND id != ? AND valid_from IS NOT NULL AND valid_from < ? ORDER BY valid_from DESC LIMIT 1"
      ).get(personId, kind, itemId, Number(options.validFrom));
      if (stale) {
        db.prepare("UPDATE memory_items SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(itemId, now, Number(stale.id));
        audit(db, 'memory.superseded', { personId, itemId: Number(stale.id), detail: `superseded-by:${itemId}` });
        return { status: 'superseded', item: rowToItem(db.prepare('SELECT * FROM memory_items WHERE id = ?').get(itemId)) };
      }
    }
  }
  const maxItems = Math.max(10, Number(options.maxItemsPerPerson ?? MAX_ACTIVE_PER_PERSON));
  pruneActive(db, personId, maxItems);

  audit(db, 'memory.created', { personId, itemId });
  recordMetric('remember', { status: 'created' });
  return { status: 'created', item: rowToItem(db.prepare('SELECT * FROM memory_items WHERE id = ?').get(itemId)) };
}

export function forget(db, { personId, id, actor, reason }) {
  const row = db.prepare("SELECT * FROM memory_items WHERE id = ? AND person_id = ? AND status = 'active'").get(Number(id), String(personId));
  if (!row) return false;
  db.prepare("UPDATE memory_items SET status = 'forgotten', updated_at = ? WHERE id = ?").run(nowMs(), Number(id));
  audit(db, 'memory.forgotten', { personId, itemId: Number(id), detail: reason ? String(reason).slice(0, 200) : null, actor: actor ? String(actor) : null });
  return true;
}

export function applyFeedback(db, { personId, itemId, action, note, text, actor } = {}) {
  const pid = String(personId ?? '');
  const id = Number(itemId);
  const kind = String(action ?? '').toLowerCase();
  const row = db.prepare("SELECT * FROM memory_items WHERE id=? AND person_id=? AND status='active'").get(id, pid);
  if (!row) return { ok: false, reason: 'not-found' };
  const now = nowMs();
  const cleanNote = note ? String(note).slice(0, 300) : null;
  if (kind === 'confirm') {
    db.prepare('UPDATE memory_items SET confidence=MIN(1,confidence+0.1), importance=MIN(1,importance+0.05), last_used_at=?, updated_at=? WHERE id=?').run(now, now, id);
    db.prepare('INSERT INTO memory_feedback(person_id,item_id,action,note,actor,created_at) VALUES(?,?,?,?,?,?)').run(pid, id, kind, cleanNote, actor ? String(actor) : null, now);
    audit(db, 'memory.confirmed', { personId: pid, itemId: id, detail: cleanNote, actor });
    return { ok: true, status: 'confirmed' };
  }
  if (kind === 'deny' || kind === 'reject') {
    db.prepare("UPDATE memory_items SET status='rejected', updated_at=? WHERE id=?").run(now, id);
    db.prepare('INSERT INTO memory_feedback(person_id,item_id,action,note,actor,created_at) VALUES(?,?,?,?,?,?)').run(pid, id, 'deny', cleanNote, actor ? String(actor) : null, now);
    audit(db, 'memory.rejected', { personId: pid, itemId: id, detail: cleanNote, actor });
    return { ok: true, status: 'rejected' };
  }
  if (kind === 'irrelevant') {
    db.prepare('UPDATE memory_items SET importance=MAX(0,importance-0.1), updated_at=? WHERE id=?').run(now, id);
    db.prepare('INSERT INTO memory_feedback(person_id,item_id,action,note,actor,created_at) VALUES(?,?,?,?,?,?)').run(pid, id, kind, cleanNote, actor ? String(actor) : null, now);
    audit(db, 'memory.irrelevant', { personId: pid, itemId: id, detail: cleanNote, actor });
    return { ok: true, status: 'irrelevant' };
  }
  if (kind === 'correct') {
    const replacement = String(text ?? '').trim();
    if (!replacement) return { ok: false, reason: 'text-required' };
    const result = remember(db, {
      personId: pid, kind: row.kind, text: replacement,
      confidence: Math.min(1, Number(row.confidence) + 0.1),
      importance: Number(row.importance), supersedeId: id,
      source: { channel: 'feedback', audienceKey: 'private' },
      evidence: cleanNote,
    });
    if (result.status === 'rejected') return { ok: false, reason: result.reason };
    db.prepare('INSERT INTO memory_feedback(person_id,item_id,action,note,actor,created_at) VALUES(?,?,?,?,?,?)').run(pid, id, kind, cleanNote, actor ? String(actor) : null, now);
    audit(db, 'memory.corrected', { personId: pid, itemId: id, detail: cleanNote, actor });
    return { ok: true, status: 'corrected', item: result.item };
  }
  return { ok: false, reason: 'unknown-action' };
}

export function decayMemory(db, { personId, halfLifeDays = 90, floor = 0.05, actor = 'decay' } = {}) {
  const pid = String(personId ?? '');
  const halfLife = Math.max(1, Number(halfLifeDays)) * 24 * 3600 * 1000;
  const now = nowMs();
  const rows = db.prepare("SELECT id,importance,updated_at FROM memory_items WHERE person_id=? AND status='active' AND layer!='core'").all(pid);
  let changed = 0;
  for (const row of rows) {
    const age = Math.max(0, now - Number(row.updated_at || now));
    const next = Math.max(Number(floor), Number(row.importance) * Math.exp(-age / halfLife));
    if (Math.abs(next - Number(row.importance)) > 0.001) {
      db.prepare('UPDATE memory_items SET importance=?, updated_at=? WHERE id=?').run(next, now, Number(row.id));
      changed += 1;
    }
  }
  if (changed) audit(db, 'memory.decayed', { personId: pid, detail: `items:${changed}`, actor });
  return { changed };
}

export function consolidatePerson(db, { personId, actor = 'consolidation' } = {}) {
  const pid = String(personId ?? '');
  const rows = db.prepare("SELECT * FROM memory_items WHERE person_id=? AND status='active' ORDER BY importance DESC, id DESC").all(pid);
  const seen = new Map();
  let merged = 0;
  for (const row of rows) {
    const key = String(row.normalized_text);
    if (!seen.has(key)) {
      seen.set(key, row);
      continue;
    }
    const keep = seen.get(key);
    db.prepare("UPDATE memory_items SET status='forgotten', updated_at=? WHERE id=?").run(nowMs(), Number(row.id));
    audit(db, 'memory.consolidated', { personId: pid, itemId: Number(row.id), detail: `duplicate-of:${keep.id}`, actor });
    merged += 1;
  }
  return { merged };
}

export function attachEvidence(db, { personId, itemId, kind, mediaType, sha256, size, ref } = {}) {
  const pid = String(personId ?? '');
  const id = Number(itemId);
  const item = db.prepare('SELECT * FROM memory_items WHERE id=? AND person_id=?').get(id, pid);
  if (!item) return { ok: false, reason: 'item-not-found' };
  const type = String(kind ?? '').toLowerCase();
  if (!['image', 'audio', 'file', 'video'].includes(type)) return { ok: false, reason: 'kind-invalid' };
  const hash = String(sha256 ?? '').toLowerCase();
  if (hash && !/^[a-f0-9]{64}$/.test(hash)) return { ok: false, reason: 'sha256-invalid' };
  const now = nowMs();
  const cur = db.prepare(
    'INSERT INTO memory_evidence(person_id,item_id,kind,media_type,sha256,size,ref,created_at) VALUES(?,?,?,?,?,?,?,?)'
  ).run(pid, id, type, mediaType ? String(mediaType).slice(0, 100) : null, hash || null, size ? Number(size) : null, ref ? String(ref).slice(0, 1000) : null, now);
  audit(db, 'evidence.attached', { personId: pid, itemId: id, detail: type });
  return { ok: true, id: Number(cur.lastInsertRowid) };
}

export function listEvidence(db, personId, itemId = null) {
  if (itemId !== null && itemId !== undefined) {
    return db.prepare('SELECT * FROM memory_evidence WHERE person_id=? AND item_id=? ORDER BY id DESC').all(String(personId ?? ''), Number(itemId));
  }
  return db.prepare('SELECT * FROM memory_evidence WHERE person_id=? ORDER BY id DESC').all(String(personId ?? ''));
}

export function listFeedback(db, personId, limit = 100) {
  return db.prepare(
    'SELECT * FROM memory_feedback WHERE person_id=? ORDER BY id DESC LIMIT ?'
  ).all(String(personId ?? ''), Math.max(1, Number(limit) || 100));
}

export function resolveMergedPersonIds(db, personId) {
  const primary = String(personId ?? '');
  if (!primary) return [];
  const rows = db.prepare(
    "SELECT merged_person_id FROM person_merges WHERE primary_person_id=? AND status='active'"
  ).all(primary);
  return [primary, ...rows.map((row) => String(row.merged_person_id))];
}

export function listMerges(db, personId) {
  const id = String(personId ?? '');
  return db.prepare(
    "SELECT * FROM person_merges WHERE status='active' AND (primary_person_id=? OR merged_person_id=?) ORDER BY id DESC"
  ).all(id, id);
}

export function mergePersons(db, { primaryPersonId, mergedPersonId, consent, note, actor } = {}) {
  const primary = String(primaryPersonId ?? '').trim();
  const merged = String(mergedPersonId ?? '').trim();
  if (consent !== true) return { ok: false, reason: 'consent-required' };
  if (!primary || !merged || primary === merged) return { ok: false, reason: 'invalid-ids' };
  if (!getPerson(db, primary) || !getPerson(db, merged)) return { ok: false, reason: 'person-not-found' };
  const existing = db.prepare(
    "SELECT * FROM person_merges WHERE status='active' AND (primary_person_id IN (?,?) OR merged_person_id IN (?,?))"
  ).get(primary, merged, primary, merged);
  if (existing) return { ok: false, reason: 'depth-1-only' };
  const now = nowMs();
  const cur = db.prepare(
    "INSERT INTO person_merges(primary_person_id,merged_person_id,status,note,created_at) VALUES(?,?, 'active',?,?)"
  ).run(primary, merged, note ? String(note).slice(0, 300) : null, now);
  audit(db, 'person.merged', { personId: primary, detail: `merged:${merged}`, actor });
  return { ok: true, id: Number(cur.lastInsertRowid) };
}

export function revertMerge(db, mergeId, { actor } = {}) {
  const row = db.prepare("SELECT * FROM person_merges WHERE id=? AND status='active'").get(Number(mergeId));
  if (!row) return { ok: false, reason: 'not-found' };
  db.prepare("UPDATE person_merges SET status='reverted', reverted_at=? WHERE id=?").run(nowMs(), Number(mergeId));
  audit(db, 'person.merge-reverted', { personId: row.primary_person_id, detail: `merge:${mergeId}`, actor });
  return { ok: true };
}

export function listItems(db, personId, { statuses = ['active'] } = {}) {
  const placeholders = statuses.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM memory_items WHERE person_id = ? AND status IN (${placeholders}) ORDER BY importance DESC, id DESC`
  ).all(String(personId), ...statuses);
  return rows.map(rowToItem);
}

function tokenize(query) {
  const q = String(query ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!q) return [];
  const tokens = new Set();
  for (const word of q.split(' ')) {
    if (/^[a-z0-9]+$/.test(word) && word.length >= 2) tokens.add(word);
  }
  // CJK bigrams and whole short strings
  const cjk = q.replace(/[^\u4e00-\u9fff]/g, '');
  if (cjk.length === 1) tokens.add(cjk);
  for (let i = 0; i + 2 <= cjk.length; i += 1) tokens.add(cjk.slice(i, i + 2));
  return [...tokens];
}

function decay(now, ts, halfLifeMs) {
  if (!ts) return 0;
  const age = Math.max(0, now - ts);
  return Math.exp(-age / halfLifeMs);
}

function scoreItem(item, tokens, now) {
  let matches = 0;
  if (tokens.length) {
    for (const token of tokens) {
      if (item.normalizedText.includes(token)) matches += 1;
    }
  }
  return (
    matches * 2
    + item.importance * 4
    + decay(now, item.updatedAt, 30 * 24 * 3600 * 1000) * 2
    + decay(now, item.lastUsedAt, 7 * 24 * 3600 * 1000) * 1.5
  );
}

function visibleIn(item, ctx) {
  if (item.status !== 'active') return false;
  const at = Number.isFinite(Number(ctx.asOf)) ? Number(ctx.asOf) : nowMs();
  if (item.validFrom && item.validFrom > at) return false;
  if (item.validUntil && item.validUntil <= at) return false;
  if (ctx.audience === 'group') {
    if (item.visibility !== 'public') return false;
    const audiences = item.publicAudiences ?? [];
    if (audiences.length && !audiences.includes(String(ctx.audienceKey ?? ''))) return false;
    return true;
  }
  return true; // private context for that person
}

function candidateIdsForQuery(db, queryText) {
  const query = String(queryText ?? '').trim();
  if (query.length < 3) return null;
  try {
    const phrase = query.replace(/"/g, '""');
    const rows = db.prepare(
      'SELECT rowid FROM memory_items_fts WHERE memory_items_fts MATCH ? LIMIT 200'
    ).all(`"${phrase}"`);
    if (!rows.length) return null;
    return new Set(rows.map((row) => Number(row.rowid)));
  } catch {
    return null;
  }
}

function embeddingFor(db, item) {
  try {
    const row = db.prepare('SELECT vector FROM memory_embeddings WHERE item_id=?').get(Number(item.id));
    if (row?.vector) return JSON.parse(row.vector);
  } catch {}
  const vector = embedText(item.text, DEFAULT_EMBEDDING_DIM);
  try {
    db.prepare(
      'INSERT OR REPLACE INTO memory_embeddings(item_id,provider,dim,vector,created_at) VALUES(?,?,?,?,?)'
    ).run(Number(item.id), 'hash-local', DEFAULT_EMBEDDING_DIM, JSON.stringify(vector), nowMs());
  } catch {}
  return vector;
}

function saveEmbedding(db, itemId, text) {
  try {
    const vector = embedText(text, DEFAULT_EMBEDDING_DIM);
    db.prepare(
      'INSERT OR REPLACE INTO memory_embeddings(item_id,provider,dim,vector,created_at) VALUES(?,?,?,?,?)'
    ).run(Number(itemId), 'hash-local', DEFAULT_EMBEDDING_DIM, JSON.stringify(vector), nowMs());
  } catch {}
}

function backfillEmbeddings(db) {
  try {
    const rows = db.prepare(
      'SELECT id,text FROM memory_items WHERE status=\'active\' AND id NOT IN (SELECT item_id FROM memory_embeddings) LIMIT 500'
    ).all();
    for (const row of rows) saveEmbedding(db, Number(row.id), String(row.text));
  } catch {}
}

/**
 * Recall top-k items for a context.
 * ctx: { personId, audience: 'private'|'group', audienceKey?, queryText?, limit?, maxChars? }
 */
export function recall(db, ctx) {
  const personId = String(ctx.personId ?? '');
  if (!personId) return [];
  const startedAt = performance.now();
  const personIds = resolveMergedPersonIds(db, personId);
  const candidates = candidateIdsForQuery(db, ctx.queryText);
  let items;
  if (candidates && candidates.size) {
    const idPlaceholders = personIds.map(() => '?').join(',');
    const placeholders = [...candidates].map(() => '?').join(',');
    items = db.prepare(
      `SELECT * FROM memory_items WHERE person_id IN (${idPlaceholders}) AND status='active' AND id IN (${placeholders})`
    ).all(...personIds, ...candidates).map(rowToItem);
  } else {
    const idPlaceholders = personIds.map(() => '?').join(',');
    items = db.prepare(
      `SELECT * FROM memory_items WHERE person_id IN (${idPlaceholders}) AND status='active'`
    ).all(...personIds).map(rowToItem);
  }
  items = items.filter((item) => visibleIn(item, ctx));
  if (!items.length) return [];
  const tokens = tokenize(ctx.queryText);
  const now = nowMs();
  const queryVector = embedText(ctx.queryText ?? '', DEFAULT_EMBEDDING_DIM);
  const keywordOrder = items
    .map((item) => ({ item, score: scoreItem(item, tokens, now) }))
    .sort((a, b) => b.score - a.score);
  const vectorOrder = items
    .map((item) => ({ item, score: cosine(queryVector, embeddingFor(db, item)) }))
    .sort((a, b) => b.score - a.score);
  const rank = new Map();
  const k = 60;
  keywordOrder.forEach(({ item }, index) => {
    rank.set(Number(item.id), 1 / (k + index + 1));
  });
  vectorOrder.forEach(({ item }, index) => {
    rank.set(Number(item.id), (rank.get(Number(item.id)) ?? 0) + 1 / (k + index + 1));
  });
  const scored = items
    .map((item) => ({ item, score: rank.get(Number(item.id)) ?? 0 }))
    .sort((a, b) => b.score - a.score);
  const limit = Math.max(1, Number(ctx.limit ?? 5));
  const maxChars = Math.max(1, Number(ctx.maxChars ?? 600));
  const selected = [];
  let chars = 0;
  for (const { item, score } of scored) {
    if (selected.length >= limit) break;
    const line = `[${item.kind}] ${item.text}`;
    if (chars + line.length > maxChars && selected.length) break;
    selected.push({ ...item, score });
    chars += line.length;
  }
  if (selected.length) {
    const ids = selected.map((item) => Number(item.id));
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE memory_items SET last_used_at = ? WHERE id IN (${placeholders})`).run(now, ...ids);
  }
  recordMetric('recall', {
    ms: Math.round((performance.now() - startedAt) * 1000) / 1000,
    candidates: items.length,
    returned: selected.length,
    vectors: items.length,
  });
  return selected;
}

export function recallTrace(db, ctx) {
  const items = recall(db, ctx);
  return {
    query: String(ctx.queryText ?? ''),
    audience: ctx.audience === 'group' ? 'group' : 'private',
    audienceKey: ctx.audienceKey ? String(ctx.audienceKey) : undefined,
    asOf: ctx.asOf ?? null,
    items: items.map((item) => ({
      id: item.id,
      kind: item.kind,
      text: item.text,
      score: item.score,
      visibility: item.visibility,
      confidence: item.confidence,
      importance: item.importance,
      sourceChannel: item.source.channel,
      evidence: item.evidence,
      validFrom: item.validFrom,
      validUntil: item.validUntil,
    })),
  };
}

export function profileSection(person) {
  if (!person) return '';
  const parts = [`${person.displayName || person.id}`];
  if (person.timezone) parts.push(`时区：${person.timezone}`);
  if (person.relationship) parts.push(`关系：${person.relationship}`);
  if (person.locale) parts.push(`语言：${person.locale}`);
  return `【人物资料】${parts.join('；')}`;
}

export function recallSection(items) {
  if (!items.length) return '';
  const lines = items.map((item) => {
    const when = item.validFrom ? `（${new Date(item.validFrom).toISOString().slice(0, 10)} 起）` : '';
    return `[${item.kind}] ${item.text}${when}`;
  });
  return `【相关人物记忆】\n${lines.join('\n')}`;
}

export function stats(db) {
  const persons = db.prepare('SELECT COUNT(*) AS n FROM persons').get().n;
  const items = db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE status = 'active'").get().n;
  const byVisibility = db.prepare(
    "SELECT visibility, COUNT(*) AS n FROM memory_items WHERE status = 'active' GROUP BY visibility"
  ).all();
  return { persons, activeItems: items, byVisibility };
}

const RELATION_WORDS = {
  '朋友': 'friend', '好友': 'friend', '伴侣': 'partner', '对象': 'partner',
  '女朋友': 'partner', '男朋友': 'partner', '同事': 'colleague',
  '同学': 'classmate', '家人': 'family', '室友': 'roommate',
};

export function extractRelationCandidates(db, text) {
  const value = String(text ?? '').trim();
  if (!value) return { candidates: [], unresolved: [] };
  const persons = db.prepare('SELECT * FROM persons').all();
  const byName = new Map();
  for (const person of persons) {
    const names = [person.display_name, ...parseJson(person.aliases, [])];
    for (const name of names) {
      const key = String(name ?? '').trim();
      if (key) byName.set(key, person.id);
    }
  }
  const patterns = [
    /([^\s，。,.!?！？]{1,20})是([^\s，。,.!?！？]{1,20})的(朋友|好友|伴侣|对象|女朋友|男朋友|同事|同学|家人|室友)/g,
    /([^\s，。,.!?！？]{1,20})和([^\s，。,.!?！？]{1,20})是(朋友|好友|伴侣|对象|女朋友|男朋友|同事|同学|家人|室友)/g,
  ];
  const seen = new Set();
  const candidates = [];
  const unresolved = [];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const left = String(match[1]).trim();
      const right = String(match[2]).trim();
      const kind = RELATION_WORDS[match[3]];
      if (!kind) continue;
      const from = byName.get(left);
      const to = byName.get(right);
      if (!from || !to || from === to) {
        if (!from || !to) unresolved.push({ left, right, kind });
        continue;
      }
      const key = `${from}|${to}|${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ from, to, kind, evidence: match[0].slice(0, 200) });
    }
  }
  return { candidates, unresolved };
}

export function upsertRelation(db, options) {
  const from = String(options.fromPersonId ?? '').trim();
  const to = String(options.toPersonId ?? '').trim();
  const kind = String(options.kind ?? 'friend').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  if (!from || !to || !kind || from === to) return null;
  if (!getPerson(db, from) || !getPerson(db, to)) return null;
  const since = options.since ? Number(options.since) : null;
  const until = options.until ? Number(options.until) : null;
  if (since && until && until <= since) return null;
  const now = nowMs();
  db.prepare(
    `INSERT INTO relations(from_person_id,to_person_id,kind,since,until,confidence,evidence,status,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?, 'active', ?, ?)
     ON CONFLICT(from_person_id,to_person_id,kind) DO UPDATE SET
       since=excluded.since, until=excluded.until, confidence=excluded.confidence,
       evidence=excluded.evidence, status='active', updated_at=excluded.updated_at`
  ).run(from, to, kind, since, until, Math.min(1, Math.max(0, Number(options.confidence ?? 0.7))), options.evidence ? String(options.evidence).slice(0, 1000) : null, now, now);
  audit(db, 'relation.upserted', { personId: from, detail: `${kind}->${to}` });
  return db.prepare('SELECT * FROM relations WHERE from_person_id=? AND to_person_id=? AND kind=?').get(from, to, kind);
}

export function listRelations(db, personId, { asOf, direction = 'both' } = {}) {
  const at = Number.isFinite(Number(asOf)) ? Number(asOf) : nowMs();
  const person = String(personId ?? '');
  if (!person) return [];
  let where = '(r.from_person_id=? OR r.to_person_id=?)';
  if (direction === 'out') where = 'r.from_person_id=?';
  if (direction === 'in') where = 'r.to_person_id=?';
  const params = direction === 'out' || direction === 'in'
    ? [person, at, at]
    : [person, person, at, at];
  return db.prepare(
    `SELECT r.*, pf.display_name AS from_name, pt.display_name AS to_name
     FROM relations r
     LEFT JOIN persons pf ON pf.id=r.from_person_id
     LEFT JOIN persons pt ON pt.id=r.to_person_id
     WHERE ${where} AND r.status='active'
       AND (r.since IS NULL OR r.since <= ?)
       AND (r.until IS NULL OR r.until > ?)
     ORDER BY r.updated_at DESC, r.id DESC`
  ).all(...params);
}

export function deleteRelation(db, id) {
  const row = db.prepare("SELECT * FROM relations WHERE id=? AND status='active'").get(Number(id));
  if (!row) return false;
  db.prepare("UPDATE relations SET status='deleted', updated_at=? WHERE id=?").run(nowMs(), Number(id));
  audit(db, 'relation.deleted', { personId: row.from_person_id, detail: `relation:${id}` });
  return true;
}

export function exportPerson(db, personId) {
  const person = getPerson(db, personId);
  if (!person) return null;
  const items = listItems(db, personId, {
    statuses: ['active', 'superseded', 'forgotten', 'quarantined', 'pending_review', 'rejected'],
  });
  const audit = auditLog(db, { limit: 10000, personId });
  const relations = listRelations(db, personId, { asOf: nowMs() });
  const merges = listMerges(db, personId);
  const feedback = listFeedback(db, personId, 10000);
  const evidence = listEvidence(db, personId);
  return {
    format: 'dsh-person-memory-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    person,
    items,
    audit,
    relations,
    merges,
    feedback,
    evidence,
  };
}

/** Hard delete one person and every memory/audit row. Local admin only. */
export function exportAll(db) {
  return {
    format: 'dsh-person-memory-export-all',
    version: 1,
    exportedAt: new Date().toISOString(),
    persons: db.prepare('SELECT * FROM persons ORDER BY id').all(),
    items: db.prepare('SELECT * FROM memory_items ORDER BY id').all(),
    relations: db.prepare('SELECT * FROM relations ORDER BY id').all(),
    merges: db.prepare('SELECT * FROM person_merges ORDER BY id').all(),
    feedback: db.prepare('SELECT * FROM memory_feedback ORDER BY id').all(),
    tombstones: db.prepare('SELECT person_hash,deleted_at,reason FROM person_tombstones ORDER BY id').all(),
  };
}

export function pruneAudit(db, { olderThanDays = 90 } = {}) {
  const cutoff = nowMs() - Math.max(1, Number(olderThanDays)) * 24 * 3600 * 1000;
  const result = db.prepare('DELETE FROM memory_audit WHERE at < ?').run(cutoff);
  return { deleted: Number(result.changes ?? 0) };
}

export function deletePerson(db, personId) {
  const person = getPerson(db, personId);
  if (!person) return { deleted: false, reason: 'not-found' };
  const itemCount = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_items WHERE person_id = ?').get(personId)?.n ?? 0);
  const auditCount = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_audit WHERE person_id = ?').get(personId)?.n ?? 0);
  const personHash = createHash('sha256').update(String(personId)).digest('hex').slice(0, 32);
  try {
    db.exec('BEGIN');
    db.prepare('INSERT INTO person_tombstones(person_hash, deleted_at, reason) VALUES(?,?,?)').run(personHash, nowMs(), 'hard-delete');
    db.prepare('DELETE FROM memory_embeddings WHERE item_id IN (SELECT id FROM memory_items WHERE person_id = ?)').run(personId);
    db.prepare('DELETE FROM relations WHERE from_person_id = ? OR to_person_id = ?').run(personId, personId);
    db.prepare('DELETE FROM person_merges WHERE primary_person_id = ? OR merged_person_id = ?').run(personId, personId);
    db.prepare('DELETE FROM memory_feedback WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM memory_evidence WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM memory_items WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM memory_audit WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM persons WHERE id = ?').run(personId);
    db.exec('COMMIT');
    return { deleted: true, personId, personHash, items: itemCount, audit: auditCount };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    return { deleted: false, reason: 'transaction-failed' };
  }
}

export function auditLog(db, { limit = 100, personId } = {}) {
  if (personId) {
    return db.prepare('SELECT * FROM memory_audit WHERE person_id = ? ORDER BY id DESC LIMIT ?').all(String(personId), limit);
  }
  return db.prepare('SELECT * FROM memory_audit ORDER BY id DESC LIMIT ?').all(limit);
}
