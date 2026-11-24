# 本地领域数据

模块文件分工：

- [database.ts](database.ts) 在空数据库中创建 [schema.ts](schema.ts) 的完整表结构，并拒绝打开其他格式的数据库；它不会迁移或清空已有文件。[types.ts](types.ts) 定义领域记录。[workspace-folder-repo.ts](repos/workspace-folder-repo.ts) 维护工作区的主目录与附加目录。
- [space-git-store.ts](space-git-store.ts) 与 [space-repo.ts](repos/space-repo.ts) 维护基于独立 Git 仓库（`<dataDir>/spaces/{orgs,workspaces,users,members,custom}/<id>/`）的五类资料空间（`org`、`workspace`、`user`、`member` 和 `custom`）：
  - `spaces` 与 `space_documents` 保存空间元数据与文档索引；新建单文件落入 `plans/`、`specs/`、`decisions/`、`rules/`、`notes/`，目录条目支持子文件与静态预览。正文和修订历史保存在各自 Git 仓库中。每个空间的 Git 写操作按 `spaceId` 串行排队，更新时校验修订号或基线提交。
  - 私密事项默认路由到发起人的 `user` 个人空间（`spc_usr_<userId>`），从物理仓库层面隔离私密正文；非私密事项按仓库优先、其次组织默认空间路由。
  - `space_documents` 通过可选列 `linked_org_id`、`linked_workspace_id`、`linked_file_path` 关联业务仓库项目的文件相对路径或链接；业务代码仓本身的 `write`/`edit` 变更留在业务仓 Git 与事项事件中，不再单独建引用表或双写正文。
- [repositories.ts](repositories.ts) 提供 `PersonalAgentStore` 门面，按域委托给 [repos/](repos/helpers.ts) 下的空间（[space-repo.ts](repos/space-repo.ts)）、成员、组织、用户鉴权与平台配置（[user-auth-repo.ts](repos/user-auth-repo.ts)）、组织 RBAC / 邀请 / 组织 AI 角色与上传索引（[org-rbac-repo.ts](repos/org-rbac-repo.ts)）、[工作区与授权](repos/workspace-repo.ts)、经验、事项与会话子仓储。
- 默认用户数据库的位置由 [server/main.ts](../../../../apps/cli/src/main.ts) 决定，测试应使用内存或临时数据库。

需要核对的存储边界：

- `worker_sessions` 保存确切 Pi 文件、范围键及消息游标，模型历史本身保存在 Pi JSONL 文件。`active` 行不等于进程存活。
  会话范围键包含组织、工作区、事项、角色和触发用户。
- `matter_execution_leases` 保存单机宿主 PID 与占用者；不是分布式租约，也不是外部动作 exactly-once 保证。
- `removed_role_templates` 在成员删除事务中记录模板 ID，启动同步跳过已移除模板，显式重新创建或导入时清除标记。该表属于当前数据库结构。
- 组织与成员私有身份：
  - `organizations`、`team_members` 与 `workspace_links` 维护组织名、`git_email_domain`、`use_role_git_identity`（默认 `0`，即默认使用目标仓库目录自身的 Git `user.name` / `user.email`，显式开启后才注入角色 Git Author 署名）、简介、`is_default` 与 `workspace_links.org_id`。
  - 启动时确保默认组织存在。首次建组织时，只有无历史、无授权的独立工作区可以自动归入默认组织。登记时显式传 `null` 可保留独立仓库。
  - 工作区归属变更检查事项、执行会话、带工作区标记的消息与授权名单。有任一引用时保留原归属。工作区配置、可见性和成员名单在同一事务提交。
  - 同时保存成员私有 `git_name`、`git_email`、`identity_summary`。
  - 成员 Git 名称优先用英文显示名或岗位名，其次用成员 ID。由 `resolveEffectiveGitIdentity(member, organization)` 计算最终 Git Author 署名。
