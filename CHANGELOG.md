# Changelog

All notable changes to Personal Agent are documented in this file.

## [Unreleased]

### Documentation
- Added [docs/configuration.md](docs/configuration.md) as a dedicated reference for environment variables (`PORT`, `PA_DB_PATH`, `PA_PI_EXTENSIONS`, `PA_TURN_TIMEOUT_MS`, `PA_PROMPT_TIMEOUT_MS`, `NODE_ENV`), storage/session paths, Pi RPC & bridge timeouts, role Markdown frontmatter fields, and orchestrator/observer runtime limits, and linked it from `README.md` and `docs/README.md`.
- Added a concise Chinese `AGENTS.md` and layered directory READMEs, separating role assets from parsers, runtime boundaries from local implementation guidance, and offline checks from real-model demos. Added a dependency-free documentation link/command checker.
- Rewrote `docs/architecture-and-plan.md` against the implemented HTTP/SSE, per-execution Pi sessions, authenticated tool bridges, scoped state and explicit milestone delivery. Separated current limits and future work from the historical four-phase design; aligned the README document pointers.

### Changed
- Redesigned `DeliverableCard` and `DeliverablesView` (`web/src/components/DeliverableCard.tsx`, `DeliverablesView.tsx`, `web/src/utils.ts` `parseDeliverableSummary`, `web/src/styles.css`) for calmer, focus-and-process reading: removed the redundant green author banner and cramped 440px nested scroll box in detail view, extracted `本版重点` (lead takeaway) alongside a collapsible `过程` bar (`查看依据与版本` timeline + `原对话过程 →`), improved Markdown reading typography, and tucked the acceptance form behind a `记录验收`/`修改验收` toggle.

### Fixed
- Defaulted experience workspace selection to the active or source matter's repository (`web/src/utils.ts` `pickDefaultWorkspaceId`, `ExperienceReviewPanel.tsx`, `TeamView.tsx`, `App.tsx`): when editing a cross-project (`role_general`) memory and switching its scope to `当前仓库规范` (`project_private`) or `company_private` (in `ChatStage`, `DeliverableCard`, or `TeamView`), the workspace selector now defaults to the current/source matter's repository rather than `workspaces[0]`, while remaining manually changeable.
- Deduplicated deliverable-card experience controls (`web/src/components/DeliverableCard.tsx`, `ExperienceReviewPanel.tsx`): renamed `沉淀为角色经验` to `手动沉淀经验` on `DeliverableCard`'s action bar and hid the redundant `+ 手动录入` / `AI 复盘提炼团队经验` buttons inside the embedded `InlineExperienceReviewSection` (`showManualToggle={false}`), while keeping both controls in `ChatStage`'s standalone experience drawer.
- Fixed truncated raw JSON blobs in the `过程与工具事件` panel (`src/orchestrator/team-orchestrator.ts`, `web/src/utils.ts`): replaced `.slice(0, 16000)` raw event serialization with compact valid JSON tool-event notices (`type`, `toolCallId`, `toolName`, truncated `args`, `isError`), and added regex fallback parsing in `formatNoticeEventLine` (plus `isKeyNoticeEvent`) so previously persisted truncated tool notices also render cleanly without dumping raw file contents.
- Fixed UI visual clutter across the `ChatStage` collaboration popover and `ExperienceReviewPanel` (`web/src/components/ChatStage.tsx`, `ExperienceReviewPanel.tsx`, `web/src/styles.css`): removed duplicate red `待复核` alert badges and empty `命中 0 · +0 / -0` telemetry from newly distilled `candidate` items (keeping `+1`/`-1` feedback on verified rules), removed nested card borders inside the floating drawer, rendered long delegation briefs/answers as collapsible Markdown cards, ordered `过程与工具事件` newest-first with a `仅看关键/异常事件` filter and progressive disclosure (`80` items initially), and aligned `.btn-pill-outline.active` styling with `.collab-tab-btn.active`.
- Fixed worker `runPromptAndWait` still hitting a 30-minute (`1,800,000 ms`) cutoff in `TeamOrchestrator`: `dispatchMatter` previously left `run.timeoutMs` as `undefined` (before resolving `turnDeadlineMs`), causing `executeWithWorker` to fall back to `PiRpcWorker`'s `1,800,000 ms` hard timeout; resolved `run.timeoutMs` and `run.deadlineAt` cleanly (`PA_TURN_TIMEOUT_MS` -> `PA_PROMPT_TIMEOUT_MS` -> `5,400,000 ms`) so both lead and delegated workers receive remaining turn budget, and aligned `PiRpcWorker`'s standalone default to `5,400,000 ms` (90 minutes).
- Allowed updating `observerMemberIds` via `PATCH /api/matters/:id` and the `ChatStage` observer seat popover even while a matter turn is running (still returning HTTP 409 for active workspace switches), so users can invite or adjust observers live without stopping the lead.
- Restored live execution progress, elapsed timer, streamed partial output, and the Stop button across browser refreshes (`F5`) by snapshotting in-flight runs in `src/server/app.ts` (`activeRuns` on `GET /api/bootstrap` and `activeRun` on `GET /api/matters/:id`) and hydrating them in `web/src/App.tsx`.
- Distinguished server shutdown/restart aborts (`cancelReason: "shutdown"`) from user-initiated stops in `TeamOrchestrator` so restarts no longer claim "已按你的要求停止本次执行".

