# Changelog

All notable changes to Personal Agent are documented in this file.

## [Unreleased]

- Document when AI leads, consulted members, and observers start or resume their Pi sessions.

- Preserve the model request prefix when matter membership, relevant experience, or repository listings change. Append updated context to the existing Pi session and report cached input for the first request with usage and for the worker turn.

- Answer explicit current-members questions in team discussion from the live matter roster. Give the current roster precedence over older plans in agent prompts.

- Label the new-matter model picker as an action and explain which role settings apply when the lead is matched automatically.

- Show the role that was running when a team discussion failed in its progress snapshot.

- Keep the team discussion draft free of stray `@` when toggling the role picker. Close the picker when clicking outside.

- Show pending human decisions in the matter, with an assigned responder, answer history, and continuation. Route AI colleagues’ questions through their delegator and record who approved each role proposal.

- Route explicit requests to create AI roles to Role Architect in the current matter. Show clarifications as text with an explicit reply, simplify proposal review, and make confirmed consulting roles immediately available in the matter.

- Record independent verification for exact commits, workspace text files, and staged document drafts. Keep reviewed drafts tied to the verified content, show stalled work during execution, and filter the delegation board by branch, member, or review.

- Give each conversation turn a delegation board with numbered assignments and replies. Show live caller-to-member paths, including nested handoffs, and link the graph back to the original assignment.

- Show model settings in anchored popovers and let Role Architect conversations select their own model.

- Filter all model pickers by provider and search by model name or ID. Place the matter model control next to the send button.

- Move provider, model, and thinking settings out of role packages. Configure defaults for the workbench or for each organization role, and override the lead model from the matter composer. Use the service account’s Pi default when no override is set.

- Document prebuilt installation, authenticated team deployment, and contributor setup with the sample-data workbench.

- Organize the [documentation](docs/README.md) around reader tasks. Give first-time users, workbench members, team administrators, and contributors separate entry points.

## [0.6.2] - 2026-11-20

See the [0.6.2 release guide](docs/releases/v0.6.2.md) for downloads and upgrade instructions.

