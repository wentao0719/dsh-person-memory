// dsh-person-memory — DSH plugin glue.
// Generic, channel-agnostic: adapters bind a session to a person via
// ctx.personMemory.setBinding(sessionId, { personId, audience, audienceKey, profile }).
import { defineTool } from '@deepseek-ai/dsh-tools';
import * as core from './core.js';
import { resolvePersonAccess, resolveRecallAudience, resolveStatusPerson } from './auth.js';

export const name = 'person-memory';
export const inject = ['tools', 'systemPrompt', 'agents', 'timer'];

const DEFAULTS = {
  enabled: true,
  dbPath: './person-memory.sqlite',
  topKPrivate: 5,
  maxCharsPrivate: 600,
  topKGroup: 3,
  maxCharsGroup: 300,
  defaultVisibility: 'private',
  publicConsentRequired: true,
  mountTickMs: 1000,
  recallCacheMs: 1500,
  exposeGlobalService: false,
};

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function log(ctx, level, ...args) {
  try {
    ctx.logger?.[level]?.('[person-memory]', ...args);
  } catch {
    // eslint-disable-next-line no-console
    console[level === 'warn' ? 'warn' : 'error']?.('[person-memory]', ...args);
  }
}

function lastUserText(session) {
  try {
    const events = session?.snapshotEvents?.() ?? [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event?.type !== 'user/message') continue;
      const content = event.data?.content ?? [];
      const text = content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join(' ').trim();
      if (text) return text;
    }
  } catch {
    // best effort
  }
  return '';
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  let db = null;
  let broken = false;

  const openDb = () => {
    if (!cfg.enabled || broken) return null;
    if (db) return db;
    try {
      db = core.openStore(cfg.dbPath);
      log(ctx, 'info', 'store opened', cfg.dbPath);
    } catch (error) {
      broken = true;
      log(ctx, 'warn', 'store open failed; plugin disabled for this process', error?.message ?? error);
      return null;
    }
    return db;
  };

  const bindings = new Map(); // sessionId -> binding

  const service = {
    setBinding(sessionId, binding) {
      const b = {
        personId: String(binding?.personId ?? ''),
        audience: binding?.audience === 'group' ? 'group' : 'private',
        audienceKey: String(binding?.audienceKey ?? ''),
        profile: binding?.profile ?? null,
      };
      bindings.set(String(sessionId), b);
      const store = openDb();
      if (store && b.personId && b.profile) {
        try {
          core.ensurePerson(store, { id: b.personId, ...b.profile });
        } catch (error) {
          log(ctx, 'warn', 'ensure person failed', error?.message ?? error);
        }
      }
      return b;
    },
    getBinding(sessionId) {
      return bindings.get(String(sessionId)) ?? null;
    },
    ensurePerson(person) {
      const store = openDb();
      return store ? core.ensurePerson(store, person) : null;
    },
    resolvePerson(key) {
      const store = openDb();
      return store ? core.resolvePerson(store, key) : null;
    },
    remember(options) {
      const store = openDb();
      return store ? core.remember(store, options) : { status: 'rejected', reason: 'store-unavailable' };
    },
    recall(personId, context) {
      const store = openDb();
      return store ? core.recall(store, { personId, ...(context ?? {}) }) : [];
    },
    forget(options) {
      const store = openDb();
      return store ? core.forget(store, options) : false;
    },
    stats() {
      const store = openDb();
      return store ? core.stats(store) : null;
    },
  };

  try {
    ctx.personMemory = service;
  } catch {
    // best effort
  }
  try {
    ctx.provide?.('personMemory', service);
  } catch {
    // best effort
  }
  if (cfg.exposeGlobalService) {
    try {
      globalThis[Symbol.for('dsh.personMemory')] = service;
    } catch {
      // best effort
    }
  }

  const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];

  function makeTools(agent) {
    const defaultPerson = () => {
      if (agent?.session?.id) {
        const binding = bindings.get(String(agent.session.id));
        if (binding?.personId) return binding;
      }
      return null;
    };

    const rememberTool = defineTool({
      name: 'remember_person',
      description:
        'Store or update one stable fact, preference, or relationship about a person. '
        + 'Default visibility is private; set visibility to public only when the person explicitly allowed sharing. '
        + 'Do not store one-off events, guesses, secrets, or other people\'s privacy.',
      parameters: {
        person: { type: 'string', description: 'Optional person id; must match the person bound to this session' },
        text: { type: 'string', required: true, description: 'One atomic fact, in the person\'s own terms' },
        kind: { type: 'string', description: 'profile | preference | fact | relationship | episode (default fact)' },
        confidence: { type: 'number', description: '0..1, default 0.7' },
        importance: { type: 'number', description: '0..1, default 0.5' },
        visibility: { type: 'string', description: 'private (default) | public' },
        consent: { type: 'boolean', description: 'Set true when the person explicitly allowed public sharing' },
        public_audiences: { type: 'array', items: { type: 'string' }, description: 'Optional audience keys when public; empty means all audiences' },
        layer: { type: 'string', description: 'core | learned | mood' },
        evidence: { type: 'string', description: 'Short source snippet or evidence id' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string' },
            reason: { type: 'string' },
            item: { type: 'object', additionalProperties: true },
          },
        },
        render,
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const store = openDb();
        if (!store) return { status: 'rejected', reason: 'store-unavailable' };
        const access = resolvePersonAccess(defaultPerson(), args.person);
        if (!access.ok) return { status: 'rejected', reason: access.reason };
        const person = access.personId;
        const requested = String(args.visibility ?? cfg.defaultVisibility);
        const visibility = core.sanitizeVisibility(requested);
        if (visibility === 'public' && cfg.publicConsentRequired && args.consent !== true) {
          return { status: 'rejected', reason: 'public-consent-required' };
        }
        return jsonSafe(core.remember(store, {
          personId: person,
          kind: args.kind,
          text: args.text,
          confidence: args.confidence,
          importance: args.importance,
          visibility,
          publicAudiences: args.public_audiences,
          layer: args.layer,
          evidence: args.evidence,
          source: { channel: access.binding?.audience === 'group' ? 'group' : 'manual' },
        }));
      },
    });

    const recallTool = defineTool({
      name: 'recall_person',
      description: 'Recall the most relevant memories about a person for the current context.',
      parameters: {
        person: { type: 'string', description: 'Person id; defaults to the person bound to this session' },
        query: { type: 'string', description: 'Optional current topic for relevance ranking' },
        limit: { type: 'number', description: 'Max items, default 5 (private) / 3 (group)' },
        max_chars: { type: 'number', description: 'Max total characters' },
        audience: { type: 'string', description: 'private (default) | group' },
        audience_key: { type: 'string', description: 'Audience key used for public scoping in group context' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            section: { type: 'string' },
            reason: { type: 'string' },
          },
        },
        render,
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const store = openDb();
        if (!store) return { items: [], section: '', reason: 'store-unavailable' };
        const binding = defaultPerson();
        const access = resolvePersonAccess(binding, args.person);
        if (!access.ok) return { items: [], section: '', reason: access.reason };
        const audienceAccess = resolveRecallAudience(binding, args.audience);
        if (!audienceAccess.ok) return { items: [], section: '', reason: audienceAccess.reason };
        const items = core.recall(store, {
          personId: access.personId,
          audience: audienceAccess.audience,
          audienceKey: audienceAccess.audienceKey,
          queryText: args.query,
          limit: Number(args.limit ?? (audienceAccess.audience === 'group' ? cfg.topKGroup : cfg.topKPrivate)),
          maxChars: Number(args.max_chars ?? (audienceAccess.audience === 'group' ? cfg.maxCharsGroup : cfg.maxCharsPrivate)),
        });
        return jsonSafe({ items, section: core.recallSection(items) });
      },
    });

    const forgetTool = defineTool({
      name: 'forget_person',
      description: 'Forget one stored memory about a person. Use only when asked or when it is proven wrong.',
      parameters: {
        person: { type: 'string', description: 'Optional person id; must match the person bound to this session' },
        id: { type: 'number', required: true, description: 'Memory item id' },
        reason: { type: 'string', description: 'Short reason for the audit log' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            forgotten: { type: 'boolean' },
            reason: { type: 'string' },
          },
        },
        render,
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const store = openDb();
        if (!store) return { forgotten: false, reason: 'store-unavailable' };
        const access = resolvePersonAccess(defaultPerson(), args.person);
        if (!access.ok) return { forgotten: false, reason: access.reason };
        return { forgotten: core.forget(store, { personId: access.personId, id: args.id, reason: args.reason, actor: 'tool' }) };
      },
    });

    const statusTool = defineTool({
      name: 'memory_status',
      description: 'Report the current person memory store status.',
      parameters: {
        person: { type: 'string', description: 'Optional person id' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            reason: { type: 'string' },
            person: { type: 'string' },
            persons: { type: 'number' },
            activeItems: { type: 'number' },
            items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            byVisibility: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render,
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const store = openDb();
        if (!store) return { ok: false, reason: 'store-unavailable' };
        const access = resolveStatusPerson(defaultPerson(), args.person);
        if (!access.ok) return { ok: false, reason: access.reason };
        if (access.personId) {
          const items = core.listItems(store, access.personId);
          return jsonSafe({ ok: true, person: access.personId, items });
        }
        return jsonSafe({ ok: true, ...core.stats(store) });
      },
    });

    return { rememberTool, recallTool, forgetTool, statusTool };
  }

  // Global registration so the tools exist even before any agent mounts.
  const globals = makeTools(null);
  for (const tool of Object.values(globals)) {
    try { ctx.tools.register(tool); } catch { /* scoped registration may be unavailable */ }
  }

  const mounted = new Map(); // sessionId -> { agent, disposers: [] }

  function mountFor(agent, sessionId) {
    const disposers = [];
    const agentTools = agent?.ctx?.tools;
    if (agentTools?.register) {
      for (const tool of Object.values(makeTools(agent))) {
        try { disposers.push(agentTools.register(tool)); } catch { /* keep going */ }
      }
    }
    try {
      disposers.push(agent.ctx.systemPrompt.section({
        name: 'person-memory:profile',
        order: 90110,
        interpolate: false,
        text: () => {
          const binding = bindings.get(sessionId);
          if (!binding?.personId) return '';
          const store = openDb();
          const person = store ? core.getPerson(store, binding.personId) : null;
          return person ? core.profileSection(person) : '';
        },
      }));
    } catch (error) {
      log(ctx, 'warn', 'profile section mount failed', error?.message ?? error);
    }
    const cache = { key: '', at: 0, text: '' };
    try {
      disposers.push(agent.ctx.systemPrompt.context({
        name: 'person-memory:recall',
        order: 900,
        interpolate: false,
        text: () => {
          try {
            const binding = bindings.get(sessionId);
            if (!binding?.personId) return '';
            const store = openDb();
            if (!store) return '';
            const query = lastUserText(agent.session);
            const cacheKey = `${sessionId}|${query}`;
            const now = Date.now();
            if (cache.key === cacheKey && now - cache.at < cfg.recallCacheMs) return cache.text;
            const items = core.recall(store, {
              personId: binding.personId,
              audience: binding.audience,
              audienceKey: binding.audienceKey,
              queryText: query,
              limit: binding.audience === 'group' ? cfg.topKGroup : cfg.topKPrivate,
              maxChars: binding.audience === 'group' ? cfg.maxCharsGroup : cfg.maxCharsPrivate,
            });
            cache.key = cacheKey;
            cache.at = now;
            cache.text = core.recallSection(items);
            return cache.text;
          } catch {
            return '';
          }
        },
      }));
    } catch (error) {
      log(ctx, 'warn', 'recall context mount failed', error?.message ?? error);
    }
    return disposers;
  }

  function disposeAll(disposers) {
    for (const disposer of disposers) {
      try { disposer?.(); } catch { /* ignore */ }
    }
  }

  function tick() {
    try {
      const list = ctx.agents?.list?.() ?? [];
      for (const agent of list) {
        const sessionId = String(agent?.session?.id ?? '');
        if (!sessionId) continue;
        const current = mounted.get(sessionId);
        if (current?.agent === agent) continue;
        if (current) {
          disposeAll(current.disposers);
          mounted.delete(sessionId);
        }
        try {
          const disposers = mountFor(agent, sessionId);
          mounted.set(sessionId, { agent, disposers });
        } catch (error) {
          log(ctx, 'warn', 'agent mount failed', sessionId, error?.message ?? error);
        }
      }
      for (const [sessionId, record] of mounted) {
        const stillLive = list.some((agent) => String(agent?.session?.id ?? '') === sessionId && agent === record.agent);
        if (!stillLive) {
          disposeAll(record.disposers);
          mounted.delete(sessionId);
        }
      }
    } catch {
      // never break the host
    }
  }

  if (cfg.enabled) {
    tick();
    try {
      ctx.effect(() => ctx.interval(tick, Math.max(200, Number(cfg.mountTickMs ?? 1000))));
    } catch (error) {
      log(ctx, 'warn', 'timer unavailable; agent mounts may lag', error?.message ?? error);
    }
  }

  ctx.effect(() => () => {
    for (const record of mounted.values()) disposeAll(record.disposers);
    mounted.clear();
    bindings.clear();
    try { db?.close(); } catch { /* ignore */ }
    db = null;
  });
}