### Added
- Added [skills/technical-writing/SKILL.md](skills/technical-writing/SKILL.md) (wired into all four default role definitions in `roles/`, listed in `skills/README.md`, and reinforced in `TeamOrchestrator` & `publish_deliverable` schema) establishing the deliverable-writing standard: **简练 · 有重点 · 有过程** (1–3 sentence `changeNote`, lead-with-conclusions structure, mode separation, and concise verification/collaboration evidence without raw log walls).
- Added end-to-end cancellation support for in-flight AI experience distillation: added `abortDistillation(matterId)` & `signal` propagation in `TeamOrchestrator.distillExperiences` (`src/orchestrator/team-orchestrator.ts`, also triggered during `shutdown()`), added `POST /api/rsi/distill/abort` and response-close abort propagation on `POST /api/rsi/distill` (`src/server/app.ts`), and added `取消提炼` buttons alongside active distill states in `DeliverableCard` and `InlineExperienceReviewSection` backed by browser `AbortController` (`web/src/api.ts`, `web/src/App.tsx`, `web/src/components/`).
- Preserved execution progress snapshots (`progressSnapshot` metadata containing stopped stage, label, elapsed duration, active delegations, and recent activity logs) on both failed (`src/server/app.ts`) and aborted (`TeamOrchestrator`) `user`-channel messages via shared `buildProgressSnapshot`, rendered collapsible `<ProgressSnapshotCard />` summaries directly below warning/aborted bubbles in `ChatStage` (`web/src/components/ExploringStatus.tsx`, `web/src/styles.css`), and injected a scoped `buildInterruptionResumeBrief` summary (last failure/abort reason, stopped stage, unfinished colleague delegations, and recent tool trajectory) when the lead resumes an interrupted turn so follow-ups like `"继续"` pick up right from the breakpoint without re-running completed work.
- Implemented the Phase 4 RSI experience-distillation, verification, and acceptance-linked evaluation loop across storage, tool bridge, orchestrator, HTTP/SSE server, and web UI (while keeping unattended scheduled overnight runs and public marketplace out of scope):
  - **Storage & Schema (`src/storage/`)**: Added `status` (`candidate` | `verified` | `rejected` | `superseded`), `rationale`, `source_deliverable_id`, `superseded_by`, `supersedes_memory_id`, `applied_count`, `positive_count`, `negative_count`, `last_applied_at`, and `updated_at` on `member_memories`, `deliverables.feedback_rating` (`positive` | `negative` | `neutral`), and the `memory_applications` table with idempotent outcome tracking (`recordMemoryApplications`, `evaluateMatterMemories`, `evaluateMemory`, `updateMemory`, `markMemorySuperseded`, `findActiveDuplicateMemory`).
  - **Active-Work Proposal & Isolated Reflection (`src/rpc/`, `src/orchestrator/team-orchestrator.ts`)**: Added `propose_experience` Pi extension tool (enabled for lead & internal specialists, blocked in observer mode via `PA_CAN_EXPERIENCE="false"`, staged and committed as `candidate` only on non-aborted completion); added `TeamOrchestrator.distillExperiences()` running a read-only no-tools reflection worker (`--no-extensions --no-skills --no-mcp --tools ""`, `noSession: true`) to extract deduplicated candidates and `supersedesMemoryId` suggestions; differentiated `[已验证]` vs `[待验证]` in prompt injection and recorded memory injections cleanly.
  - **HTTP/SSE & Workbench UI (`src/server/app.ts`, `web/src/`)**: Extended `POST /api/deliverables/:id/feedback` with optional `rating` and `autoDistill`, added `POST /api/rsi/distill`, `PATCH /api/memories/:id`, `POST /api/memories/:id/evaluate`, and `GET /api/memories/:id/applications`; upgraded `DeliverableCard` / `DeliverablesView` (acceptance rating chips, AI experience distillation action, auto-distill toggle, manual `company_private` scope + rationale + `candidate`/`verified` draft controls) and `TeamView` (verified vs pending candidate badges, status filter tabs, rationale & hit/+/- telemetry, inline verify/edit/scope-switch/evaluate/reject/add actions).
  - **Offline Tests**: Added [test/rsi-lifecycle.test.ts](test/rsi-lifecycle.test.ts) and HTTP/SSE RSI integration tests in [test/phase3-server.test.ts](test/phase3-server.test.ts) (44 offline tests passing).
