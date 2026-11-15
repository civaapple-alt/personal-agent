# 本地领域数据

[database.ts](database.ts) 打开数据库并做兼容初始化；[types.ts](types.ts) 定义领域记录；[repositories.ts](repositories.ts) 提供 `PersonalAgentStore`，供编排核和服务 API 调用。默认用户数据库的位置由 [server/main.ts](../server/main.ts) 决定，测试应使用内存或临时数据库。

需要核对的存储边界：

- `worker_sessions` 保存确切 Pi 文件、范围键及消息游标，模型历史本身保存在 Pi JSONL 文件。`active` 行不等于进程存活。
- `matter_execution_leases` 保存单机宿主 PID 与占用者；不是分布式租约，也不是外部动作 exactly-once 保证。
- `recordTurnOutcome` 在同一事务中写入成果、候选经验和本轮成功执行的应用关联；`recordDeliverables` 是不含经验的调用入口。版本按事项与标题形成系列。回复与事项状态在事务之后记录，不能声称整个外部执行可回滚。
- `organizations`、`team_members` 与 `workspace_links` 共同维护组织与成员的私有身份边界：`Organization` 保存组织名、`git_email_domain` 与简介；`TeamMember` 增加私有 `git_name`、`git_email`、`identity_summary`（兼容迁移旧库并按 `display_name` 与 `<id>@team.local` 补齐默认值，模板同步时保留用户已改写的私有身份）；`WorkspaceLink` 可绑定 `org_id`，由 `resolveEffectiveGitIdentity(member, organization)` 计算最终 Git 提交署名。
- `listRelevantMemories` 按 `verified` 优先于 `candidate`、排除 `rejected` 与 `superseded` 的顺序注入三层记忆：`role_general`（跨组织跨仓库通用岗位经验）、`company_private`（若当前工作区属于某组织则共享同 `org_id` 下全部仓库的组织记忆，否则退化匹配单工作区兼容记忆，无归属旧记录不扩散）、`project_private`（严格限定当前工作区 `workspace_id`）。
- `memory_applications` 记录实际注入，不能证明模型采用。`deliverable_memory_applications` 关联成果版本与本轮应用；验收只评价这些经验，历史未关联版本不猜测补记。`memory_feedback_votes` 对每个版本、经验只保存一个当前评价，改评按差值回写，neutral 撤回该票；独立手动评价仍累加。
- 经验生命周期与替代关系由 `addMemory`、`updateMemory` 共同校验：替代双方须同成员、同 scope、同组织（`orgId`）、同工作区（`workspaceId`）且无环。没有替代关系的经验可以人工改归属；已有关系不能通过清空指针或移动任一端绕过限制。核验替代候选后将旧经验标为 `superseded`。
- `matters.observer_ids_json` 保存事项关联的旁听成员 ID 列表（空数组或旧库 `NULL` 表示无旁听）；由 `createMatter` 和 `updateMatterObservers` 维护。
- 角色 Markdown 与私有运行数据分离；不要把数据库内容导进 [可分享角色](../../roles/README.md)。预览索引和待答对话属于服务内存，未在此持久化。

改 schema 时保留既有消息、版本、会话和用户数据，验证重开数据库后的行为；不要拿用户 `.data/` 试验迁移或清空修复。

从仓库根运行 `node --test test/phase2-orchestrator.test.ts test/continuity-collaboration.test.ts test/rsi-boundaries.test.ts`。存储范围如何用于运行见 [orchestrator](../orchestrator/README.md)，历史兼容细节见[运行说明](../../docs/runtime-collaboration.md)。