- Reuse Pi’s enabled user resources and trusted repository settings for business turns started by the local owner on a loopback-only personal workbench. Keep inherited-resource sessions separate from explicitly configured sessions.
- Fade between workbench pages, deliverable details and collaboration panels. Keep navigation immediate when reduced motion is requested or the browser lacks View Transitions.
- Group the composer draft and new-matter controls in `ChatStage`. Simplify setup and team instructions while retaining the existing guide links.
- Keep timer ticks inside `ElapsedTimer`. Keep the memoized sidebar independent of streamed text deltas, and skip layout for off-screen matter rows while preserving their focus rings.
- Apply web interface audit fixes: honor `prefers-reduced-motion` for run, step and matter pulse animations, replace `transition: all` with explicit properties, contain scroll chaining in modals, drawers, roster and mention menus, restore a visible focus ring on the roster search, add `name`/`autoComplete`/`spellCheck` to sign-in, registration, invite and pstack URL inputs, set thumbnail dimensions, and use `…` in loading text and placeholders.
- Tighten responsibility boundaries across `ChatStage`, `web/src/utils`, and `PiRpcWorker`: extract per-matter bounded scroll state ([useChatScroll.ts](web/src/hooks/useChatScroll.ts)), participant/roster projection ([useChatStageParticipants.ts](web/src/hooks/useChatStageParticipants.ts)), and abortable attachment preview modals ([AttachmentPreviewModals.tsx](web/src/components/chat/AttachmentPreviewModals.tsx)) out of [ChatStage.tsx](web/src/components/ChatStage.tsx); split [utils.ts](web/src/utils.ts) into domain modules under `web/src/utils/`; and guard [PiRpcWorker](src/rpc/pi-rpc-worker.ts) against overlapping `runPromptAndWait` calls while preserving dynamic `setDialogHandler` updates.
- Commit workspace configuration and restricted access grants together. Reject organization changes for workspaces with matters, experience, execution history, or existing grants. Suppress workspace-private experience when legacy records show conflicting organization ownership.
- Run versioned SQLite migrations in a transaction. Restore legacy workspace and experience foreign keys, preserve saved Git author names, and remove deleted roles from matter rosters.
- Allow one accepted replacement per experience. Keep competing candidates out of execution context until an applicable replacement is verified.
- Split HTTP routes, turn dispatch, web API clients, workbench state and styles into modules by responsibility. See the [architecture inventory](docs/concepts/architecture-and-plan.md#目录组织与源文件行数).
- Switch an organization's primary AI contact without resaving its roster. Preserve existing provider, model, thinking and Git overrides, and save roster and Git policy changes in one transaction.
- Keep delivered matters and saved replies intact if a discussion reply fails. Attribute the failure to the message that started that discussion.
- Append role instructions through Pi's structured prompt options so workspace filtering and later extension contributions are both retained.

## [0.6.1] - 2026-11-19

See the [0.6.1 release guide](docs/releases/v0.6.1.md) for downloads, upgrade instructions, and validation.

- Separate on-demand consultation from observer review. Both can be assigned to the same role, and switching collaboration scope preserves the observer selection.
- Add opt-in AI participation in team discussions with role mentions and separate Pi sessions. Discussion keeps the role's configured tools for checking facts and leaves formal publication and experience proposals to dispatch turns.
- Default AI Git commits to the repository directory's own `git config` identity instead of injecting per-role `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, and add organization-level opt-in `useRoleGitIdentity` toggle (`organizations.use_role_git_identity`, default `false`) plus per-org enabled AI role `gitNameOverride` / `gitEmailOverride` configuration (`organization_ai_roles.{git_name_override,git_email_override}`) across [database.ts](src/storage/database.ts), [organization-repo.ts](src/storage/repos/organization-repo.ts), [org-rbac-repo.ts](src/storage/repos/org-rbac-repo.ts), [worker-runner.ts](src/orchestrator/worker-runner.ts), [prompts.ts](src/orchestrator/prompts.ts), [team-orchestrator.ts](src/orchestrator/team-orchestrator.ts), [deliverables-orgs.ts](src/server/routes/deliverables-orgs.ts), [auth-collaborators.ts](src/server/routes/auth-collaborators.ts), [OrganizationsSection.tsx](web/src/components/team/OrganizationsSection.tsx), [TeamView.tsx](web/src/components/TeamView.tsx), [MemberInspectorModal.tsx](web/src/components/team/MemberInspectorModal.tsx), [utils.ts](web/src/utils.ts), and [account-admin.css](web/src/styles/account-admin.css), verified by [phase2-orchestrator.test.ts](test/phase2-orchestrator.test.ts), [server-collaboration.test.ts](test/server-collaboration.test.ts), and [web-utils.test.ts](test/web-utils.test.ts).
- Add a visible organization-aware Primary Contact switcher directly in the `AI 业务团队成员` header bar and card menu in [TeamView.tsx](web/src/components/TeamView.tsx), [MemberCard.tsx](web/src/components/team/MemberCard.tsx), [MemberInspectorModal.tsx](web/src/components/team/MemberInspectorModal.tsx), [App.tsx](web/src/App.tsx), [utils.ts](web/src/utils.ts), and [team.css](web/src/styles/team.css) (`resolveEffectivePrimaryContactId` & `applyPrimaryContactToMembers`), empowering `org_owner`, `org_admin`, and `super_admin` to switch per-org (`PUT /api/organizations/:id/ai-roles`) or global (`POST /api/members/:id/primary`) primary AI contacts and projecting the active organization's primary contact across team badges, chat header, and new-matter defaults, covered by [web-utils.test.ts](test/web-utils.test.ts).
- Document `npm run start:team:sandbox` preset accounts, CLI flags, seeded deliverable scenarios, and `.data/` vs sandbox verification rules in [AGENTS.md](AGENTS.md), [development.md](docs/guides/development.md), [web/README.md](web/README.md), and [scripts/README.md](scripts/README.md); add `canManage` read-only gating inside [ExperienceReviewPanel.tsx](web/src/components/ExperienceReviewPanel.tsx) (passed from [DeliverableCard.tsx](web/src/components/DeliverableCard.tsx)) so non-managers and `org_viewer` do not see verify/evaluate/edit/reject buttons; add `Cache-Control: no-store` for unhashed built web assets in [http.ts](src/server/http.ts); and use valid `"efficiency"` memory category in [start-team-sandbox.mjs](scripts/start-team-sandbox.mjs).
- Add isolated Team Edition sandbox launcher `npm run start:team:sandbox` ([start-team-sandbox.mjs](scripts/start-team-sandbox.mjs)) and `PA_SESSION_DIR` isolation in [main.ts](src/server/main.ts): seeds a disposable multi-org workbench (`PA_REQUIRE_AUTH=1`) with super admin, pending applicant, `org_owner`/`org_admin`/`org_member`/`org_viewer` accounts, open/restricted repos, `org` & `private` matters, `V1 → V2` multi-version deliverables, feedback ratings, candidate/verified memories, and an org invite link without modifying the standard login UI or `.data/`, covered by [multi-tenant-auth-admin.test.ts](test/multi-tenant-auth-admin.test.ts).
- Add Deliverables Library (`#/deliverables`) organization filtering (`orgFilter` with cascading project filter and visibility scope filter), inline visibility scope switching (`org` / `private` for creators, `org_owner`, `org_admin`, and `super_admin`), org-filtered preview controls, and end-to-end ACL enforcement across `GET /api/deliverables{,/:id}`, feedback/preview stop, memory curation, and RSI distillation (`org_owner`/`org_admin` management, `org_viewer` read-only UI/API gating, `legacy_token` private-matter isolation) in [acl.ts](src/server/acl.ts), [deliverables-orgs.ts](src/server/routes/deliverables-orgs.ts), [memories.ts](src/server/routes/memories.ts), [App.tsx](web/src/App.tsx), [DeliverablesView.tsx](web/src/components/DeliverablesView.tsx), [DeliverableCard.tsx](web/src/components/DeliverableCard.tsx), and [deliverables.css](web/src/styles/deliverables.css), covered by [multi-tenant-auth-admin.test.ts](test/multi-tenant-auth-admin.test.ts).
- Trigger [CI workflow](.github/workflows/ci.yml) only on `pull_request`, `v*` version tags, and manual `workflow_dispatch` instead of running on every push to `main`.
- Isolate Pi worker workspace context from parent host repositories (filtering `before_agent_start` `contextFiles` via `PA_TARGET_WORKSPACE_ROOT` in [team-extension.ts](src/rpc/team-extension.ts), passing `--no-context-files` to isolated JSON/reflection workers in [distiller.ts](src/orchestrator/distiller.ts), [meta-architect.ts](src/orchestrator/meta-architect.ts), and [pi-decision.ts](src/orchestrator/pi-decision.ts), and adding explicit target workspace scope instructions + top-level entry listings via [execution-context.ts](src/orchestrator/execution-context.ts) and [prompts.ts](src/orchestrator/prompts.ts)) so cloned team repositories inside `.data/team-workspaces/` no longer inherit Personal Agent's own root `AGENTS.md`.
- Keep LF line endings in Windows Git checkouts so Biome and the cross-platform checks use the same source files.

## [0.6.0] - 2026-11-18

First public MIT release. See the [0.6.0 release guide](docs/releases/v0.6.0.md) for the feature summary, downloads, and validation scope.

### Team scope, Skill creation, and pstack update reliability

- Apply memory and matter access rules to SSE, memory provenance, and experience review workers. Revalidate account sessions on active streams and close the signed-out session immediately. Legacy uploads now inherit access from the message that references them.
- Keep existing-matter messages on the selected workspace and validate explicitly requested AI roles and observers against the matter's organization.
- Reject duplicate new Skill destinations before creating roles. Preserve existing Skill files and clean up new files if a role package write fails.
- Update the active managed pstack checkout after validating the fetched revision in a temporary checkout. Preserve startup control through `PA_PSTACK_DIR`.

### Team accounts, Super Admin console (#/admin), org RBAC & scoped workspace/matter security

- Fix false `"请先创建或加入一个组织后再创建事项"` error for signed-in non-super-admin users who belong to an organization when starting a `Role Architect` chat or submitting an empty/null org selection ([useMatterActions.ts](web/src/hooks/useMatterActions.ts), [App.tsx](web/src/App.tsx), [ChatStage.tsx](web/src/components/ChatStage.tsx), [ComposerDock.tsx](web/src/components/chat/ComposerDock.tsx), and [matter-messages.ts](src/server/routes/matter-messages.ts)), resolving to the actor's selected or default organization automatically while hiding the `"不归属组织"` option when unauthorized.
- Add multi-tenant AI Role & Skill scoping (`roleScope`: `"global" | "org" | "personal"`) across `.data/roles/` (root `*.md` and `global/` as `global`, `orgs/<orgId>/` as `org`, `users/<userId>/` as `personal`) and `.data/skills/{global,orgs/<orgId>,users/<userId>}/`, supporting optional role-bundle directories (`<scopeDir>/<roleId>/<roleId>.md` + `<roleDir>/skills/<skillName>/SKILL.md`) via [role-package-store.ts](src/roles/role-package-store.ts), [template-loader.ts](src/roles/template-loader.ts), and [capabilities.ts](src/roles/capabilities.ts).
- Add confirmation-before-write `newSkills` draft proposals across [role-architect.ts](src/roles/role-architect.ts), [role-design-decision.ts](src/orchestrator/role-design-decision.ts), [meta-architect.ts](src/orchestrator/meta-architect.ts), [NewSkillsDraftSection.tsx](web/src/components/team/NewSkillsDraftSection.tsx), [RoleArchitectModal.tsx](web/src/components/team/RoleArchitectModal.tsx), [MemberPackageForms.tsx](web/src/components/team/MemberPackageForms.tsx), and [RoleProposalCard.tsx](web/src/components/chat/RoleProposalCard.tsx) so proposed `SKILL.md` files are previewed/edited as toggleable cards and written to disk only after explicit user confirmation.
- Allow active non-viewer `org_member` users to create `personal` roles and Skills within per-user `maxPersonalRoles` quotas (`users.max_personal_roles`, `platform_settings.default_max_personal_roles`, managed in [AdminView.tsx](web/src/components/AdminView.tsx)) while enforcing strict creator-only isolation across bootstrap, `/api/runtime` MCP declarations, Skill `realpath` containment ([execution-context.ts](src/orchestrator/execution-context.ts)), worker delegation, `POST /api/memories`, and SSE broadcasts (`team-memories.ts`, `deliverables-orgs.ts`, `acl.ts`), covered by [test/scoped-roles-and-skills.test.ts](test/scoped-roles-and-skills.test.ts) and isolated browser E2E checks.
- Add super-admin one-click UI enablement for `pstack` under `#/settings/extensions` ([SettingsView.tsx](web/src/components/SettingsView.tsx), `POST /api/admin/runtime/pstack/{enable,disable}` in [admin-auth.ts](src/server/routes/admin-auth.ts), `installOrEnablePstackRepo` in [git-clone.ts](src/server/git-clone.ts)): safely clones `https://github.com/backnotprop/pstack.git` (or validates an existing complete pack) into `<dataDir>/extensions/repo/<repoName>` (default `pstack`), validates `plugin.json` and `skills/poteto-mode/SKILL.md`, persists `platform_settings.pstackDir`, and dynamically applies `orchestrator.setPstackDir` without requiring `PA_PSTACK_DIR` on restart.
- Distinguish personal vs. team edition titles (`Personal Agent · 个人版` vs. `Personal Agent · 团队版`, removing `V4` from `<title>`) and display the matching `.edition-badge` (`个人版` / `团队版`) in [Sidebar.tsx](web/src/components/Sidebar.tsx) based on `PA_REQUIRE_AUTH` across [http.ts](src/server/http.ts), [app.ts](src/server/app.ts), [auth-collaborators.ts](src/server/routes/auth-collaborators.ts), [index.html](web/index.html), and [App.tsx](web/src/App.tsx).
- Add multi-user team authentication (`PA_REQUIRE_AUTH`, `PA_WORKSPACES_ROOT`, `PA_ADMIN_EMAIL`/`PA_ADMIN_PASSWORD`) with salted `scryptSync` password hashing, SHA-256 opaque session tokens, `Origin`/`Host` CSRF validation, sliding-window login/register rate limiting, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and audit logging in [user-auth-repo.ts](src/storage/repos/user-auth-repo.ts), [auth.ts](src/server/auth.ts), and [admin-auth.ts](src/server/routes/admin-auth.ts).
- Add the Super Admin console (`#/admin` via [AdminView.tsx](web/src/components/AdminView.tsx)) and multi-mode auth gate ([AuthGateView.tsx](web/src/components/AuthGateView.tsx), [App.tsx](web/src/App.tsx)) supporting first-run super-admin bootstrap (including seamless in-place `usr_local_owner` upgrade when transitioning from local loopback trial to `PA_REQUIRE_AUTH=1`), open email+password registration defaulting to `open_review` (`open_review` / `open_auto` / `invite_only`), `GET /api/auth/invite-preview` & interactive invite switch/register modal when opening `?invite=orginv_...` in an already-authenticated browser (plus idempotent non-decrementing `consumeOrgInviteByToken` for existing members), explicit `loopback` vs `session` vs `legacy_token` switcher UX in [Sidebar.tsx](web/src/components/Sidebar.tsx), user approval/disable & quota controls (`maxOrgs`, `maxActiveDispatches`, `canDispatchAi`), active matter force-abort, security audit log viewer, and platform security boundaries.
- Add self-serve organization creation and per-org RBAC (`organization_members`, hashed `organization_invites`, `organization_ai_roles`) in [org-rbac-repo.ts](src/storage/repos/org-rbac-repo.ts), [OrganizationsSection.tsx](web/src/components/team/OrganizationsSection.tsx), and [team-orchestrator.ts](src/orchestrator/team-orchestrator.ts), allowing any active user within quota to create organizations, configure human members/invites, select which AI roles & primary contact are enabled per org, and allow `org_member` users with `canDispatchAi` to trigger AI directly inside authorized scope.
- Add scoped multi-team Git repository cloning (`<workspacesRoot>/<orgSlug>/`, blocking `file:` / `ext::` / flag injection in [git-clone.ts](src/server/git-clone.ts)) alongside admin-controlled local path allowlists (`allowLocalWorkspacePath`, `localWorkspaceAllowlist`), workspace visibility (`org` / `restricted` via `workspace_members`), matter visibility (`org` / `private`), upload file ACLs (`uploads_index`), and recipient-scoped SSE filtering ([acl.ts](src/server/acl.ts), [sse.ts](src/server/sse.ts)), verified by [test/multi-tenant-auth-admin.test.ts](test/multi-tenant-auth-admin.test.ts).

### Unified composer window, file/image uploads & large-paste folding

- Unify [ComposerDock](web/src/components/chat/ComposerDock.tsx), [ChatStage](web/src/components/ChatStage.tsx), and [chat-composer.css](web/src/styles/chat-composer.css) into one consistent `.composer-card` container across new matter, existing matter idle, Role Architect, and running states (showing an integrated `.composer-run-banner` with live elapsed time, quick switch-to-discussion action, and abort control while running; removing the old `+` starter-prompt popover and merging files + images onto the single `+` button).
- Add UTF-8 text/code file uploads and automatic folding for large pasted text (`>= 600` chars or `>= 10` lines) via [imageAttachments.ts](web/src/imageAttachments.ts), [App.tsx](web/src/App.tsx), [MessageFeed.tsx](web/src/components/chat/MessageFeed.tsx), and [ModalDialog](web/src/components/ModalDialog.tsx) (supporting click-to-preview, copy, and restoring folded paste drafts back into the textarea).
- Persist text/pasted-text `files` alongside `images` across [uploads.ts](src/server/uploads.ts) (serving `.txt` uploads with `text/plain; charset=utf-8` and `X-Content-Type-Options: nosniff`), [matter-messages.ts](src/server/routes/matter-messages.ts) (including `approve-ai` attachment reload & `hasFiles` assessment support), [dispatch-runner.ts](src/server/dispatch-runner.ts), [team-orchestrator.ts](src/orchestrator/team-orchestrator.ts), and [prompts.ts](src/orchestrator/prompts.ts), with tests in [test/server-rsi-and-uploads.test.ts](test/server-rsi-and-uploads.test.ts) and [test/web-utils.test.ts](test/web-utils.test.ts).
- Prevent `.stage-header` left organization/workspace pills from truncating prematurely on desktop viewports by letting `.stage-center-pill` flex-shrink first in [ChatStageHeader.tsx](web/src/components/chat/ChatStageHeader.tsx) / [shell.css](web/src/styles/shell.css), align `.header-more-btn` and `.header-humans-btn` to a consistent `30px` height, and auto-dismiss `.notice-card` banners after 4.5 seconds (pausing while hovered or focused) in [App.tsx](web/src/App.tsx).

### Settings subpage (Agent base, extensions & live configuration)

- Add `resolveBuiltinExtensionPath`, `probePiCli`, and `buildRuntimeOverview` in [src/orchestrator/runtime-info.ts](src/orchestrator/runtime-info.ts), expose `TeamOrchestrator.getRuntimeConfig()` and server `runtimeMeta`, and serve `GET /api/runtime` (with injectable `probePiCli`, sectioned live configuration mirroring `docs/configuration.md`, and host path redaction for non-owner collaborators).
- Add the categorized `#/settings` subpage (`#/settings`, `#/settings/base`, `#/settings/extensions`, `#/settings/config` across [SettingsView.tsx](web/src/components/SettingsView.tsx), [Sidebar.tsx](web/src/components/Sidebar.tsx), [hashRouter.ts](web/src/hashRouter.ts), [useHashRouteNav.ts](web/src/hooks/useHashRouteNav.ts), and [App.tsx](web/src/App.tsx)) with concise cards for Pi CLI base status, mounted Pi Extensions (`team-extension`, `pstack-extension`, `builtin:mcp`, and `PA_PI_EXTENSIONS`), collapsible isolation policies, and sectioned configuration items (`环境变量与服务`, `目录与存储位置`, `Pi RPC 与桥接参数`, `编排、旁听与工作台边界`).
- Add offline tests in [test/runtime-settings.test.ts](test/runtime-settings.test.ts), extend `#/settings/*` route coverage in [test/phase3-server.test.ts](test/phase3-server.test.ts), and link live configuration inspection in [docs/configuration.md](docs/reference/configuration.md).

### Built-in role and Skill instruction language

- Write the 15 built-in Skills and their task triggers in English. Bump the four business templates and the Role Architect to 1.1.1 with English display names, headings, instructions, and boundaries. Continue reading legacy Chinese section headings.
- Assemble worker prompts in English and ask for replies and deliverables in the user's language. Preserve Chinese role aliases and responsibility signals in routing and local initiation scoring. Skills are discoverable by name and description.
- Hide redundant `roleTitle` subtitles on `MemberCard` when identical to `displayName`, allow two-line wrapping on sidebar `.roster-name` tiles for multi-word English role names, align `test/rsi-lifecycle.test.ts` with English memory status prompt labels, and refresh `docs/assets/workbench-home.png` and `docs/assets/workbench-team.png`.

### Post-a1706c5 reliability follow-up

- Preserve the local `.notes` archive decision and the lighter team/new-matter layouts. Add keyboard focus, arrow/Home/End navigation, Escape return and Tab dismissal to member menus; show role details first when no experience exists. Hide organization mutations from collaborators to match existing server authorization.
- Move operation notices from the chat-only feed to the shared app layout, and catch primary-contact/export failures so management errors are visible on the page where they occur.
- Force isolated startup checks to bind loopback regardless of inherited `PA_HOST`. Exercise IPC shutdown on Unix memory cases as well as SIGTERM on file cases; Windows keeps IPC shutdown. Invoke npm via its Node CLI during packaging to avoid executing `npm.cmd` directly on Windows.
- Add Node 22.19/26 Unix CI coverage, least-privilege workflow permissions, job timeouts and Windows preview packaging. Local macOS tests cover Node 22.19.0/26.10.0 and Chrome owner/collaborator interactions; Linux/Windows runner results are not claimed.

### UI cognitive load reduction

- Simplify `MemberCard` on `#/team` by removing nested Git/memory count boxes and multi-row tag walls in favor of role identity, primary duty summary, a single-line tool/boundary/model caption, `向 TA 派活`, `详情与经验`, and a `···` action menu (putting full responsibilities, Skills, Anti-Jobs, Git Author identity, and memories inside `MemberInspectorModal`).
- Reorder `#/team` (`TeamView`) so `AI 业务团队成员` sits at the top of the page while `CollaboratorsSection` and `OrganizationsSection` sit below as collapsible summary strips.
- Remove duplicate header org/workspace pills on new-matter creation (`ChatStageHeader`), merge the new-matter mode switch and borderless org/workspace selects into one top bar inside `ComposerDock`, center `.stage-center-pill` symmetrically, unify `Sidebar` footer badges (`我的团队` numeric count and solid border on the `角色架构师` entry), and refresh `docs/assets/workbench-home.png` and `docs/assets/workbench-team.png`.

### CI, cross-platform & UI polish

- Add `.github/workflows/ci.yml` (`ubuntu-latest` and `macos-latest` full offline gates plus `package:release -- --preview` dry runs; `windows-latest` check, build, startup smoke, docs, and opensource audit) and GitHub Bug/Feature/PR templates (`.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`).
- Add Windows directory `"junction"` symlink handling in `scripts/check-server-startup.mjs` and `scripts/package-release.mjs`, plus IPC `"shutdown"` handling in `src/server/main.ts` alongside POSIX `SIGINT`/`SIGTERM`.
- Fix `:disabled` button contrast in `web/src/styles/primitives.css`, allow multiline and new-matter `.pill-composer` textareas in `web/src/styles/chat-composer.css` to span full inner width above the action bar, and tune `.team-grid` in `web/src/styles/team.css` to render 3 columns at `1280px` desktop width.
- Verify the isolated sandbox workbench in Chromium across desktop (`1280x840`) and mobile (`420x840`) viewports with 0 console/HTTP errors, and add sanitized screenshots (`docs/assets/workbench-home.png`, `docs/assets/workbench-team.png`) to `README.md`.

### Local notes isolation

- Keep early V1–V4 prototypes and research notes in the ignored `.notes/` directory. Preserve the local commit history and omit these materials from the public history.

### Open-source documentation

- Make local Pi CLI an explicit required AI runtime dependency, point users to pi.dev for product information and platform-specific installers, and place Pi setup before workbench startup. Keep the tested Pi version separate from installation requirements and from Personal Agent platform validation.
- Reorganize the project README around the product, a concrete collaboration example, current capabilities and limits, and reader-specific entry points. Add installation, everyday use, design rationale, development, contribution and security guides.
- Document Pi/model setup, actual participation modes, version feedback, partial data-path overrides, local execution privileges and network exposure. Clarify early product questions against current implementation; retain historical prototypes and evaluation failures.
- Document the public repository and the private GitHub security reporting channel.
- Extend the read-only documentation check to all repository Markdown, including usage and contribution guides, role methods and historical references, with local-link, anchor, command and root-navigation checks.

### MIT release

- Release 0.6.0 under MIT and retain npm `private: true`. Include the project license, pstack adaptation attribution, and bundled React runtime notices in the release.
- Use official reference links and exclude three third-party reference images from the public history and downloads.
- Add a read-only current/history audit with redacted finite credential checks and a stricter public-scope option. Share private-path guards with the packager, require legal notices in archives, and copy notices into web output. Generalize developer-specific paths and prior business-project names in current documentation.
- Add `package:release -- --preview` for commit-scoped source/prebuilt previews, isolated builds and extracted startup checks without occupying the final version directory, changing tags or publishing externally.
### Natural pstack method selection

- Add isolated `demo:pstack:selection` with five natural requests that never name the expected methods. Keep the current runtime guidance unchanged; report actual method reads, read-only integrity and independently reviewed answers separately. Include genuine session continuity and conflicting old proposals for the context-recovery case.
- Preserve raw turns and hash-bound review templates, support model-free summarization and single-case runs, and restrict demo reads to its own temporary project/sessions and approved methods. Offline regressions cover prompt leakage, read boundaries, full-source evidence, binary hashes and pending/invalid reviews. Missing target selection is reported without calling the answer semantically wrong.
- Run all five natural cases with unchanged production guidance: the mode is read in four target turns, none of the five named target Skills is observed, and three other principles are selected. Runtime integrity and session continuity pass; separate host-side, unblinded review passes four answers and fails the technical design for conflicting expiry and permanent uniqueness rules. Retain the failed baseline and fix the demo guard's missing-file feedback separately, without claiming a routing or quality improvement.
### pstack in the Pi inner loop

- Add optional `PA_PSTACK_DIR` / `pstackDir` integration with a complete external pstack pack, reusing the cross-harness mirror's actual mode, playbooks and principles. Register a bounded Markdown method reader in Pi, expose source hashes and require the method tool in the runtime capability handshake. General business tools and team permissions stay scoped to the existing role and matter.
- Add isolated `demo:pstack` with a no-filesystem product discussion and a real deterministic countdown defect, fixed tests, source preservation and actual method-read checks. Retain the first failure: the code was repaired, but named principles had not been read. Improve resource navigation and per-worker read state, then rerun the same tasks; method reads alone are not quality evidence.
- Retain the second failed run after navigation-only changes. Resolve the root-cause and verification leaf methods as real resources when loading the bug-fix playbook; the third same-task run passes. Re-evaluate all three with full source text plus hashes: the first two still fail. All three repaired the defect, so this establishes method delivery rather than improved repair quality or stable autonomous method selection.

### Bot and plugin research

- Compare local pstack 0.15.42 and Cole Skills 1.10.1 with their public manifests and Grok Bot/plugin pages. Document reusable methods, platform dependencies, project-specific verification templates, and the distinction between persistent members and packaged subagent definitions. Record proposed adoption steps without installing packages or claiming runtime or quality improvements.

### Decision contracts and evidence follow-up

- Follow `5001069..fca5970` without replacing the completed initiation UI. Preserve explicit role IDs, verification plans, constraints, Anti-Jobs and Skill dependencies in model-generated designs; missing explicit Skills remain visible in capability reports. Model-suggested Skills are still limited to the installed catalog. Constraints now coexist with verification plans in both design modes.
- Separate read permission (`repoReadEnabled`) from completed workspace reads (`usedRepoRead`, `repoReadPaths`). Ignore failed, unfinished and out-of-workspace reads, including symlink escapes. The UI shows actual read paths or the lack of successful evidence; `demo:decision` now requires successful reads of both sample entry files.
- Wrap throwing schema validators in `PiDecisionError` with `validation_error`, preserving the cause and raw output after worker cleanup. Add regressions for these three failure cases and HTTP preservation of explicit design requirements; no additional user approval step is introduced.

### Typed Pi LLM Decision Model for Initiation Assessment (`typesafe-ai` style)

- Add a reusable typed structured decision runner over Pi RPC ([src/orchestrator/pi-decision.ts](src/orchestrator/pi-decision.ts): `runTypedPiDecision`, `extractJsonObject`, `PiDecisionError`), executing isolated stateless turns (`noSession: true`, `thinkingLevel: "low"`, `--no-extensions`, `--no-skills`, `--no-mcp`, `--tools ""` or optional read-only `["read"]`), enforcing schema + live business member ID validation, and propagating `AbortSignal` cleanup.
- Add `assessMatterInitiationWithModel` (`src/orchestrator/matter-initiation.ts`, `TeamOrchestrator.assessInitiationWithModel`) and upgrade `POST /api/matters/assess` (`src/server/routes/matter-messages.ts`) to support explicit owner-only `mode: "model"` + optional `readRepo: true` with `responseCancellation`, strict `validateInitiationModelDecision` rejection of invalid enums or hallucinated member IDs (502), and provenance metadata (`assessmentSource`, `confidence`, `usedRepoRead`), while keeping `mode: "rules"` instant for typing.
- Add opt-in `请 AI 决策阵型` control in [MatterInitiationPanel.tsx](web/src/components/chat/MatterInitiationPanel.tsx) / [useMatterInitiationState.ts](web/src/hooks/useMatterInitiationState.ts) with explicit secondary confirmation, optional read-only repo inspection toggle, live `取消分析` abort button, provenance badges (`AI 决策建议` vs `本地规则`), and non-destructive fallback preserving local rule suggestions on error.
- Add AI Role Designer (`designRoleDraftWithModel` in [role-design-decision.ts](src/orchestrator/role-design-decision.ts), `mode: "model"` on `POST /api/members/design`, and confirmation/abort UI in [RoleArchitectModal.tsx](web/src/components/team/RoleArchitectModal.tsx)) plus isolated real-Pi verification script `npm run demo:decision` ([src/demo/decision-smoke.ts](src/demo/decision-smoke.ts)).
- Fix Markdown table column crushing and multi-line task composer UI ([deliverables.css](web/src/styles/deliverables.css), [chat-stream.css](web/src/styles/chat-stream.css), [chat-composer.css](web/src/styles/chat-composer.css), [ComposerDock.tsx](web/src/components/chat/ComposerDock.tsx)): drop forced `white-space: nowrap` on `.md-table td:last-child`, add wrapping on `.md-inline-code` / `.md-link`, preserve balanced first-column widths on 2-column summary tables, widen AI Markdown bubbles cleanly, remove the jagged `:focus-visible` box inside `.pill-textarea`, and auto-resize multi-line composer inputs (`is-multiline`) without cramped inner scrollbars.

### New matter initiation UX & rule transparency

- Refine `assessMatterInitiation` (`src/orchestrator/matter-initiation.ts`) so negative `不做`/`不负责` clauses are excluded from positive keyword matching and domain coverage checks, drop generic false-positive gap alerts when no concrete domain gap rule matches, keep single-lead tasks scoped to `solo` when appropriate, and surface transparent human-readable local-rule basis notes (no LLM call or repo inspection).
- Rework new-matter creation layout (`ChatStage.tsx`, `ComposerDock.tsx`, `MatterInitiationPanel.tsx`, `useMatterInitiationState.ts`, `useMatterActions.ts`, `chat-composer.css`) into a centered creation card: clearly display actual active participation setup alongside optional local-rule suggestions with collapsible basis details (`为什么这样建议？`), fold granular AI/human toggles behind `调整参与方式`, pass `AbortSignal` + fallback notice on `/api/matters/assess`, sync observer state cleanly without stale `pa.defaultObserversEnabled` overrides, and scope `lead_review` presets to lead + targeted observers only.

### Role methods and capability composition

- Update all four baseline business roles and the built-in architect to definition version 1.1.0 with concrete methods, communication, Anti-Jobs and evidence-based handoff criteria. Enrich the product, engineering, QA and market methods and add the architect's actual `role-design` method.
- Preserve selected Skills, MCP declarations, communication and verification plans across design, proposal application, creation and export. Expose installed method inventory and distinguish missing/present files from runtime-unverified integrations; no dependency installation or quality guarantee is implied.
- Ground health findings in bounded source IDs and original excerpts, filter invented references and expose source navigation. Keep no-issue reports empty when appropriate, and enforce the architect's no-team-tool boundary in the host.
- Add isolated `demo:architect` and `demo:roles` with frozen synthetic tasks, real proposal application, actual role execution, file preservation and independent transcript-bound review. Help/summarize are model-free; pending review returns 2, observed failure returns 1.
- Real runs exposed structured verification plans being silently discarded. Preserve complete task/criteria/boundary objects and show missing-plan state; add an actual regression. Preserve initial failed evidence and rerun the same tasks: the created role passes targeted review after the fix, while product/market judgments and engineering coverage claims still have failures. Twelve real lead turns do not establish general improvement or stability.

### Documentation

- Revisit dr eggbot's public listing against the implemented Role Architect. Document gaps in skill/dependency composition, evidence-linked healthchecks and real-task verification, with a proposed isolated smoke scenario; no runtime capability or scheduled task is added.

### Member management reliability

- Validate role IDs before using them as filenames. Reject invalid thinking levels and multiline creation metadata, protect the built-in architect from replacement, and return 409 for explicit creation ID conflicts. Role files use staged writes and atomic replacement instead of following an existing destination symlink.
- Prevalidate member creation and role adjustments together before applying a proposal. Serialize role mutations within one server, reject repeated adjustments, and prevent duplicate or dismissed proposals from being applied. Validation failures leave the team unchanged; this is not a crash-safe transaction across SQLite and the filesystem.
- Persist role deletion markers so startup does not recreate removed baseline roles. Explicit creation/import restores a removed role; primary contact, architect and historical delivery/lead protections remain in place.
- Isolate `PA_DB_PATH=:memory:` role writes in a temporary directory. Add seven offline regressions for invalid paths, collisions, partial validation, concurrent application, symlink writes and database reopen; expand startup checks to source/compiled entry points with file and memory databases.

### Added & Refined
- **Matter Initiation Framing, Scoped Participation & Role Architect (`dr-eggbot-v2` 启发)**:
  - **立项适配评估与缺口识别 (`src/orchestrator/matter-initiation.ts`, `POST /api/matters/assess`)**：发起新事项前评估当前团队角色匹配度、推荐参与方式（单兵直办 `solo` / 主责+指定协同 `lead_consult` / 主责+定向旁听 `lead_review` / 人类先对齐 `human_first`）及人类协同人选；识别出职责覆盖缺口时不再静默兜底给默认产品经理，而是明确提示并引导按需设计或转为人类先讨论。
  - **精细化参与人数与运行时约束 (`MatterRepo`, `worker-runner.ts`, `prompts.ts`, `MatterRosterPopover.tsx`)**：修复 `createMatter` 同时传入 `observersEnabled` 与 `observerMemberIds` 时覆写为全员旁听的问题，支持发起前与运行中对单个非主责 AI 切换定向旁听；事项收窄为单兵模式（1 AI）时，在 `--tools` 与系统提示词同步禁用 `delegate_to_member` 并注入单兵引导与显式 `antiJobs`（不做清单）。
  - **Meta-Bot 对话式角色架构师与团队体检闭环 (`src/orchestrator/meta-architect.ts`, `POST /api/members/architect/chat`, `POST /api/members/batch`, `POST /api/members/adjustments/apply`, `MetaArchitectChatPane.tsx`)**：对照 `dr-eggbot-v2` 升级为可多轮追问、无工具只读隔离运行（`--tools ""`）的 Meta-Bot 架构师；按流程规划时可产出 `1~N` 个互补角色及建议人机协作阵型，团队体检时返回结构化健康检查卡（`healthFindings`）与可勾选执行的已有成员调整提案（`roleAdjustments`，支持收窄工具权限或补充 Anti-Jobs 并写入角色定义，屏蔽无关事项阵型），所有变更均需用户勾选确认后生效。同时将角色工具权责标签拆分为 `可改代码` / `含命令` / `只读` / `纯文稿` 四档（`formatRoleToolTierLabel`）。
  - **将「角色架构师」统一为一等 AI 角色与事项中途建角 (`BUILTIN_ROLE_ARCHITECT_TEMPLATE`, `POST /api/matters/:id/messages/:msgId/apply-role-proposals`, `RoleProposalCard.tsx`, `MatterRosterPopover.tsx`)**：
    - `角色架构师` 现作为内置元角色直接呈现在侧边栏名录与工作台对话体系中（不加入 `roles/` 业务模板目录，亦从普通业务事项的自动关键词路由、默认全员 AI 池与自动旁听列表中隔离）；点击即可创建支持完整持久化的建队规划与团队体检事项。
    - 任意进行中的业务事项均可通过右上角「协作成员 → 请角色架构师介入补人」中途请入架构师只读诊断；回复自动解析为内联提案确认卡（`metadata.roleProposals`），所有者勾选确认后不仅应用角色新增/权限收窄，还可一键以「内部协同 / 定向旁听 / 主责接手」身份直接将新角色加入当前事项继续推进。
  - **引导式角色设计官 (`src/roles/role-architect.ts`, `POST /api/members/design`, `RoleArchitectModal.tsx`, `MemberCard.tsx`)**：保留离线可用的快速 4 问规则直出（One Job / Explicit Anti-Jobs & 静默原则 / 协作站位 / 最小工具集），默认收紧非工程角色工具权限（不再硬编码 `bash`），并在 `buildStarterTasks` 中补全非代码工作流与人类先讨论起手式。
  - **界面收口、成员生命周期与慢速 AI 操作治理闭环 (`TeamView.tsx`, `TeamHealthcheckPanel.tsx`, `MemberInspectorModal.tsx`, `MemberCard.tsx`, `RoleArchitectModal.tsx`, `ExperienceReviewPanel.tsx`, `MatterRosterPopover.tsx`, `MatterInitiationPanel.tsx`, `src/orchestrator/meta-architect.ts`, `src/roles/template-loader.ts`, `DELETE /api/members/:id`)**：
    - **团队页与架构师对话职责解耦**：精简 `TeamView` 顶部入口，统一收口为「请角色架构师对话规划」与「+ 快速创建角色」；`角色架构师` 作为全局建队工具默认不绑定具体组织或仓库，隐藏底部组织/仓库选择器，仅保留按工作流规划角色等全局建队提示；将「团队协作体检」从架构师对话中分离，留在 `TeamView` 内就地发起且不占用近期事项列表。
    - **管理页与新建/导入操作全面弹窗化 + 慢速 LLM 二次确认 (`ModalDialog.tsx`, `TeamHealthcheckPanel.tsx`, `MemberInspectorModal.tsx`, `MemberPackageForms.tsx`, `CollaboratorsSection.tsx`, `OrganizationsSection.tsx`, `MaterialsView.tsx`, `ExperienceReviewPanel.tsx`)**：提取统一居中弹窗壳组件 `ModalDialog`（支持 Esc 关闭与统一页眉/页脚排版），将「团队协作体检」「成员编辑身份与管理经验」「+ 新增邀请同事」「+ 新建/编辑组织身份」「导入/导出角色能力包」及资料页「+ 登记项目仓库」全部从页面内联展开收口为独立聚焦弹窗，彻底避免长表单撑破主网格布局；点击「团队协作体检」或「AI 复盘提炼团队经验」前均需二次确认，执行中保留 `AbortController` 取消入口。
    - **支持安全删除非默认团队成员 (`DELETE /api/members/:id`, `MemberRepo.deleteMember`)**：为 `MemberCard` 补齐二次确认删除入口，同步清理该成员的经验记忆与关联旁听配置（禁止删除默认主联系角色）。
    - **快速创建角色预览表单完善 (`RoleArchitectModal.tsx`, `role-architect.ts`)**：去除硬编码站位卡片对用户自定义表达的限制，开放完整可编辑预览区（角色名/英文代号/头衔/所属领域/核心定位与协作关系、核心职责与不做边界等），让快速直出角色真正按用户表单意图生效。
    - **事项协作成员浮层、立项配置与运行时角色命名修复 (`MatterRosterPopover.tsx`, `MatterInitiationPanel.tsx`, `RoleProposalCard.tsx`, `template-loader.ts`, `meta-architect.ts`)**：修复成员浮层行布局错乱与长名截断问题，简化新事项立项时的协作配置展示；强制结构化 `id`（kebab-case 英文代号）与 `name`（简短中文称谓 ≤16 字）命名校验与预览清洗，并将运行时自建角色独立持久化至 `.data/roles/`（不再污染仓库 `roles/` 模板目录）。

## [0.5.0] - 2026-11-16

本地发布版本，统一包元数据为 0.5.0。包含跨项目岗位团队工作台、作用域会话接续与真实委托、旁听、显式阶段成果和基础 RSI 链路，并补齐组织隔离、文件来源发布及真实任务演示。发布范围、启动方式和已知限制见 [0.5.0 发布说明](docs/releases/v0.5.0.md)。

### Observer demo

- Add `demo:observer`, a real-Pi, isolated five-turn task covering selected late-joining observers, an intentional conflicting proposal, lead follow-up and stage publication, independent quiet review, and disabling observation.
- Retain original worker replies, session/loadout evidence and a full transcript. Separate runtime/behavior checks from independent quality review, reject empty/failed evaluations as successful silence, and support model-free `--help` / `--summarize`.
- Real validation completed five lead turns and three observer assessments with late-join context, risk intervention, lead continuation, quiet review and disabling checks passing. Independent observer review passed with retained design caveats; source/compiled offline summaries match and 107 offline tests pass. Preserve the initial presentation-wrapper false negative and validate proposal text separately from recording wrappers.

### Review evaluation

- Split `demo:review` into publication checks, scenario-specific collaboration, and independent final-document quality judgments. Add autonomous, explicitly required cross-role, and solo copy-edit scenarios without imposing a product-wide sign-off workflow.
- Add isolated repeated pairs with alternating policy order, per-scenario counts and reviewed criterion differences. Pending, invalid and missing reviews remain visible; consultation frequency is not a quality score.
- Bind independent reviews to final published snapshots and validate criterion coverage, explanations and exact line citations, including new blocking issues. Add model-free `--help` and `--summarize`; exit 2 means incomplete review, 1 means observed failures, and 0 requires all layers reviewed and passed. Preserve earlier evidence unchanged.
- Real three-scenario validation completed six lead turns: publication passed throughout and required consultations occurred, while independent review found three passing and three failing documents. Preserve the failures and counterexamples; source/compiled offline summaries match, and 102 offline tests pass. This does not establish repeated-run stability or improved role capability.

### Fixed

- Publish saved documents with mutually exclusive `sourcePath`/inline `content` inputs. The host reads exact UTF-8 file text and checks its path/content snapshot again before successful commit, rejecting stale, missing or redirected sources rather than archiving divergent text.
- Replace a same-title document draft on re-publication within a turn while retaining cross-turn versions. Keep existing inline documents and other deliverable types supported.
- Make inner/review demos publish through file sources and check exact text equality; preserve the failed paired run and add regressions for source validation, history snapshots, stale/deleted files, symlinks and re-publication.

### Documentation

- Record the built-in demo artifact review and prioritize evidence accuracy and design/acceptance consistency. Clarify that four recorded stages establish workflow evidence, not accepted output quality or a tested business application.

### Added

- Add lead-only pre-publication review guidance and `demo:review`, an isolated real-Pi baseline/current comparison with fixed contradictory design inputs, tool-order evidence, preserved history and an independent full-text review rubric. Mechanical checks do not automatically certify output quality.
- First real comparison observed specialist consultation before publication, but retained final-document state/migration contradictions. Record the failures and counterexamples rather than treating tool success as quality acceptance.
- Label the demo's default revision feedback as a fictional usage scenario rather than an actual trial; preserve any feedback already saved by the user.
- Added an opt-in built-in feedback-box matter with a separate Git workspace at `.data/inner-matter`, an isolated demo organization, and four editable prompts for discussion, real specialist consultation, V1 delivery and feedback-driven V2 revision. Preparation calls no model and fabricates no history or deliverables.
- Preserve existing files, Git state, feedback and versions on reopen. Derive guide progress from normal persisted execution evidence; keep existing acceptance text and ratings when preparing revision input.
- Added isolated regression coverage, source/compiled startup checks for the demo endpoint, and opt-in `demo:inner` real-Pi walkthrough with retained evidence.
- Fixed a stop/cleanup race discovered during final regression: `abortMatter` now waits for the execution lease to be released before returning, so an immediate organization/workspace switch can proceed.

### Reliability follow-up after `1f68160`

- Include organization identity in `v2` native-session keys and persist organization provenance on new messages. Filter chat handoffs, observer backgrounds, interruption briefs and reflection evidence by that scope; include organization memories in workspace-less reflection and reject results if the organization changes.
- Keep legacy `v1`/unscoped sessions and messages archived without guessing their organization. The first upgraded turn starts a fresh scoped session; subsequent turns resume its exact file.
- Atomically transition only pending human AI requests to approved/dismissed. Validate scope, member and attachments before approval; reject repeat handling with 409 and unavailable attachments with 410.
- Reject overlapping dispatches after asynchronous uploads without overwriting active progress, and prevent organization reassignment of a workspace with active turns.
- Update architecture and module guides against the 26 commits after `793b46b`; add isolated regressions for organization scope and request lifecycle.

### Refactored & UI/UX
  - **Page Polish, Markdown Summary Stripping & Visual Consistency**:
    - Added `stripMarkdownFormatting` (`web/src/utils.ts`) and applied it in `parseDeliverableSummary`, `Sidebar`, and `MemberCard` so card/sidebar previews render crisp plain text instead of raw `#`/`**`/`` ` ``/`-` Markdown syntax.
    - Switched keyboard vs pointer focus outlines to `:focus-visible` (`web/src/styles/tokens.css`), standardized `36px` form control heights (`select-control` + `.workspace-bind-grid`), and refined `MaterialsView` (`subpage-inner wide`, active workspace row highlighting + `当前已选` pill, and one-click `copyTextToClipboard` path copy).
    - Upgraded `TeamView` (`CollaboratorsSection`, `MemberCard`, `primitives.css`, `views.css`) to equal-width card grids (`.org-chip-list`, `.collab-humans-list`), bottom `.org-chip-actions` row, non-wrapping status pills (`5 已验证`), single-line ellipsis Git Author/Committer pills with full-text `title` tooltips, 2-line responsibility clamps, capped skill chips (`+N`), and bottom-aligned `.member-card-footer` actions; widened `.md-table` status columns (`deliverables.css`) and collapsed duplicate `.stage-center-pill` under `<= 720px` (`responsive.css`).
  - **Responsive & Narrow-Screen Shell (`<= 960px` / `<= 720px` / `<= 640px`)**: Switched `.bot-shell` tracks to `minmax(0, 1fr)` with `min-width: 0` across `.bot-sidebar`/`.main-stage`/`.compact-row`/`.feedback-row`/`.exploring-block`/`.team-grid` to eliminate horizontal overflow and right-edge clipping, and upgraded `< 960px` viewports from a full-height stacked sidebar to a sticky `mobile-topbar` + slide-over navigation drawer (`App.tsx`, `Sidebar.tsx`, `responsive.css`).
- Unified web page layout, sectioning, semantic heading hierarchy, and typography scale (`web/src/styles/tokens.css`, `primitives.css`, `shell.css`, `chat-stream.css`, `chat-composer.css`, `chat-roster.css`, `deliverables.css`, `views.css`, `responsive.css`, and views under `web/src/components/`):
  - Added `--text-micro`/`--text-xs`/`--text-sm`/`--text-base`/`--text-md`/`--text-lg`/`--text-xl`/`--text-2xl` font-size tokens and `--page-pad-*`/`--content-*`/`--section-gap` layout tokens in `tokens.css`, consolidating 13 ad-hoc pixel sizes and unifying horizontal padding (`28px`) and column widths (`840px`/`1160px`) across chat and subpages.
  - Introduced `.ui-sections-stack`, `.ui-section`, `.ui-section-head`, `.ui-section-title`, `.ui-section-desc`, and `.ui-card` primitives in `primitives.css`, replacing overloaded `.deliverable-card` usage on forms/empty states (`MaterialsView`, `MemberPackageForms`, `DeliverablesView`).
  - Normalized heading hierarchy (`<h1>` welcome hero & subpages → `<h2>` section/deliverable/form titles → `<h3>` card/approval/experience sub-headings; `.md-h1/.md-h2/.md-h3` stepped cleanly above `14px` body prose), added a titled AI members section to `TeamView` and registered-workspaces section to `MaterialsView`, adjusted `deliverables-master-col` sticky height (`calc(100vh - 112px)`), and added a `<= 640px` mobile breakpoint in `responsive.css`.
- Modularized all >1,000-line source, style, and server-test files so every file across `src/`, `web/src/`, `test/`, and `scripts/` stays under 1,000 lines while keeping public exports and behavior identical:
  - **Web Design System & Frontend Components/Hooks**: Split `web/src/styles.css` into 9 domain stylesheets under `web/src/styles/` (`tokens.css`, `primitives.css` `.ui-*` controls, `shell.css`, `chat-stream.css`, `chat-composer.css`, `chat-roster.css`, `deliverables.css`, `views.css`, `responsive.css`), and extracted modular components (`AuthGateView`, `chat/*`, `team/*`), `web/src/clipboard.ts`, and hooks (`web/src/hooks/{useHashRouteNav,useMatterEventSync,useMatterActions,useRsiDistill}.ts`).
  - **Storage, Server & Orchestrator**: Split `src/storage/repositories.ts` into domain repositories under `src/storage/repos/`, split `src/server/app.ts` into `src/server/{http,auth,uploads,sse,dispatch-runner}.ts` and `src/server/routes/*`, and split `src/orchestrator/team-orchestrator.ts` into `src/orchestrator/{types,prompts,observer-runner,delegation-runner,worker-runner,distiller}.ts`.
  - **Server Tests**: Split `test/phase3-server.test.ts` across `test/phase3-server.test.ts`, `test/web-utils.test.ts`, `test/server-rsi-and-uploads.test.ts`, and `test/server-collaboration.test.ts` while preserving all 75 offline test cases.

### Documentation
- Reconciled the architecture, runtime and module guides against `90be687` and the RSI boundary fixes below:
  - Documented unlimited default turn ceiling (`0`) with a 15-minute worker idle watchdog (historical 90-minute
    setting below is superseded).
  - Distinguished observer tools/sessions from tool-free reflection and application tracking from proven learning quality.
- Synced [docs/architecture-and-plan.md](docs/concepts/architecture-and-plan.md) with the `b1ea108` implementation baseline:
  - Documented meeting-room observer participation, active-run F5 hydration, interruption `progressSnapshot` &
    resume brief injection, and 90-minute default turn ceiling.
  - Documented Phase 4 multi-role RSI distillation/cancellation & inline review UX, `technical-writing` deliverable
    standard, and the 52-test offline baseline.
- Added [docs/configuration.md](docs/reference/configuration.md) and linked it from `README.md` and `docs/README.md`:
  - Covers environment variables (`PORT`, `PA_DB_PATH`, `PA_PI_EXTENSIONS`, `PA_TURN_TIMEOUT_MS`,
    `PA_PROMPT_TIMEOUT_MS`, `NODE_ENV`), storage/session paths, Pi RPC & bridge timeouts, role Markdown frontmatter
    fields, and orchestrator/observer runtime limits.
- Added a concise Chinese `AGENTS.md` and layered directory READMEs:
  - Separated role assets from parsers, runtime boundaries from local implementation guidance, and offline checks
    from real-model demos.
  - Added a dependency-free documentation link/command checker.
- Rewrote `docs/architecture-and-plan.md` against the implemented runtime:
  - Documented HTTP/SSE, per-execution Pi sessions, authenticated tool bridges, scoped state, and explicit milestone delivery.
  - Separated current limits and future work from the historical four-phase design, and aligned the README document pointers.

### Changed
- Added Solution B multi-human restricted LAN collaboration (`owner` / `collaborator`), explicit separation between team
  discussion and AI dispatch, and live matter participant & role roster:
  - Added `collaborators` SQLite table, `matters.collaborator_ids_json`, invite token generation/redaction
    (`toPublicCollaborator`), and configurable `PA_HOST` LAN binding in `src/server/main.ts`.
  - Added `/api/auth/{session,login,logout}` HttpOnly cookie/header token auth (auto-authenticating loopback as Owner by
    default, gating non-loopback LAN clients or `requireAuth: true`), `/api/collaborators*` admin routes, and `403`
    collaborator boundaries across admin/execution/dialog/`autoDistill: true` endpoints.
  - Added `mode: "discussion" | "ai_request" | "dispatch"` on `POST /api/matters` & `POST /api/matters/:id/messages`, plus
    Owner `/approve-ai` and `/dismiss-ai` endpoints, preserving speaker attribution in `TeamOrchestrator` history.
  - Added invite gate & local Owner/colleague switch in `App.tsx` / `Sidebar.tsx`, a unified top-right `协作成员`
    status button and compact member grid panel in `ChatStage.tsx` (default all-AI roster with `+` / `−`
    removal/restore, in-panel `事项负责人` lead switching, Matter-wide `AI 旁听` toggle replacing per-AI observer
    selection, and removal of the bottom composer follow-up `<select>`), explicit composer mode switch & AI request
    approval cards, collaborator management in `TeamView.tsx`, and deliverable admin gating in `DeliverableCard.tsx`.
- Allowed selecting an organization directly on New Matter / Chat even before registering a workspace under it, and
  switched default member `gitName` values to English (`defaultMemberGitName`):
  - Added `matters.org_id` migration & backfill, `store.updateMatterOrganization`, `orgId` support on
    `POST /api/matters` and `PATCH /api/matters/:id`, and `orgId` resolution in `TeamOrchestrator` when running
    workspace-less matters (`company_private` org memories + `PA_ORG_*` + org email domain).
  - Added an Organization selector alongside the Repository selector in `ChatStage.tsx` (filtering repositories by
    selected organization while supporting workspace-less matters directly under new orgs such as `test-org`).
  - Defaulted `gitName` to English ASCII `displayName`/`roleTitle`/`id` (upgrading untouched non-ASCII auto-backfills
    while preserving custom `gitName`), and replaced unlabeled identity inputs in `TeamView.tsx` with labeled fields.
- Upgraded Git commit attribution to separate AI role authorship from real host/repository committer identity (`1.A`):
  - `resolveRepoGitUserIdentity` (`src/orchestrator/execution-context.ts`, `team-orchestrator.ts`) reads effective
    `user.name` / `user.email` in the workspace and preserves that real user on `GIT_COMMITTER_NAME` /
    `GIT_COMMITTER_EMAIL`, while keeping the AI role on `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` (falling back cleanly
    when unconfigured).
  - Updated `buildMemberPrompt` identity instructions and `TeamView` to distinguish `Git Author（角色）` vs
    `Git Committer（真实用户）`.
- Redesigned `DeliverableCard` and `DeliverablesView` (`web/src/components/DeliverableCard.tsx`,
  `DeliverablesView.tsx`, `web/src/utils.ts` `parseDeliverableSummary`, `web/src/styles.css`) for calmer,
  focus-and-process reading:
  - Removed the redundant green author banner and cramped 440px nested scroll box in detail view.
  - Extracted `本版重点` (lead takeaway) alongside a collapsible `过程` bar (`查看依据与版本` timeline + `原对话过程 →`).
  - Improved Markdown reading typography and tucked the acceptance form behind a `记录验收`/`修改验收` toggle.

### Fixed
- Isolated reflection and observer evidence by recorded workspace anchors and deliverable provenance:
  - Explicit version reflection stops at its publication, rejects foreign artifacts, and rechecks
    workspace/cancellation before commit.
- Staged child experience proposals and application IDs under the parent execution:
  - A failed/cancelled lead discards them; a successful main execution atomically commits deliverables, candidates
    and exact version/application links.
- Restricted memory supersession to the same member, scope and workspace, rejecting cycles and edits that detach or
  move established replacement endpoints.
- Scored only memories linked to the accepted deliverable version:
  - Repeated ratings are idempotent, changed ratings replace the current vote, and `neutral` retracts it; manual
    votes remain independent.
  - Additive tables preserve existing records and counters without guessing historical links.
- Waited for reflection cleanup during shutdown, normalized transport cancellation, and preserved successfully
  saved acceptance feedback when optional auto-distillation fails.
- Defaulted experience workspace selection to the active or source matter's repository (`web/src/utils.ts`
  `pickDefaultWorkspaceId`, `ExperienceReviewPanel.tsx`, `TeamView.tsx`, `App.tsx`):
  - When editing a cross-project (`role_general`) memory and switching its scope to `当前仓库规范` (`project_private`)
    or `company_private` (in `ChatStage`, `DeliverableCard`, or `TeamView`), the workspace selector now defaults to
    the current/source matter's repository rather than `workspaces[0]`, while remaining manually changeable.
- Deduplicated deliverable-card experience controls (`web/src/components/DeliverableCard.tsx`, `ExperienceReviewPanel.tsx`):
  - Renamed `沉淀为角色经验` to `手动沉淀经验` on `DeliverableCard`'s action bar and hid redundant `+ 手动录入` / `AI 复盘提炼团队经验`
    buttons inside the embedded `InlineExperienceReviewSection` (`showManualToggle={false}`), while keeping both
    controls in `ChatStage`'s standalone experience drawer.
- Fixed truncated raw JSON blobs in the `过程与工具事件` panel (`src/orchestrator/team-orchestrator.ts`, `web/src/utils.ts`):
  - Replaced `.slice(0, 16000)` raw event serialization with compact valid JSON tool-event notices (`type`,
    `toolCallId`, `toolName`, truncated `args`, `isError`).
  - Added regex fallback parsing in `formatNoticeEventLine` (plus `isKeyNoticeEvent`) so previously persisted
    truncated tool notices also render cleanly without dumping raw file contents.
- Fixed UI visual clutter across the `ChatStage` collaboration popover and `ExperienceReviewPanel` (`web/src/components/ChatStage.tsx`, `ExperienceReviewPanel.tsx`, `web/src/styles.css`):
  - Removed duplicate red `待复核` alert badges and empty `命中 0 · +0 / -0` telemetry from newly distilled `candidate`
    items (keeping `+1`/`-1` feedback on verified rules) and removed nested card borders inside the floating
    drawer.
  - Rendered long delegation briefs/answers as collapsible Markdown cards, ordered `过程与工具事件` newest-first with a
    `仅看关键/异常事件` filter and progressive disclosure (`80` items initially), and aligned `.btn-pill-outline.active`
    styling with `.collab-tab-btn.active`.
- Fixed worker `runPromptAndWait` still hitting a 30-minute (`1,800,000 ms`) cutoff in `TeamOrchestrator`:
  - `dispatchMatter` previously left `run.timeoutMs` as `undefined` (before resolving `turnDeadlineMs`), causing
    `executeWithWorker` to fall back to `PiRpcWorker`'s `1,800,000 ms` hard timeout.
  - Resolved `run.timeoutMs` and `run.deadlineAt` cleanly (`PA_TURN_TIMEOUT_MS` -> `PA_PROMPT_TIMEOUT_MS` ->
    `5,400,000 ms`) so both lead and delegated workers receive remaining turn budget, and aligned `PiRpcWorker`'s
    standalone default to `5,400,000 ms` (90 minutes).
- Allowed updating `observerMemberIds` via `PATCH /api/matters/:id` and the `ChatStage` observer seat popover even
  while a matter turn is running (still returning HTTP 409 for active workspace switches), so users can invite or
  adjust observers live without stopping the lead.
- Restored live execution progress, elapsed timer, streamed partial output, and the Stop button across browser refreshes (`F5`):
  - Snapshotted in-flight runs in `src/server/app.ts` (`activeRuns` on `GET /api/bootstrap` and `activeRun` on
    `GET /api/matters/:id`) and hydrated them in `web/src/App.tsx`.
- Distinguished server shutdown/restart aborts (`cancelReason: "shutdown"`) from user-initiated stops in
  `TeamOrchestrator` so restarts no longer claim "已按你的要求停止本次执行".

### Added
- Added Default Organization (`默认组织`, `org-default`) management and workbench-wide organization visibility:
  - **Storage & Startup Migration (`src/storage/`, `src/server/main.ts`)**: Added `organizations.is_default` migration,
    `DEFAULT_ORGANIZATION_ID`, `ensureDefaultOrganization`, `setDefaultOrganization`, `getDefaultOrganization`, and
    `assignOrphanWorkspacesToDefaultOrganization` (seeding the default org on startup when none exist).
  - **HTTP API (`src/server/app.ts`)**: Added `POST /api/organizations/:id/default`, `isDefault` support on organization
    `POST`/`PATCH`, `repoGitUser` enrichment on workspace DTOs, and automatic attachment of new workspaces without
    explicit `orgId: null` to the active default organization.
  - **UI Visibility (`ChatStage.tsx`, `MaterialsView.tsx`, `TeamView.tsx`, `ExperienceReviewPanel.tsx`)**: Surfaced
    active organization pill, hero context bar (`组织` / `仓库` / `Git 真实提交者`), and org-prefixed workspace
    selector in 「新建事项 / 对话页」, plus default-organization badge/switching in `TeamView` and default org
    pre-selection in `MaterialsView` and `ExperienceReviewPanel`.
- Strengthened organization and member identity, Git commit attribution, and 3-tier experience/memory isolation (`role_general` / `company_private` / `project_private`):
  - **Storage & Identity Resolution (`src/storage/`)**:
    - Added `organizations` table, `workspace_links.org_id`, `member_memories.org_id`, and private `team_members`
      identity columns (`git_name`, `git_email`, `identity_summary`) with additive SQLite migrations + default
      backfills, plus `resolveEffectiveGitIdentity(member, organization)`.
    - Preserved customized private identities on `syncRoleTemplates` and kept shareable `roles/*.md` serialization sanitized.
    - Upgraded `listRelevantMemories`, `findActiveDuplicateMemory`, and `validateMemoryReplacement` so
      `company_private` shares across workspaces belonging to the same `orgId` (preserving legacy single-workspace
      fallback when ungrouped) while isolating other organizations and strict `project_private` repo memories.
  - **Orchestrator & Real Git Attribution (`src/orchestrator/team-orchestrator.ts`, `src/rpc/team-extension.ts`)**:
    - Injected `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, `PA_MEMBER_*`,
      and `PA_ORG_*` env vars into `workerFactory` runs (verified against real `git commit` overriding repo
      `.git/config`).
    - Added a structured `## 角色与组织身份（Role & Organization Identity）` section and grouped 3-tier memory subsections
      to `buildMemberPrompt`, and routed `propose_experience` + `distillExperiences` `company_private` memories to
      `orgId` when the active workspace belongs to an organization.
  - **HTTP API & Workbench UI (`src/server/app.ts`, `web/src/`)**:
    - Added `/api/organizations`, `PATCH /api/organizations/:id`, `PATCH /api/workspaces/:id`,
      `PATCH /api/members/:id`, and `orgId` support on bootstrap, workspace creation, and memory CRUD.
    - Added Organization Management strip, inline member identity + Git signature editor, 3-tier memory scope
      summary & filter in `TeamView`, Organization selector in `MaterialsView` and `ExperienceReviewPanel`, and
      offline tests (`test/phase2-orchestrator.test.ts`, `test/rsi-boundaries.test.ts`,
      `test/phase3-server.test.ts`).
- Added end-to-end chat image upload, drag-and-drop, and clipboard paste support (`src/server/`,
  `src/orchestrator/team-orchestrator.ts`, `src/index.ts`, `web/src/`):
  - **Composer UX & Preprocessing (`web/src/`)**:
    - Added image picker button + hidden file `<input>`, drag-and-drop overlay on `.composer-dock-inner`, clipboard
      `onPaste` image capture, removable thumbnail bar above `.pill-composer`, support for image-only or text+image
      submission (`MAX_COMPOSER_IMAGES = 6`, PNG/JPEG/WebP/GIF with client canvas downsizing via
      `prepareComposerImages`), and in-bubble image thumbnails with click-to-zoom lightbox (`parseMessageImages`).
  - **Upload Persistence & Serving (`src/server/`)**:
    - Added `uploadsDir` option (`.data/uploads` in `main.ts`, bounded in-memory fallback when omitted in tests),
      36MB JSON request limit (HTTP 413), MIME/base64/count/5MB validation (`HttpRequestError`), safe
      `GET /api/uploads/:filename` serving, and image-only `POST /api/matters` / `POST /api/matters/:id/messages`
      support.
  - **Orchestrator & Pi RPC Multimodal Forwarding (`src/orchestrator/team-orchestrator.ts`)**:
    - Added `PromptImageAttachment`, extended `DispatchMatterInput` and `RpcWorkerLike.runPromptAndWait` with
      `images?: ImageContent[]`, forwarded attached images to both lead and `runObservers` workers, persisted
      lightweight `{ url, mimeType, name }` references in user message `metadata.images` (without storing base64
      blobs in SQLite), and annotated historical turns (`[附带 N 张图片]`) for newly joining workers/observers.
- Added `npm run demo:rsi`, an isolated real-Pi check for proposal tools, committed candidates, document files,
  version-specific feedback and tool-free reflection, plus regression tests for scope, failed-parent rollback,
  replacement invariants, feedback deltas and shutdown/cancellation.
- Added [skills/technical-writing/SKILL.md](skills/technical-writing/SKILL.md) (wired into all four default role
  definitions in `roles/`, listed in `skills/README.md`, and reinforced in `TeamOrchestrator` &
  `publish_deliverable` schema) establishing the deliverable-writing standard:
  - **简练 · 有重点 · 有过程** (1–3 sentence `changeNote`, lead-with-conclusions structure, mode separation, and concise
    verification/collaboration evidence without raw log walls).
- Added end-to-end cancellation support for in-flight AI experience distillation:
  - Added `abortDistillation(matterId)` & `signal` propagation in `TeamOrchestrator.distillExperiences` (`src/orchestrator/team-orchestrator.ts`, also triggered during `shutdown()`).
  - Added `POST /api/rsi/distill/abort` and response-close abort propagation on `POST /api/rsi/distill` (`src/server/app.ts`), plus `取消提炼` buttons alongside active distill states in `DeliverableCard` and
    `InlineExperienceReviewSection` backed by browser `AbortController` (`web/src/api.ts`, `web/src/App.tsx`,
    `web/src/components/`).
- Preserved execution progress snapshots and resumption briefs across interrupted turns:
  - Saved `progressSnapshot` metadata (stopped stage, label, elapsed duration, active delegations, and recent
    activity logs) on both failed (`src/server/app.ts`) and aborted (`TeamOrchestrator`) `user`-channel messages
    via shared `buildProgressSnapshot`.
  - Rendered collapsible `<ProgressSnapshotCard />` summaries below warning/aborted bubbles in `ChatStage` (`web/src/components/ExploringStatus.tsx`, `web/src/styles.css`), and injected a scoped
    `buildInterruptionResumeBrief` summary when the lead resumes so follow-ups like `"继续"` pick up from the
    breakpoint without re-running completed work.
- Implemented the Phase 4 RSI experience-distillation, verification, and acceptance-linked evaluation loop across
  storage, tool bridge, orchestrator, HTTP/SSE server, and web UI (while keeping unattended scheduled overnight
  runs and public marketplace out of scope):
  - **Storage & Schema (`src/storage/`)**:
    - Added `status` (`candidate` | `verified` | `rejected` | `superseded`), `rationale`, `source_deliverable_id`,
      `superseded_by`, `supersedes_memory_id`, `applied_count`, `positive_count`, `negative_count`,
      `last_applied_at`, and `updated_at` on `member_memories`, plus `deliverables.feedback_rating` (`positive` |
      `negative` | `neutral`).
    - Added `memory_applications` table with idempotent outcome tracking (`recordMemoryApplications`,
      `evaluateMatterMemories`, `evaluateMemory`, `updateMemory`, `markMemorySuperseded`,
      `findActiveDuplicateMemory`).
  - **Active-Work Proposal & Isolated Reflection (`src/rpc/`, `src/orchestrator/team-orchestrator.ts`)**:
    - Added `propose_experience` Pi extension tool (enabled for lead & internal specialists, blocked in observer
      mode via `PA_CAN_EXPERIENCE="false"`, staged and committed as `candidate` only on non-aborted completion).
    - Added `TeamOrchestrator.distillExperiences()` running a read-only no-tools reflection worker (`--no-extensions --no-skills --no-mcp --tools ""`, `noSession: true`) to extract deduplicated candidates and
      `supersedesMemoryId` suggestions; differentiated `[已验证]` vs `[待验证]` in prompt injection and recorded memory
      injections cleanly.
  - **HTTP/SSE & Workbench UI (`src/server/app.ts`, `web/src/`)**:
    - Extended `POST /api/deliverables/:id/feedback` with optional `rating` and `autoDistill`, and added
      `POST /api/rsi/distill`, `PATCH /api/memories/:id`, `POST /api/memories/:id/evaluate`, and
      `GET /api/memories/:id/applications`.
    - Upgraded `DeliverableCard` / `DeliverablesView` (acceptance rating chips, AI experience distillation action,
      auto-distill toggle, manual `company_private` scope + rationale + `candidate`/`verified` draft controls) and
      `TeamView` (verified vs pending candidate badges, status filter tabs, rationale & hit/+/- telemetry, inline
      verify/edit/scope-switch/evaluate/reject/add actions).
  - **Offline Tests**: Added [test/rsi-lifecycle.test.ts](test/rsi-lifecycle.test.ts) and HTTP/SSE RSI integration
    tests in [test/phase3-server.test.ts](test/phase3-server.test.ts) (44 offline tests passing).
- Raised the default multi-agent matter turn ceiling in `TeamOrchestrator` from 30 minutes (`1,800,000 ms`) to 90
  minutes (`5,400,000 ms`, configurable via `PA_TURN_TIMEOUT_MS` / `PA_PROMPT_TIMEOUT_MS`) with explicit timeout
  duration in the error message, preventing active multi-specialist chains from timing out right before final lead
  synthesis while preserving `PiRpcWorker`'s 300s inactivity watchdog.
- Proactive meeting-room observer participation (`observerMemberIds` on matters):
  - Enforced `PA_CAN_DELEGATE`/`PA_CAN_PUBLISH` restrictions, isolated `observer` Pi session scope, and `[SILENT]`
    no-op filtering vs independent `user`-channel interjections tagged with `observerIntervention: true`.
  - Added `PATCH /api/matters/:id` observer updates with 409 busy guard, per-speaker avatars/ `旁听补充` badges in
    `ChatStage`, and a meeting-seat selector pill in the composer bar.
- Persisted Pi session continuation scoped by matter, member, workspace path and conversation mode, including
  restart recovery, scoped handoff context, legacy session lookup and session-header validation.
- Shipped Pi extension with real `delegate_to_member` and `publish_deliverable` tools over an authenticated
  per-worker loopback bridge. Internal work returns to the caller and stays in collaboration records.
- Actual loading of the 13 initial role Skills, explicit tool selection, delayed capability handshake for
  dynamically registered tools, and required tool/MCP dependency checks.
- SQLite matter execution ownership, cancellation across delegation trees, bounded delegation depth/count,
  duplicate-call handling, and orderly service shutdown.
- `npm run demo:team` verifies real Pi model delegation, an actual document, and recall after restarting the host
  process in a disposable workspace/database. Regression tests cover continuity, isolation, tool transport and
  failure/cancellation boundaries.

### Changed
- Refactored Phase 4 RSI experience distillation & verification into a multi-role, multi-dimensional, in-context workflow:
  - **Experience Dimensions & Multi-Role Attribution (`src/storage/`, `src/rpc/`, `src/orchestrator/team-orchestrator.ts`)**:
    - Added `category` (`efficiency` | `troubleshooting` | `collaboration` | `user_correction` |
      `domain_constraint` | `general`) to `member_memories` and `propose_experience` (with SQLite schema migration
      + backfill); extended `updateMemory` and `PATCH /api/memories/:id` to support reassigning `memberId` and
      updating `category`.
    - Updated `TeamOrchestrator.distillExperiences()` to default to `scopeMode: "team"`, gathering all
      participating roles (`lead`, `user` speakers, `internal_collab` delegates, observers) plus user corrections,
      failure/error notices, and interrupted `progressSnapshot`s so candidates are attributed to the specialist who
      solved or owns each insight rather than flattening everything onto the deliverable author.
  - **Cross-Role Evaluation & Server Broadcasts (`src/server/app.ts`)**:
    - Updated `POST /api/deliverables/:id/feedback` to score applied memories across all participating members on
      the matter, and broadcast `memory_updated` for every affected role when distilling or reassigning
      experiences.
  - **In-Context Review Loop (`web/src/components/ExperienceReviewPanel.tsx`, `DeliverableCard.tsx`,
    `ChatStage.tsx`, `TeamView.tsx`)**:
    - Replaced cross-page hunting with shared `InlineExperienceReviewSection`, `ExperienceItemCard`, and
      `ManualExperienceForm` components embedded directly inside `DeliverableCard` (`本次协作提炼与关联经验` +
      member/category selectors + explicit scope labels) and `ChatStage`'s floating `经验复盘` header tab (works
      mid-flight before any deliverable is published).
    - Added batch-approve (`全部核验通过`), member/category editing, and clickable source links (`查看原对话` / `查看来源成果`) in `TeamView`.
- Switched turn and worker execution timeouts to an activity-driven Goal/Plan-friendly model (Solution A):
  - Defaulted `PA_TURN_TIMEOUT_MS` / `PA_PROMPT_TIMEOUT_MS` to `0` (disabling the fixed wall-clock guillotine while
    work is actively progressing, with positive ms overrides still supported).
  - Raised the inactivity watchdog default from `5` minutes to `15` minutes (`900,000 ms`, configurable via
    `PA_IDLE_TIMEOUT_MS` or `0` to disable) while keeping `suspendIdleTimeout()` across host-bridged delegations,
    deliverable publishing, and dialogs.
- Anchored composer popovers (`.quick-prompts-popover`, including the `旁听` member picker and `+` starter prompt
  menu) with `position: absolute; bottom: calc(100% + 8px)` above `.composer-dock-inner` plus click-outside and
  `Escape` dismissal, preventing them from resizing the composer dock or shifting the main message stream.
- Converted `ChatStage`'s top-right collaboration drawer (`.collab-dock-panel`) into an anchored floating overlay
  popover (`top: 64px; right: 24px`) with click-outside and `Escape` dismissal, so opening `团队委托 · 事件` no longer
  pushes down or squeezes the main conversation stream.
- Tightened proactive observer background injection (`buildObserverContextDigest`):
  - Late-joining or active observers now receive only a compact summary (matter title/summary, delivered milestone
    titles, up to 16 truncated recent user-channel excerpts capped within 6,000 chars, plus the current turn's
    prompt & lead reply) rather than dumping full 20,000-character verbatim transcripts.
- Role directory discovery now excludes `README.md`, so local asset documentation does not become an invalid team member.
- Follow-up messages keep the matter's lead and workspace; a new matter still uses explicit selection, initial
  keyword routing or the primary contact, while specialist collaboration is decided by the executing member.
- Ordinary replies and clarification no longer become automatic documents or mark the matter delivered:
  - Only the lead publishes reviewable milestones, explicitly requested versions or substantial revisions, with a
    required change basis linked to the source conversation.
  - Internal specialists return results to the lead; drafts are staged, validated and archived only when the turn succeeds.
- Company-private memories now require a workspace to be injected; unscoped historical memories remain viewable;
  imported role definitions do not install plugins or Skills automatically.
- Removed the UI's `修改` prefix shortcut that implicitly exported any reply as a new version; revision requests now
  use the same explicit milestone decision as other dialogue.
- Active turns reject concurrent messages and workspace switches with HTTP 409; saved session failures are reported
  instead of silently starting a new conversation.
- Fixed `ChatStage` top collaboration header label & drawer placement:
  - Split the ambiguous combined count into `团队委托 (N) · 事件 M`, docked the panel directly beneath `.stage-header` so
    clicking it stays visible regardless of scroll position, and separated `团队内部委托` and `过程与工具事件` into explicit
    tabs.
- Fixed 300s HTTP bridge transport timeout during long colleague delegations:
  - Replaced `fetch()` in `team-extension.ts` with `node:http` (`timeout: 0`, avoiding Undici's 300s
    `headersTimeout`) and disabled `requestTimeout`/`headersTimeout` in `team-tool-bridge.ts`.
  - Removed failed delegation entries from `run.delegations` on error so same-task retries execute a fresh worker
    instead of replaying cached failures.
- Added humanized role mood micro-animations to `BotFaceIcon` (idle blinking, thinking glance/bob + thought
  bubbles, focused tool-scanning eyes, waiting-user attention pip, and finalizing happy eyes with reduced-motion
  support) and redesigned `ExploringStatus` + `Sidebar` into a live team desk showing per-role animated avatars,
  labeled 5-stage stepper, active colleague cards, and recent tool/writing activity feed.
- Aligned frontend state with the backend turn & scope boundaries:
  - Prevented optimistic workspace changes from masking 409/errors, guarded active-turn sends/switches in
    `ChatStage`, kept SSE connections open across matter switches via refs, rendered deliverable `changeNote`
    summaries in `DeliverableCard`, and labeled memory workspace bindings in `TeamView`.
- Suspended parent `PiRpcWorker` inactivity watchdog while host-bridged team tool calls (`delegate_to_member`,
  `publish_deliverable`) are executing:
  - Preserved child worker idle watchdogs and overall turn deadlines, forwarded delegated colleague progress (`activeDelegations`, concrete tool path/command summaries, throttled writing snippets, and `recentLogs`
    activity feed) plus `collabUpdated` SSE sync to `ExploringStatus` and `App.tsx`, and added per-turn collapsible
    delegation summary cards plus structured delegation/event sections in `ChatStage` (`协作过程`).
- Marketing's declared tools now match the installed Pi baseline (`read`, `bash`), replacing the unimplemented
  `web_search` declaration; no claim of a dedicated search service is made.

## [0.4.0] - 2026-11-14

### Changed
- **Grok-Bot-Inspired Two-Column Interactive Workspace (`web/src/App.tsx`, `web/src/styles.css`, `web/src/hashRouter.ts`)**:
  - Replaced the constrained three-column layout with a `292px` left sidebar (`#f6f8f7`) and a spacious centered
    conversation canvas (`max-width: 820px`).
  - Added tilted SVG bot avatars (`BotFaceIcon`) across the quick-roster strip, active header pill, and
    `#/chats/new` hero; added sidebar matter search toggle and recent-matter status previews.
  - Changed the default landing hash route from `#/deliverables` to `#/chats` so the workbench opens directly into
    the conversation-first workspace.
- **Streamlined Conversation Flow**:
  - Removed duplicate message and full deliverable-card rendering inside `#/chats/:id` and replaced inline chat
    deliverable blocks and feedback forms with a compact one-line archive pill (`✓ 已归档至成果库 · V{n}` with quick
    links to `#/deliverables` and preview URLs), while keeping full deliverable inspection and acceptance feedback
    in `#/deliverables`.
  - Suppressed redundant `matter_settled` top banners when already viewing the settled matter's conversation, and
    simplified `#/chats/new` to a clean centered hero without bulky 3-card onboarding clutter (keeping `+` starter
    prompts accessible from the floating bottom pill composer).

### Added
- **In-Flight Run Abort / Stop Controls**:
  - Added `RpcWorkerLike.abort?()` and `TeamOrchestrator.abortMatter(matterId)` (sends Pi RPC `abort` with a
    `1500ms` fallback to `worker.stop()`, suppresses deliverable archival for aborted runs, and records `[已中断执行]` /
    stop confirmation), plus `DialogBroker.cancelForMatter(matterId)`.
  - Added `POST /api/matters/:id/abort` and the `matter_aborted` SSE event (`src/server/app.ts`, `web/src/api.ts`).
  - Added immediate stop actions in the UI via `ExploringStatus` (`停止` button) and the bottom pill composer (`■`
    `.pill-stop-btn`).
- **Matter Workspace Sync & Live Switching**:
  - Added `PersonalAgentStore.updateMatterWorkspace(matterId, workspaceId)` and `PATCH /api/matters/:id` (`src/storage/repositories.ts`, `src/server/app.ts`, `web/src/api.ts`) so bound repositories can be corrected
    mid-thread.
  - Synced `selectedWorkspaceId` to `matterDetail.matter.workspaceId` on matter load/refresh and persisted
    new-matter selection in `localStorage` (`pa.defaultWorkspaceId`).

### Tests
- Updated `test/phase2-orchestrator.test.ts` and `test/phase3-server.test.ts`:
  - Included HashRouter `#/chats` default route checks and a new server integration test for aborting a running
    matter and updating its bound workspace.

## [0.3.1] - 2026-11-14

### Added
- **V4 UX Guidance, Team Management, Live Progress & Hash Router**:
  - Replaced technical empty state in `交付给我` with a 3-step onboarding card featuring workspace selection and
    one-click starter prompts for `研发经理`, `产品经理`, and `测试经理` (`web/src/App.tsx`).
  - Added `我的团队` tab and backend APIs (`POST /api/members`, `POST /api/members/:id/primary`,
    `GET /api/members/:id/export`, `POST /api/members/import`, `POST /api/memories`):
    - Supports adding custom roles, switching the default primary contact, viewing/saving scoped memories, and
      importing/exporting sanitized role Markdown packages (`src/server/app.ts`, `src/storage/repositories.ts`).
  - Added 5-stage live progress reporting (`DispatchProgressEvent` + `matter_progress` SSE events) across
    `TeamOrchestrator`, HTTP server, and top/right progress cards (`src/orchestrator/team-orchestrator.ts`).
  - Added safe zero- `dangerouslySetInnerHTML` Markdown rendering (`web/src/MarkdownView.tsx`) and completion
    banners on deliverables.
  - Added lightweight URL Hash Router (`web/src/hashRouter.ts`):
    - Supports `#/deliverables/:id`, `#/chats/:id`, `#/chats/new`, `#/team`, and `#/materials` with refresh
      persistence and browser back/forward navigation.
  - Added tests for `matter_progress` SSE, team/memory APIs, and `hashRouter` (`test/phase3-server.test.ts`).

## [0.3.0] - 2026-11-14

### Added
- **Phase 3 V4 Workbench, HTTP/SSE Server & Preview Runner**:
  - Added Node HTTP + SSE backend (`src/server/app.ts`, `src/server/dialog-broker.ts`, `src/server/main.ts`):
    - Supports real-time text streaming, matter dispatch, separated `user` vs collapsed `internal_collab`/`notice`
      channels, interactive `extension_ui_request` approval resolution, deliverable versioning & feedback, and
      workspace binding.
  - Added `PreviewManager` (`src/server/preview-manager.ts`) to launch, monitor, and stop independent local
    preview services (`http://127.0.0.1:<port>`) for V4's "打开查看 →" links.
  - Added React 19.3.0 V4 three-column workbench (`web/src/`, bundled via `esbuild` in `scripts/build-web.mjs`):
    - Includes `交付给我`, `和同事聊`, `已有资料`, collapsible `我的同事`, interactive approval cards, and collapsed `协作对话`.
  - Added Phase 3 server & preview integration tests (`test/phase3-server.test.ts`).

## [0.2.0] - 2026-11-14

### Added
- **Phase 2 Role Templates, SQLite Store & Orchestrator**:
  - Added 4 shareable Markdown + YAML frontmatter role templates under `roles/` (`marketing-lead.md`,
    `product-manager.md`, `engineering-manager.md`, `qa-manager.md`) and loader/serializer (`src/roles/`).
  - Added local SQLite storage built on Node's `node:sqlite` (`src/storage/database.ts`, `src/storage/repositories.ts`):
    - Separates shareable role templates from scoped private memories (`role_general`, `company_private`,
      `project_private`), `matters`, `matter_messages` (`user` / `internal_collab` / `notice` channels), versioned
      `deliverables`, `workspace_links`, and `worker_sessions`.
  - Added `TeamOrchestrator` (`src/orchestrator/team-orchestrator.ts`):
    - Supports keyword-based routing ("按事找人"), workspace `cwd` mounting, internal role-to-role delegation,
      `waiting_user` dialog handling, and auto-versioned deliverable recording.
  - Added Phase 2 unit and orchestration tests (`test/phase2-orchestrator.test.ts`).

## [0.1.0] - 2026-11-14

### Added
- **Phase 1 Pi RPC Worker (`src/rpc/`)**:
  - `attachJsonlLineReader` & `serializeJsonLine` (`src/rpc/jsonl.ts`):
    - Strict LF-only JSONL framing avoiding `node:readline` splitting on `U+2028`/`U+2029`.
  - `PiRpcWorker` (`src/rpc/pi-rpc-worker.ts`):
    - Subprocess-isolated `pi --mode rpc` runner with `id`-correlated commands, `prompt`
      `disposition === "handled"` fast path, and `agent_settled` completion detection.
    - Handles bidirectional `extension_ui_request`/`extension_ui_response`, non-blocking UI notice routing, and
      graceful stdin-EOF shutdown.
  - Smoke demo (`src/demo/rpc-smoke.ts`) verified live against `pi` `1.5.2` using `kimi-coding / kimi-for-coding`.
  - Unit test suite (`test/pi-rpc-worker.test.ts`) covering JSONL framing, concurrent requests, handled prompts,
    streaming, and bidirectional dialogs.
- **Engineering Baseline**:
  - Added TypeScript strict configuration (`tsconfig.json`, `tsconfig.build.json`) targeting Node.js `>= 22.19.0`.
  - Added `@biomejs/biome` `2.3.5` (`biome.json`) with tab indentation, a 120-column line width, and `useConst`.
  - Added root `README.md` and `CHANGELOG.md`.

### Documentation
- Added `docs/architecture-and-plan.md` (`a91c1cf`): Pi RPC-based system architecture, domain models, and 4-phase roadmap.
- Initialized Git repository and committed baseline product direction, V1–V4 prototypes, and Grok Bot references (`52d8adc`).