- Raised the default multi-agent matter turn ceiling in `TeamOrchestrator` from 30 minutes (`1,800,000 ms`) to 90 minutes (`5,400,000 ms`, configurable via `PA_TURN_TIMEOUT_MS` / `PA_PROMPT_TIMEOUT_MS`) with explicit timeout duration in the error message, preventing active multi-specialist chains from timing out right before final lead synthesis while preserving `PiRpcWorker`'s 300s inactivity watchdog.
- Proactive meeting-room observer participation (`observerMemberIds` on matters, `PA_CAN_DELEGATE`/`PA_CAN_PUBLISH` restrictions, isolated `observer` Pi session scope, `[SILENT]` no-op filtering vs independent `user`-channel interjections tagged with `observerIntervention: true`, `PATCH /api/matters/:id` observer updates with 409 busy guard, per-speaker avatars/`旁听补充` badges in `ChatStage`, and a meeting-seat selector pill in the composer bar).
- Persisted Pi session continuation scoped by matter, member, workspace path and conversation mode, including restart recovery, scoped handoff context, legacy session lookup and session-header validation.
- Shipped Pi extension with real `delegate_to_member` and `publish_deliverable` tools over an authenticated per-worker loopback bridge. Internal work returns to the caller and stays in collaboration records.
- Actual loading of the 13 initial role Skills, explicit tool selection, delayed capability handshake for dynamically registered tools, and required tool/MCP dependency checks.
- SQLite matter execution ownership, cancellation across delegation trees, bounded delegation depth/count, duplicate-call handling, and orderly service shutdown.
- `npm run demo:team` verifies real Pi model delegation, an actual document, and recall after restarting the host process in a disposable workspace/database. Regression tests cover continuity, isolation, tool transport and failure/cancellation boundaries.

### Changed
- Refactored Phase 4 RSI experience distillation & verification into a multi-role, multi-dimensional, in-context workflow:
  - **Experience Dimensions & Multi-Role Attribution (`src/storage/`, `src/rpc/`, `src/orchestrator/team-orchestrator.ts`)**: Added `category` (`efficiency` | `troubleshooting` | `collaboration` | `user_correction` | `domain_constraint` | `general`) to `member_memories` and `propose_experience` (with SQLite schema migration + backfill); extended `updateMemory` and `PATCH /api/memories/:id` to support reassigning `memberId` and updating `category`; updated `TeamOrchestrator.distillExperiences()` to default to `scopeMode: "team"`, gathering all participating roles (`lead`, `user` speakers, `internal_collab` delegates, observers) plus user corrections, failure/error notices, and interrupted `progressSnapshot`s so candidates are attributed to the specialist who solved or owns each insight (`engineering-manager`, `qa-manager`, `product-manager`, etc.) rather than flattening everything onto the deliverable author.
  - **Cross-Role Evaluation & Server Broadcasts (`src/server/app.ts`)**: Updated `POST /api/deliverables/:id/feedback` to score applied memories across all participating members on the matter, and broadcast `memory_updated` for every affected role when distilling or reassigning experiences.
  - **In-Context Review Loop (`web/src/components/ExperienceReviewPanel.tsx`, `DeliverableCard.tsx`, `ChatStage.tsx`, `TeamView.tsx`)**: Replaced cross-page hunting with shared `InlineExperienceReviewSection`, `ExperienceItemCard`, and `ManualExperienceForm` components embedded directly inside `DeliverableCard` (`本次协作提炼与关联经验` + member/category selectors + explicit scope labels) and `ChatStage`'s floating `经验复盘` header tab (works mid-flight before any deliverable is published), alongside batch-approve (`全部核验通过`), member/category editing, and clickable source links (`查看原对话` / `查看来源成果`) in `TeamView`.
- Switched turn and worker execution timeouts to an activity-driven Goal/Plan-friendly model (Solution A): defaulted `PA_TURN_TIMEOUT_MS` / `PA_PROMPT_TIMEOUT_MS` to `0` (disabling the fixed wall-clock guillotine while work is actively progressing, with positive ms overrides still supported) and raised the inactivity watchdog default from `5` minutes to `15` minutes (`900,000 ms`, configurable via `PA_IDLE_TIMEOUT_MS` or `0` to disable) while keeping `suspendIdleTimeout()` across host-bridged delegations, deliverable publishing, and dialogs.
- Anchored composer popovers (`.quick-prompts-popover`, including the `旁听` member picker and `+` starter prompt menu) with `position: absolute; bottom: calc(100% + 8px)` above `.composer-dock-inner` plus click-outside and `Escape` dismissal, preventing them from resizing the composer dock or shifting the main message stream.
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
