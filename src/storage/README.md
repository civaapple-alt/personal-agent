# 本地领域数据

[database.ts](database.ts) 打开数据库并做兼容初始化；[types.ts](types.ts) 定义领域记录；[repositories.ts](repositories.ts) 提供 `PersonalAgentStore`，供编排核和服务 API 调用。默认用户数据库的位置由 [server/main.ts](../server/main.ts) 决定，测试应使用内存或临时数据库。

需要核对的存储边界：

- `worker_sessions` 保存确切 Pi 文件、范围键及消息游标，模型历史本身保存在 Pi JSONL 文件。`active` 行不等于进程存活。
- `matter_execution_leases` 保存单机宿主 PID 与占用者；不是分布式租约，也不是外部动作 exactly-once 保证。
- `recordDeliverables` 在事务中写入同轮成果和版本；版本按事项与标题形成系列。回复与事项状态在事务之后记录，不能声称整个外部执行可回滚。
- `listRelevantMemories` 按 `verified` 优先于 `candidate`、排除 `rejected` 与 `superseded` 的顺序注入通用岗位经验及绑定当前工作区的私有记忆。无范围旧私有记录仍保留供查看，不应被自动扩散到其他项目。
- `memory_applications` 与 `member_memories` 生命周期字段（`status`、`category`、`rationale`、`source_deliverable_id`、`superseded_by`/`supersedes_memory_id`、`applied_count`、`positive_count`、`negative_count`）配合 `deliverables.feedback_rating` 追踪经验被注入与验收评估的结果；`updateMemory` 校验目标成员并支持跨角色改归属（`memberId`），核验携带 `supersedesMemoryId` 的新规则时自动将旧规则标记为 `superseded`。
- `matters.observer_ids_json` 保存事项关联的旁听成员 ID 列表（空数组或旧库 `NULL` 表示无旁听）；由 `createMatter` 和 `updateMatterObservers` 维护。
- 角色 Markdown 与私有运行数据分离；不要把数据库内容导进 [可分享角色](../../roles/README.md)。预览索引和待答对话属于服务内存，未在此持久化。

改 schema 时保留既有消息、版本、会话和用户数据，验证重开数据库后的行为；不要拿用户 `.data/` 试验迁移或清空修复。

从仓库根运行 `node --test test/phase2-orchestrator.test.ts test/continuity-collaboration.test.ts`。存储范围如何用于运行见 [orchestrator](../orchestrator/README.md)，历史兼容细节见[运行说明](../../docs/runtime-collaboration.md)。
