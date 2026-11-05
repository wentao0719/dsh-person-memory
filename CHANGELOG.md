# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
