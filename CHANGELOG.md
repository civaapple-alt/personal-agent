# Changelog

All notable changes to Personal Agent are documented in this file.

## [Unreleased]

### Documentation
- Added [docs/configuration.md](docs/configuration.md) as a dedicated reference for environment variables (`PORT`, `PA_DB_PATH`, `PA_PI_EXTENSIONS`, `PA_TURN_TIMEOUT_MS`, `PA_PROMPT_TIMEOUT_MS`, `NODE_ENV`), storage/session paths, Pi RPC & bridge timeouts, role Markdown frontmatter fields, and orchestrator/observer runtime limits, and linked it from `README.md` and `docs/README.md`.
- Added a concise Chinese `AGENTS.md` and layered directory READMEs, separating role assets from parsers, runtime boundaries from local implementation guidance, and offline checks from real-model demos. Added a dependency-free documentation link/command checker.
- Rewrote `docs/architecture-and-plan.md` against the implemented HTTP/SSE, per-execution Pi sessions, authenticated tool bridges, scoped state and explicit milestone delivery. Separated current limits and future work from the historical four-phase design; aligned the README document pointers.

### Fixed
- Allowed updating `observerMemberIds` via `PATCH /api/matters/:id` and the `ChatStage` observer seat popover even while a matter turn is running (still returning HTTP 409 for active workspace switches), so users can invite or adjust observers live without stopping the lead.
- Restored live execution progress, elapsed timer, streamed partial output, and the Stop button across browser refreshes (`F5`) by snapshotting in-flight runs in `src/server/app.ts` (`activeRuns` on `GET /api/bootstrap` and `activeRun` on `GET /api/matters/:id`) and hydrating them in `web/src/App.tsx`.
- Distinguished server shutdown/restart aborts (`cancelReason: "shutdown"`) from user-initiated stops in `TeamOrchestrator` so restarts no longer claim "已按你的要求停止本次执行".

### Added
- Raised the default multi-agent matter turn ceiling in `TeamOrchestrator` from 30 minutes (`1,800,000 ms`) to 90 minutes (`5,400,000 ms`, configurable via `PA_TURN_TIMEOUT_MS` / `PA_PROMPT_TIMEOUT_MS`) with explicit timeout duration in the error message, preventing active multi-specialist chains from timing out right before final lead synthesis while preserving `PiRpcWorker`'s 300s inactivity watchdog.
- Proactive meeting-room observer participation (`observerMemberIds` on matters, `PA_CAN_DELEGATE`/`PA_CAN_PUBLISH` restrictions, isolated `observer` Pi session scope, `[SILENT]` no-op filtering vs independent `user`-channel interjections tagged with `observerIntervention: true`, `PATCH /api/matters/:id` observer updates with 409 busy guard, per-speaker avatars/`旁听补充` badges in `ChatStage`, and a meeting-seat selector pill in the composer bar).
- Persisted Pi session continuation scoped by matter, member, workspace path and conversation mode, including restart recovery, scoped handoff context, legacy session lookup and session-header validation.
- Shipped Pi extension with real `delegate_to_member` and `publish_deliverable` tools over an authenticated per-worker loopback bridge. Internal work returns to the caller and stays in collaboration records.
- Actual loading of the 13 initial role Skills, explicit tool selection, delayed capability handshake for dynamically registered tools, and required tool/MCP dependency checks.
- SQLite matter execution ownership, cancellation across delegation trees, bounded delegation depth/count, duplicate-call handling, and orderly service shutdown.
- `npm run demo:team` verifies real Pi model delegation, an actual document, and recall after restarting the host process in a disposable workspace/database. Regression tests cover continuity, isolation, tool transport and failure/cancellation boundaries.

