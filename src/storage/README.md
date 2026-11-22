# 本地领域数据

模块文件分工：

- [database.ts](database.ts) 打开数据库，[schema.ts](schema.ts) 定义表结构，[migrations.ts](migrations.ts) 按 SQLite `user_version` 执行迁移（当前版本 9，含多目录工作区 `workspace_folders`）。[types.ts](types.ts) 定义领域记录。[workspace-folder-repo.ts](repos/workspace-folder-repo.ts) 维护每个工作区的主目录（`primary`，自动兼容既有 `repo_path`）与附加目录（`attached`）。
- [space-git-store.ts](space-git-store.ts) 与 [space-repo.ts](repos/space-repo.ts) 维护基于独立 Git 仓库（`<dataDir>/spaces/{orgs,workspaces,users,members,custom}/<id>/`）的五类资料空间（`org` 组织默认、`workspace` 仓库默认、`user` 人类用户个人默认、`member` AI 角色默认、`custom` 自定义空间），并对既有旧平铺 `spaces/spc_*` 仓库提供透明自动迁移：
  - 仅需 `spaces` 与 `space_documents` 两张表保存空间元数据与文档索引，正文和修订历史以各自 Git 仓库的提交与 Diff 为唯一真相；每个空间的 Git 写操作按 `spaceId` 串行排队，更新时校验修订号/基线提交以防并发覆盖。
  - 私密事项默认路由到发起人的 `user` 个人空间（`spc_usr_<userId>`），从物理仓库层面隔离私密正文；非私密事项按仓库优先、其次组织默认空间路由。
  - `space_documents` 通过可选列 `linked_org_id`、`linked_workspace_id`、`linked_file_path` 关联业务仓库项目的文件相对路径或链接；业务代码仓本身的 `write`/`edit` 变更留在业务仓 Git 与事项事件中，不再单独建引用表或双写正文。
  - `migrateLegacySpacePages` 在启动时将旧表 `space_pages`（[space-page-repo.ts](repos/space-page-repo.ts)）中的历史资料平滑导入对应默认空间的 Git 仓库。
- [repositories.ts](repositories.ts) 提供 `PersonalAgentStore` 门面，按域委托给 [repos/](repos/helpers.ts) 下的空间（[space-repo.ts](repos/space-repo.ts)）、成员、组织、协作成员、用户鉴权与平台配置（[user-auth-repo.ts](repos/user-auth-repo.ts)）、组织 RBAC / 邀请 / 组织 AI 角色与上传索引（[org-rbac-repo.ts](repos/org-rbac-repo.ts)）、[工作区与授权](repos/workspace-repo.ts)、经验、成果（遗留兼容）、事项与会话子仓储。
- 默认用户数据库的位置由 [server/main.ts](../server/main.ts) 决定，测试应使用内存或临时数据库。

需要核对的存储边界：

- `worker_sessions` 保存确切 Pi 文件、范围键及消息游标，模型历史本身保存在 Pi JSONL 文件。`active` 行不等于进程存活。
  新范围键 `v2` 包含组织；旧 `v1` 或无范围映射仍保留，但不自动恢复到新范围。
- `matter_execution_leases` 保存单机宿主 PID 与占用者；不是分布式租约，也不是外部动作 exactly-once 保证。
- `removed_role_templates` 在成员删除事务中记录模板 ID，启动同步跳过已移除模板，显式重新创建或导入时清除标记。该表通过兼容初始化新增，不推断旧版历史删除意图。
- `recordTurnOutcome` 在同一事务中写入成果、候选经验和本轮成功执行的应用关联；`recordDeliverables` 是不含经验的调用入口。版本按事项与标题形成系列。回复与事项状态在事务之后记录，不能声称整个外部执行可回滚。
- 组织与成员私有身份：
  - `organizations`、`team_members` 与 `workspace_links` 维护组织名、`git_email_domain`、`use_role_git_identity`（默认 `0`，即默认使用目标仓库目录自身的 Git `user.name` / `user.email`，显式开启后才注入角色 Git Author 署名）、简介、`is_default` 与 `workspace_links.org_id`。
  - 启动时确保默认组织存在。首次建组织时，只有无历史、无授权的独立工作区可以自动归入默认组织。登记时显式传 `null` 可保留独立仓库。
  - 工作区归属变更检查事项、工作区经验、执行会话、带工作区标记的消息与授权名单。有任一引用时保留原归属。工作区配置、可见性和成员名单在同一事务提交。
  - 若旧库中的事项或消息明确记录了与当前工作区不同的组织，工作区范围的私有经验保留在库中，暂时停止展示和注入。
  - 同时保存成员私有 `git_name`、`git_email`、`identity_summary`。
  - 迁移只回填空的 Git 名称和邮箱。名称优先用英文显示名或岗位名，其次用成员 ID。已有署名在迁移和模板同步时保留。由 `resolveEffectiveGitIdentity(member, organization)` 计算最终 Git Author 署名。
- 三层记忆查询与替代边界：
  - `listRelevantMemories` 按 `verified` 优先于 `candidate`、排除 `rejected` 与 `superseded` 的顺序注入：
    - `role_general`：跨组织跨仓库通用。
    - `company_private`：属组织时按 `org_id` 跨同组织仓库共享，否则退化匹配单工作区兼容记忆，无归属旧记录不扩散。
    - `project_private`：严格绑定当前 `workspace_id`。
  - 经验生命周期与替代关系由 `addMemory`、`updateMemory` 共同校验，核验替代候选后将旧经验标为 `superseded`：
    - 替代双方须同成员、同范围、同组织、同工作区且无环。旧经验只能接受一个替代项。核验候选与标记旧经验在同一事务完成，只有通过核验的替代项才能注入岗位执行。