- 复用规范沉淀通过 `propose_skill` 确认后直接落盘为标准 `SKILL.md`（及可选 `scripts/*`）至 `.data/skills/` 或 `<workspace>/.agents/skills/`，不再在 SQLite 维护 `member_memories` / `memory_applications` 表；文档提交反馈保存在 `space_document_feedback`。
- `matters.ai_member_ids_json`（`NULL` 表示默认全部 AI 角色参与，数组表示当前保留的 AI 成员）、`matters.observers_enabled`
  （事项全局 AI 旁听开关）与 `matters.observer_ids_json` 协同维护事项内 AI 参与范围、负责人切换及旁听名单。关闭开关时保留旁听名单，主责的委托名单单独保存。
  由事项仓储维护。删除角色时同步从参与、请教与旁听名单移除它，删掉最后一个已配置旁听者时关闭该事项的旁听。
- 人类成员由 `users` 和 `organization_members` 维护；`matters.collaborator_ids_json` 保存事项指定参与人的用户 ID。
- `appendMessage` 写入当时有效组织的 `metadata.orgId` 快照；读取历史不能使用事项今天的绑定替代来源。`transitionAiRequest` 用条件 UPDATE 认领待处理的人类提请，避免重复批准或忽略。待决定问题与答案随来源消息保存，`transitionHumanDecision` 按待答状态与版本原子提交。续跑用户消息引用这条来源消息，已有成功回复时不再派发；角色确认结果与确认人随提案保存。
- 角色 Markdown 与私有运行数据分离；不要把数据库内容导进 [可分享角色](../../../../roles/README.md)。预览索引和待答对话属于服务内存，未在此持久化。

验证数据库初始化和重新打开时使用内存库或临时库，不读取或改写本地用户数据库。

- 团队账号、多组织 RBAC、平台策略与审计日志：
  - `users`（邮箱 + `scryptSync` 加盐密码哈希、`platform_role`: `super_admin` / `user`、`status`: `active` / `pending_review` / `disabled`、`max_orgs`、`max_active_dispatches`、`max_personal_roles`、`can_dispatch_ai`）、`user_sessions`（SHA-256 会话摘要）与 `platform_settings`（注册模式 `open_auto`/`open_review`/`invite_only`，默认 `open_review`、`workspaces_root`、`allow_local_workspace_path`、`local_workspace_allowlist_json`、`allow_command_previews`、默认配额含 `default_max_personal_roles`）以及持久化 `audit_logs` 由 [user-auth-repo.ts](repos/user-auth-repo.ts) 维护。
  - `team_members` 增设 `role_scope`（`global` / `org` / `personal`）与 `owner_user_id` 持久化约束，[member-repo.ts](repos/member-repo.ts) 的 `upsertMember` / `setPrimaryContact` 强制非 `global` 角色不可成为全局主联系人并提供 `countPersonalRoles(userId)` 统计个人私有角色数量。
  - `organization_members`（`org_owner` / `org_admin` / `org_member` / `org_viewer`）、`organization_invites`（SHA-256 哈希邀请码与原子核销）、`organization_ai_roles`（按组织启停 AI 角色、主联系人与 `git_name_override`/`git_email_override` 组织级 Git 署名覆盖，经 `resolveEffectiveOrgMembers(orgId)` 与 `resolveMemberForOrg(orgId, member)` 投影至组织名册与执行上下文，再经 `resolveEffectiveOrgMembersForUser(orgId, userId)` 追加调用者自己的 `personal` 角色，且批量设置组织名册时忽略 `personal`/跨组织角色）及 `uploads_index`（上传文件权限作用域归属）由 [org-rbac-repo.ts](repos/org-rbac-repo.ts) 维护。`workspace_members` 和工作区可见性由 [workspace-repo.ts](repos/workspace-repo.ts) 维护，事项可见性由 [matter-repo.ts](repos/matter-repo.ts) 维护。
  - 本地默认所有者用户 `DEFAULT_LOCAL_ADMIN_USER_ID`（`usr_local_owner`）在从免密回环模式原地切换至 `PA_REQUIRE_AUTH=1` 时通过 `setupInitialAdmin` 原地升级并保留既有组织与事项关联。

从仓库根运行 `node --test test/space-git-store.test.ts test/phase2-orchestrator.test.ts test/continuity-collaboration.test.ts test/rsi-boundaries.test.ts test/multi-tenant-auth-admin.test.ts`。
存储范围如何用于运行见 [orchestrator](../orchestrator/README.md)，数据与会话边界见[运行说明](../../../../docs/reference/runtime-collaboration.md)。
