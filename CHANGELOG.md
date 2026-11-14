# Changelog

All notable changes to Personal Agent are documented in this file.

## [0.2.0] - 2026-11-14

### Added
- **Phase 2 Role Templates, SQLite Store & Orchestrator**:
  - Added 4 shareable Markdown + YAML frontmatter role templates under `roles/` (`marketing-lead.md`, `product-manager.md`, `engineering-manager.md`, `qa-manager.md`) and loader/serializer (`src/roles/`).
  - Added local SQLite storage built on Node's `node:sqlite` (`src/storage/database.ts`, `src/storage/repositories.ts`) separating shareable role templates from scoped private memories (`role_general`, `company_private`, `project_private`), `matters`, `matter_messages` (`user` / `internal_collab` / `notice` channels), versioned `deliverables`, `workspace_links`, and `worker_sessions`.
  - Added `TeamOrchestrator` (`src/orchestrator/team-orchestrator.ts`) supporting keyword-based routing ("按事找人"), workspace `cwd` mounting, internal role-to-role delegation, `waiting_user` dialog handling, and auto-versioned deliverable recording.
  - Added Phase 2 unit and orchestration tests (`test/phase2-orchestrator.test.ts`).

## [0.1.0] - 2026-11-14

### Added
- **Phase 1 Pi RPC Worker (`src/rpc/`)**:
  - `attachJsonlLineReader` & `serializeJsonLine` (`src/rpc/jsonl.ts`): strict LF-only JSONL framing avoiding `node:readline` splitting on `U+2028`/`U+2029`.
  - `PiRpcWorker` (`src/rpc/pi-rpc-worker.ts`): subprocess-isolated `pi --mode rpc` runner with `id`-correlated commands, `prompt` `disposition === "handled"` fast path, `agent_settled` completion detection, bidirectional `extension_ui_request`/`extension_ui_response` handling, non-blocking UI notice routing, and graceful stdin-EOF shutdown.
  - Smoke demo (`src/demo/rpc-smoke.ts`) verified live against `pi` `1.5.2` using `kimi-coding / kimi-for-coding`.
  - Unit test suite (`test/pi-rpc-worker.test.ts`) covering JSONL framing, concurrent requests, handled prompts, streaming, and bidirectional dialogs.
- **Engineering Baseline**:
  - Added TypeScript strict configuration (`tsconfig.json`, `tsconfig.build.json`) targeting Node.js `>= 22.19.0`.
  - Added `@biomejs/biome` `2.3.5` (`biome.json`) aligned with `pi-source` (`tab` indentation, `120` line width, `useConst`).
  - Added root `README.md` and `CHANGELOG.md`.

### Documentation
- Added `docs/architecture-and-plan.md` (`a91c1cf`): Pi RPC-based system architecture, domain models, and 4-phase roadmap.
- Initialized Git repository and committed baseline product direction, V1–V4 prototypes, and Grok Bot references (`52d8adc`).