### Changed
- Converted `ChatStage`'s top-right collaboration drawer (`.collab-dock-panel`) into an anchored floating overlay popover (`top: 64px; right: 24px`) with click-outside and `Escape` dismissal, so opening `团队委托 · 事件` no longer pushes down or squeezes the main conversation stream.
- Tightened proactive observer background injection (`buildObserverContextDigest`): late-joining or active observers now receive only a compact summary (matter title/summary, delivered milestone titles, up to 16 truncated recent user-channel excerpts capped within 6,000 chars, plus the current turn's prompt & lead reply) rather than dumping full 20,000-character verbatim transcripts.
- Role directory discovery now excludes `README.md`, so local asset documentation does not become an invalid team member.
- Follow-up messages keep the matter's lead and workspace. A new matter still uses explicit selection, initial keyword routing or the primary contact; specialist collaboration is decided by the executing member.
- Ordinary replies and clarification no longer become automatic documents or mark the matter delivered. Only the lead publishes reviewable milestones, explicitly requested versions or substantial revisions, with a required change basis linked to the source conversation. Internal specialists return results to the lead. Drafts are staged, validated and archived only when the turn succeeds.
- Company-private memories now require a workspace to be injected. Unscoped historical memories remain viewable. Imported role definitions do not install plugins or Skills automatically.
- Removed the UI's `修改` prefix shortcut that implicitly exported any reply as a new version. Revision requests now use the same explicit milestone decision as other dialogue.
- Active turns reject concurrent messages and workspace switches with HTTP 409. Saved session failures are reported instead of silently starting a new conversation.
- Fixed `ChatStage` top collaboration header label & drawer placement: split the ambiguous combined count into `团队委托 (N) · 事件 M`, docked the panel directly beneath `.stage-header` so clicking it stays visible regardless of scroll position, and separated `团队内部委托` and `过程与工具事件` into explicit tabs.
- Fixed 300s HTTP bridge transport timeout during long colleague delegations by replacing `fetch()` in `team-extension.ts` with `node:http` (`timeout: 0`, avoiding Undici's 300s `headersTimeout`) and disabling `requestTimeout`/`headersTimeout` in `team-tool-bridge.ts`, and removed failed delegation entries from `run.delegations` on error so same-task retries execute a fresh worker instead of replaying cached failures.
- Added humanized role mood micro-animations to `BotFaceIcon` (idle blinking, thinking glance/bob + thought bubbles, focused tool-scanning eyes, waiting-user attention pip, and finalizing happy eyes with reduced-motion support) and redesigned `ExploringStatus` + `Sidebar` into a live team desk showing per-role animated avatars, labeled 5-stage stepper, active colleague cards, and recent tool/writing activity feed.
- Aligned frontend state with the backend turn & scope boundaries: prevented optimistic workspace changes from masking 409/errors, guarded active-turn sends/switches in `ChatStage`, kept SSE connections open across matter switches via refs, rendered deliverable `changeNote` summaries in `DeliverableCard`, and labeled memory workspace bindings in `TeamView`.
- Suspended parent `PiRpcWorker` inactivity watchdog while host-bridged team tool calls (`delegate_to_member`, `publish_deliverable`) are executing (preserving child worker idle watchdogs and overall turn deadlines), forwarded delegated colleague progress (`activeDelegations`, concrete tool path/command summaries, throttled writing snippets, and `recentLogs` activity feed) plus `collabUpdated` SSE sync to `ExploringStatus` and `App.tsx`, and added per-turn collapsible delegation summary cards plus structured delegation/event sections in `ChatStage` (`协作过程`).
- Marketing's declared tools now match the installed Pi baseline (`read`, `bash`), replacing the unimplemented `web_search` declaration. No claim of a dedicated search service is made.

## [0.4.0] - 2026-11-14

### Changed
- **Grok-Bot-Inspired Two-Column Interactive Workspace (`web/src/App.tsx`, `web/src/styles.css`, `web/src/hashRouter.ts`)**:
  - Replaced the constrained three-column layout with a `292px` left sidebar (`#f6f8f7`) and a spacious centered conversation canvas (`max-width: 820px`).
  - Added tilted SVG bot avatars (`BotFaceIcon`) across the quick-roster strip, active header pill, and `#/chats/new` hero; added sidebar matter search toggle and recent-matter status previews.
  - Changed the default landing hash route from `#/deliverables` to `#/chats` so the workbench opens directly into the conversation-first workspace.
- **Streamlined Conversation Flow**:
  - Removed duplicate message and full deliverable-card rendering inside `#/chats/:id`; replaced inline chat deliverable blocks and feedback forms with a compact one-line archive pill (`✓ 已归档至成果库 · V{n}` with quick links to `#/deliverables` and preview URLs), while keeping full deliverable inspection and acceptance feedback in `#/deliverables`.
  - Suppressed redundant `matter_settled` top banners when already viewing the settled matter's conversation, and simplified `#/chats/new` to a clean centered hero without bulky 3-card onboarding clutter (keeping `+` starter prompts accessible from the floating bottom pill composer).

### Added
- **In-Flight Run Abort / Stop Controls**:
  - Added `RpcWorkerLike.abort?()`, `TeamOrchestrator.abortMatter(matterId)` (sends Pi RPC `abort` with a `1500ms` fallback to `worker.stop()`, suppresses deliverable archival for aborted runs, and records `[已中断执行]` / stop confirmation), and `DialogBroker.cancelForMatter(matterId)`.
  - Added `POST /api/matters/:id/abort` and the `matter_aborted` SSE event (`src/server/app.ts`, `web/src/api.ts`).
  - Added immediate stop actions in the UI via `ExploringStatus` (`停止` button) and the bottom pill composer (`■` `.pill-stop-btn`).
- **Matter Workspace Sync & Live Switching**:
  - Added `PersonalAgentStore.updateMatterWorkspace(matterId, workspaceId)` and `PATCH /api/matters/:id` (`src/storage/repositories.ts`, `src/server/app.ts`, `web/src/api.ts`) so bound repositories can be corrected mid-thread.
  - Synced `selectedWorkspaceId` to `matterDetail.matter.workspaceId` on matter load/refresh and persisted new-matter selection in `localStorage` (`pa.defaultWorkspaceId`).

### Tests
- Updated `test/phase2-orchestrator.test.ts` and `test/phase3-server.test.ts` (including HashRouter `#/chats` default route checks and a new server integration test for aborting a running matter and updating its bound workspace).

## [0.3.1] - 2026-11-14

### Added
- **V4 UX Guidance, Team Management, Live Progress & Hash Router**:
  - Replaced technical empty state in `交付给我` with a 3-step onboarding card featuring workspace selection and one-click starter prompts for `研发经理`, `产品经理`, and `测试经理` (`web/src/App.tsx`).
  - Added `我的团队` tab and backend APIs (`POST /api/members`, `POST /api/members/:id/primary`, `GET /api/members/:id/export`, `POST /api/members/import`, `POST /api/memories`) for adding custom roles, switching the default primary contact, viewing/saving scoped memories, and importing/exporting sanitized role Markdown packages (`src/server/app.ts`, `src/storage/repositories.ts`).
  - Added 5-stage live progress reporting (`DispatchProgressEvent` + `matter_progress` SSE events) across `TeamOrchestrator`, HTTP server, and top/right progress cards (`src/orchestrator/team-orchestrator.ts`).
  - Added safe zero-`dangerouslySetInnerHTML` Markdown rendering (`web/src/MarkdownView.tsx`) and completion banners on deliverables.
  - Added lightweight URL Hash Router (`web/src/hashRouter.ts`) supporting `#/deliverables/:id`, `#/chats/:id`, `#/chats/new`, `#/team`, and `#/materials` with refresh persistence and browser back/forward navigation.
  - Added tests for `matter_progress` SSE, team/memory APIs, and `hashRouter` (`test/phase3-server.test.ts`).

## [0.3.0] - 2026-11-14

### Added
- **Phase 3 V4 Workbench, HTTP/SSE Server & Preview Runner**:
  - Added Node HTTP + SSE backend (`src/server/app.ts`, `src/server/dialog-broker.ts`, `src/server/main.ts`) supporting real-time text streaming, matter dispatch, separated `user` vs collapsed `internal_collab`/`notice` channels, interactive `extension_ui_request` approval resolution, deliverable versioning & feedback, and workspace binding.
  - Added `PreviewManager` (`src/server/preview-manager.ts`) to launch, monitor, and stop independent local preview services (`http://127.0.0.1:<port>`) for V4's "打开查看 →" links.
  - Added React 19.3.0 V4 three-column workbench (`web/src/`, bundled via `esbuild` in `scripts/build-web.mjs`) with `交付给我`, `和同事聊`, `已有资料`, collapsible `我的同事`, interactive approval cards, and collapsed `协作对话`.
  - Added Phase 3 server & preview integration tests (`test/phase3-server.test.ts`).

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
