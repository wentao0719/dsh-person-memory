# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.10] - 2026-11-06

### Added

- Reversible person merge (`person_merges`), depth 1, explicit consent.
- Recall expands primary + merged person ids without rewriting memory rows.
- Export includes active merges; hard delete removes merge rows.
- CLI: `merge`, `unmerge`, `merges`.
- 26 tests.

## [0.1.9] - 2026-11-06

### Added

- Feedback actions: confirm / deny / irrelevant / correct, with audit rows.
- Explicit exponential decay (`decayMemory`), core layer excluded.
- Exact-duplicate consolidation (`consolidatePerson`).
- CLI: `feedback`, `feedback-list`, `decay`, `consolidate`.
- 25 tests.

## [0.1.8] - 2026-11-06

### Added

- `as_of` temporal recall using `valid_from` / `valid_until`.
- `relations` table + `upsertRelation` / `listRelations` / `deleteRelation`
  core APIs, included in person export and hard delete.
- `memory-admin relations <person> [asOfMs]`.
- 23 tests.

## [0.1.7] - 2026-11-06

### Added

- Local deterministic feature-hashing embeddings (256 dims, no network).
- `memory_embeddings` table with lazy backfill.
- RRF hybrid recall: keyword rank + local cosine rank, k=60.
- 21 tests.

## [0.1.6] - 2026-11-06

### Changed

- Recall narrows candidates through the FTS5 index for queries of 3+ chars,
  falling back to the full active set on FTS miss/error. Short CJK queries
  still use the in-memory scorer.
- Selected-item `last_used_at` updates are batched into one statement.
- Rebuild FTS on open if the index is empty but items exist.
- 20 tests.

## [0.1.5] - 2026-11-06

### Added

- Per-person active item cap (default 500, env `PERSON_MEMORY_MAX_ITEMS`);
  oldest low-importance learned items are soft-forgotten with an audit row.
- Same-label `fact` conflicts now supersede by default (e.g. 住在 A → 住在 B),
  while preferences remain non-exclusive.
- 19 tests.

## [0.1.4] - 2026-11-06

### Added

- `exportPerson` / `deletePerson` core APIs with atomic hard delete.
- `memory-admin` CLI: stats/list/show/export/forget/delete/audit.
- Local `memory-ui` (127.0.0.1:8092, token-protected): browse, export,
  soft-forget, hard-delete.
- Export/delete tests; 17 tests total.

## [0.1.3] - 2026-11-06

### Fixed

- Persist schema version (`PRAGMA user_version = 1`) instead of leaving it at 0.
- Include quarantine/review/rejected statuses in the known status set.

## [0.1.2] - 2026-11-06

### Changed

- Avoid rewriting/auditing a person row when `ensurePerson` sees no field changes.
  This stops one write per friend turn from `setBinding`.

## [0.1.1] - 2026-11-06

### Fixed

- Enforce per-person tool authorization: a session may only touch its bound
  person; cross-person and group private reads are rejected.
- Remove the hidden `PERSON_MEMORY` tag path from the DSH bridge; memory writes
  go through `remember_person` only.
- Remove local debug probes and hard-coded DSH tools fallback.
- Fix tool result rendering (`render(args, value)`) and lossless JSON output.
- Add authorization tests; total 15 unit tests.

## [0.1.0] - 2026-11-06

### Added

- Per-person long-term memory store (SQLite, WAL, versioned migrations).
- Canonical person registry with aliases and external ids.
- Atomic memory items: kind, confidence, importance, visibility, public audiences,
  validity window, layer, status, superseded_by.
- Admission rules: whitespace-insensitive dedupe, sensitive-content rejection,
  explicit supersede, temporal supersede with `core` protection.
- Retrieval: keyword + importance + recency/usage scoring, top-k and char budgets,
  group-only-public visibility with audience scoping.
- Soft-forget with audit trail.
- DSH plugin glue: `remember_person`, `recall_person`, `forget_person`,
  `memory_status` tools; stable profile system section + dynamic recall context;
  `ctx.personMemory` service for adapters.
- Framework-free `./core` export for other runtimes.
- Unit tests for identity resolution, dedupe, sensitivity, visibility, supersede,
  forget/audit, ranking, budgets, and migration idempotency.
