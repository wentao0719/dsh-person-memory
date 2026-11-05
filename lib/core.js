// dsh-person-memory core
// Framework-free store / admission / retrieval / audit. DSH glue lives in index.js.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
  return { status: 'created', item: rowToItem(db.prepare('SELECT * FROM memory_items WHERE id = ?').get(itemId)) };
}

export function forget(db, { personId, id, actor, reason }) {
  const row = db.prepare("SELECT * FROM memory_items WHERE id = ? AND person_id = ? AND status = 'active'").get(Number(id), String(personId));
  if (!row) return false;
  db.prepare("UPDATE memory_items SET status = 'forgotten', updated_at = ? WHERE id = ?").run(nowMs(), Number(id));
  audit(db, 'memory.forgotten', { personId, itemId: Number(id), detail: reason ? String(reason).slice(0, 200) : null, actor: actor ? String(actor) : null });
  return true;
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
  const now = nowMs();
  if (item.validFrom && item.validFrom > now) return false;
  if (item.validUntil && item.validUntil <= now) return false;
  if (ctx.audience === 'group') {
    if (item.visibility !== 'public') return false;
    const audiences = item.publicAudiences ?? [];
    if (audiences.length && !audiences.includes(String(ctx.audienceKey ?? ''))) return false;
    return true;
  }
  return true; // private context for that person
}

/**
 * Recall top-k items for a context.
 * ctx: { personId, audience: 'private'|'group', audienceKey?, queryText?, limit?, maxChars? }
 */
export function recall(db, ctx) {
  const personId = String(ctx.personId ?? '');
  if (!personId) return [];
  const items = listItems(db, personId).filter((item) => visibleIn(item, ctx));
  if (!items.length) return [];
  const tokens = tokenize(ctx.queryText);
  const now = nowMs();
  const scored = items.map((item) => ({ item, score: scoreItem(item, tokens, now) })).sort((a, b) => b.score - a.score);
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
    db.prepare('UPDATE memory_items SET last_used_at = ? WHERE id = ?').run(now, item.id);
  }
  return selected;
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

export function exportPerson(db, personId) {
  const person = getPerson(db, personId);
  if (!person) return null;
  const items = listItems(db, personId, {
    statuses: ['active', 'superseded', 'forgotten', 'quarantined', 'pending_review', 'rejected'],
  });
  const audit = auditLog(db, { limit: 10000, personId });
  return {
    format: 'dsh-person-memory-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    person,
    items,
    audit,
  };
}

/** Hard delete one person and every memory/audit row. Local admin only. */
export function deletePerson(db, personId) {
  const person = getPerson(db, personId);
  if (!person) return { deleted: false, reason: 'not-found' };
  const itemCount = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_items WHERE person_id = ?').get(personId)?.n ?? 0);
  const auditCount = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_audit WHERE person_id = ?').get(personId)?.n ?? 0);
  try {
    db.exec('BEGIN');
    db.prepare('DELETE FROM memory_items WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM memory_audit WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM persons WHERE id = ?').run(personId);
    db.exec('COMMIT');
    return { deleted: true, personId, items: itemCount, audit: auditCount };
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