- 经验应用与版本反馈记录：
  - `memory_applications` 记录实际注入，不能证明模型采用；`deliverable_memory_applications` 关联成果版本与本轮应用，验收只评价这些经验，历史未关联版本不猜测补记。
  - `memory_feedback_votes` 对每个版本、经验只保存一个当前评价，改评按差值回写，`neutral` 撤回该票；独立手动评价仍累加。
- `matters.ai_member_ids_json`（`NULL` 表示默认全部 AI 角色参与，数组表示当前保留的 AI 成员）、`matters.observers_enabled`
  （事项全局 AI 旁听开关）与 `matters.observer_ids_json` 协同维护事项内 AI 参与范围、负责人切换及旁听名单。关闭开关时保留旁听名单，主责的委托名单单独保存。
  由事项仓储维护。删除角色时同步从参与、请教与旁听名单移除它，删掉最后一个已配置旁听者时关闭该事项的旁听。
- 人类协作成员与受限房间访问：
  - `collaborators` 表与 `matters.collaborator_ids_json` 维护人类参与者（`owner` / `collaborator`）、岗位头衔及邀请口令；
  - `ensureOwnerCollaborator` 自动初始化所有者记录，`toPublicCollaborator` 用于向非所有者隐藏邀请口令。
- `appendMessage` 写入当时有效组织的 `metadata.orgId` 快照；读取历史不能使用事项今天的绑定替代来源。`transitionAiRequest` 用条件 UPDATE 认领待处理的人类提请，避免重复批准或忽略。待决定问题与答案随来源消息保存，`transitionHumanDecision` 按待答状态与版本原子提交。续跑用户消息引用这条来源消息，已有成功回复时不再派发；角色确认结果与确认人随提案保存。
- `createMatter` 可由内部调用指定固定 `id`，供按需内置演示复用；普通 HTTP 新建接口不接收该字段，仍生成随机 ID，不新增另一套演示消息或成果存储。
- 角色 Markdown 与私有运行数据分离；不要把数据库内容导进 [可分享角色](../../roles/README.md)。预览索引和待答对话属于服务内存，未在此持久化。

迁移在同一事务中更新表结构、数据和版本号。旧工作区与经验表补齐外键后，使用 `PRAGMA foreign_key_check` 验证现存引用。发现悬空引用时，迁移回滚并保留原数据。验证时使用内存库或临时库，覆盖升级和再次打开。

- 团队账号、多组织 RBAC、平台策略与审计日志：
  - `users`（邮箱 + `scryptSync` 加盐密码哈希、`platform_role`: `super_admin` / `user`、`status`: `active` / `pending_review` / `disabled`、`max_orgs`、`max_active_dispatches`、`max_personal_roles`、`can_dispatch_ai`）、`user_sessions`（SHA-256 会话摘要）与 `platform_settings`（注册模式 `open_auto`/`open_review`/`invite_only`，默认 `open_review`、`workspaces_root`、`allow_local_workspace_path`、`local_workspace_allowlist_json`、`allow_command_previews`、`pstack_dir`/`pstackDir`、默认配额含 `default_max_personal_roles`）以及持久化 `audit_logs` 由 [user-auth-repo.ts](repos/user-auth-repo.ts) 维护。
  - `team_members` 增设 `role_scope`（`global` / `org` / `personal`）与 `owner_user_id` 持久化约束，[member-repo.ts](repos/member-repo.ts) 的 `upsertMember` / `setPrimaryContact` 强制非 `global` 角色不可成为全局主联系人并提供 `countPersonalRoles(userId)` 统计个人私有角色数量。
  - `organization_members`（`org_owner` / `org_admin` / `org_member` / `org_viewer`）、`organization_invites`（SHA-256 哈希邀请码与原子核销）、`organization_ai_roles`（按组织启停 AI 角色、主联系人与 `git_name_override`/`git_email_override` 组织级 Git 署名覆盖，经 `resolveEffectiveOrgMembers(orgId)` 与 `resolveMemberForOrg(orgId, member)` 投影至组织名册与执行上下文，再经 `resolveEffectiveOrgMembersForUser(orgId, userId)` 追加调用者自己的 `personal` 角色，且批量设置组织名册时忽略 `personal`/跨组织角色）及 `uploads_index`（上传文件权限作用域归属）由 [org-rbac-repo.ts](repos/org-rbac-repo.ts) 维护。`workspace_members` 和工作区可见性由 [workspace-repo.ts](repos/workspace-repo.ts) 维护，事项可见性由 [matter-repo.ts](repos/matter-repo.ts) 维护。
  - 保留既有表兼容性，本地默认所有者用户 `DEFAULT_LOCAL_ADMIN_USER_ID`（`usr_local_owner`）在从免密回环模式原地切换至 `PA_REQUIRE_AUTH=1` 时通过 `setupInitialAdmin` 原地升级并保留既有组织与事项关联。

从仓库根运行 `node --test test/space-git-store.test.ts test/phase2-orchestrator.test.ts test/continuity-collaboration.test.ts test/rsi-boundaries.test.ts test/multi-tenant-auth-admin.test.ts`。
存储范围如何用于运行见 [orchestrator](../orchestrator/README.md)，历史兼容细节见[运行说明](../../docs/reference/runtime-collaboration.md)。
