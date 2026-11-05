# dsh-person-memory

Channel-agnostic per-person long-term memory plugin for DeepSeek Harness (DSH) agents.

- Every person gets an isolated, retrievable, forgettable memory store.
- `private` memories only surface in that person's private context; group contexts only ever see `public` memories scoped to that audience.
- Keyword-first retrieval, SQLite storage, audit log, zero external services.
- Embedding and background extraction are optional adapters (see `DESIGN.md`).

## Install

Add to the profile composition:

```yaml
- id: person-memory
  name: /path/to/dsh-person-memory
  config:
    enabled: true
    dbPath: ./state/person-memory.sqlite
    defaultVisibility: private
    publicConsentRequired: true
```

Local plugins load by directory when the entry file is `lib/index.js` with
`export const name` / `export const inject` / `export function apply(ctx, config)`.

## Model-facing tools

- `remember_person` — store/update one stable fact, preference, or relationship.
  - `visibility: public` requires `consent: true` when `publicConsentRequired` is on.
- `recall_person` — retrieve top-k relevant memories for a person.
- `forget_person` — soft-delete a memory (audited, restorable by an admin).
- `memory_status` — store stats or one person's active items.

## Adapter integration

Adapters bind a session to a person once, then the plugin injects the stable
profile (system section) and a dynamic recall context each turn:

```js
ctx.personMemory.setBinding(sessionId, {
  personId: 'urn:person:qq:1621861622',
  audience: 'private',          // or 'group'
  audienceKey: '',              // group audience key for public scoping
  profile: {
    displayName: 'ty',
    timezone: 'Asia/Shanghai',
    relationship: 'friend',
    aliases: ['小t'],
    externalIds: { qq: '1621861622' },
  },
});
```

Service API on `ctx.personMemory`:

```ts
setBinding(sessionId, binding)
ensurePerson(person)
resolvePerson(key)
remember(options)
recall(personId, context)
forget({ personId, id, reason })
stats()
```

`./core` exports the framework-free store, admission, retrieval and audit logic
for use in other runtimes (AstrBot plugins, bridges, tests).

## Privacy rules

- Group context: only `public` memories whose `publicAudiences` is empty or
  contains the current audience key.
- Private context: that person's `private` + `public` memories.
- Cross-person access is impossible at the query layer.
- `forget` is a soft delete (`status = forgotten`) and always audited.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `dbPath` | `./person-memory.sqlite` | SQLite file |
| `defaultVisibility` | `private` | Default for `remember_person` |
| `publicConsentRequired` | `true` | Require explicit `consent` for public writes |
| `topKPrivate` | `5` | Recall limit in private context |
| `topKGroup` | `3` | Recall limit in group context |
| `maxCharsPrivate` | `600` | Recall budget in private context |
| `maxCharsGroup` | `300` | Recall budget in group context |
| `mountTickMs` | `1000` | Agent mount polling interval |
| `recallCacheMs` | `1500` | Per-request recall cache |

## Development

```bash
node --test test/*.test.mjs
```

Core logic is framework-free and tested without a running DSH host. The
`lib/index.js` glue requires a DSH host and is validated by syntax check in
this repo; an integration test against a live host is not part of the unit
suite.

## Requirements

- Node.js >= 22.5 (`node:sqlite`).
- DSH host with `@deepseek-ai/dsh-tools` available for the plugin entry.

## Publishing checklist

- [ ] Confirm the package name is available on npm (or use a scoped name).
- [ ] Fill in `repository`, `homepage` and `author` in `package.json`.
- [ ] Run `npm test` and `node --check lib/index.js`.
- [ ] Verify `npm pack --dry-run` contents.
- [ ] Tag the release and update `CHANGELOG.md` date.

## License

Apache-2.0

## Admin CLI

```bash
node scripts/memory-admin.mjs stats
node scripts/memory-admin.mjs list
node scripts/memory-admin.mjs show urn:person:qq:514557769
node scripts/memory-admin.mjs export urn:person:qq:514557769 out.json
node scripts/memory-admin.mjs forget urn:person:qq:514557769 9
node scripts/memory-admin.mjs delete urn:person:qq:514557769 --confirm
```

`delete` is a hard delete of the person, all memory items and their audit rows.
It is irreversible.

## Local memory UI

```bash
MEMORY_UI_TOKEN_FILE=./state/run/memory-ui.token node scripts/memory-ui.mjs
# open http://127.0.0.1:8092
```

Bind is fixed to `127.0.0.1`; every `/api/*` request requires
`x-memory-token` (or `?token=`). The page supports browse, export, soft-forget
and hard-delete. Do not expose this port to a network.

## Local hybrid recall

The default embedding provider is a local feature-hash embedder:

- 256 dimensions;
- no network, no model download, no text leaves the machine;
- deterministic, so it is safe for tests and migrations;
- RRF combines keyword rank and cosine rank (k=60).

It is a lexical baseline, not a semantic model. External embedding providers
are not enabled by default and require an explicit opt-in.
