# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.27] - 2026-11-06

### Added

- Pending relation candidates table and approve/reject APIs.
- CLI `relation-pending`, `relation-approve`, `relation-reject`.
- AstrBot queues explicit relation statements as pending; never auto-writes.
- 39 tests.

## [0.1.26] - 2026-11-06

### Added

- Merge preview token (10 min) with item counts.
- UI/CLI preview before merge; token validated and single-use.
- 38 tests; preview/merge smoke.

## [0.1.25] - 2026-11-06

### Added

- `/api/dashboard` stats + metrics summary; UI "仪表盘".
- Daily LaunchAgent for metrics rotation/alert (`com.wentaohu.person-memory-metrics`).
- Dashboard smoke.

## [0.1.24] - 2026-11-06

### Added

- `pruneEvidence` retention helper; CLI `prune-evidence [days]`.
- 38 tests.

## [0.1.23] - 2026-11-06

### Added

- `relationGraph` BFS depth traversal with display names.
- Memory UI "关系图" button with local SVG rendering.
- 37 tests; local API smoke.

## [0.1.22] - 2026-11-06

### Added

- Memory UI merge/unmerge with explicit `MERGE` confirmation.
- `/api/merges`, `/api/merge`, `/api/unmerge`; local smoke test.

## [0.1.21] - 2026-11-06

### Added

- Memory UI feedback action (`confirm` / `deny` / `irrelevant` / `correct`).
- `/api/feedback` endpoint; local token smoke-tested.
- 36 tests unchanged.

## [0.1.20] - 2026-11-06

### Added

- External embedding provider timeout (AbortController + race) and in-memory TTL cache.
- Dimension validation and `embedding-timeout` error.
- Fake-fetch tests; no network.

## [0.1.19] - 2026-11-06

### Added

- `metrics-alert`: recall p95 and write error-rate thresholds; non-zero exit on violation.
- `rotate-metrics`: size-based JSONL rotation with backup retention.
- Smoke-tested threshold failure and rotation.

## [0.1.18] - 2026-11-06

### Added

- Memory UI: relation list, relation candidates, and consent-gated add.
- API: /api/relations, /api/relation-candidates, /api/relation-add.
- Smoke-tested localhost token flow.
- 35 tests.

## [0.1.17] - 2026-11-06

### Added

- Explicit relation-candidate extraction; never auto-writes.
- Unknown names are returned as `unresolved`.
- CLI `relation-candidates` and consent-gated `relation-add`.
- 35 tests.

## [0.1.16] - 2026-11-06

### Added

- Embedding provider registry: local hash default; external OpenAI-compatible
  skeleton behind explicit `allowExternal: true`.
- External provider refuses construction without opt-in; no network in tests.
- 3 provider tests; docs/EMBEDDING.md.

## [0.1.15] - 2026-11-06

### Added

- `memory_evidence` metadata table for image/audio/video/file references.
- `attachEvidence` / `listEvidence`, exported and hard-deleted with person.
- CLI `evidence` / `evidence-add`.
- 31 tests.

## [0.1.14] - 2026-11-06

### Added

- `recallTrace` with score, source channel, evidence and visibility.
- CLI `trace <person> <query> [private|group] [k]`.
- Memory UI "召回 trace" button.
- 30 tests.

## [0.1.13] - 2026-11-06

### Added

- Process metrics for recall/remember (latency, candidates, vectors), no text.
- Optional JSONL sink via plugin `metricsPath`.
- `scripts/metrics-summary.mjs` prints count/p50/p95.
- 29 tests.

## [0.1.12] - 2026-11-06

### Added

- Synthetic local recall eval: recall@k and hard group-privacy leak gate.
- `npm run eval`; fixtures never touch real friend memory.
- CI remains unit-test only; eval is a separate regression gate.

## [0.1.11] - 2026-11-06

### Added

- Non-identifying deletion tombstones (SHA-256 prefix).
- `exportAll` bundle and `pruneAudit` retention helper.
- CLI: `export-all`, `prune-audit`, `tombstones`.
- 28 tests; compliance notes in `docs/COMPLIANCE.md`.

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
