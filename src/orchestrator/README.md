# 事项执行与角色协作

[team-orchestrator.ts](team-orchestrator.ts) 拥有一轮用户任务的生命周期；[execution-context.ts](execution-context.ts) 负责 Skill 路径、保存会话身份与成果文件/URL 校验。

按问题找入口：

- `dispatchMatter` 选择或保留负责人、工作区与旁听成员（`observerMemberIds`），取得事项占用，保存交流并决定收尾；主成员正常回复后，列席旁听成员在 `runObservers` 中并行快速评估本轮讨论，无实质风险或补充时返回 `[SILENT]` 保持静默，仅在发现关键问题/遗漏时以独立发言存入 `user` 通道（带 `observerIntervention: true` 元数据）。
- `executeWithWorker` 按事项、成员、工作区 ID/路径及用户/内部/旁听模式恢复确切会话，装配实际能力。不能用最近会话或无限历史拼接替代恢复。
- `delegate` 由真实 `delegate_to_member` 工具触发，校验目标、调用链、重复执行和数量边界，将内部答案/错误返回调用者；桥接等待期间暂停父 worker 空闲看门狗，并向 `onProgress` 转发同事工具阶段与 `collabUpdated`。
- `abortMatter`、`shutdown` 传播取消并等待执行树清理；不要只改变界面状态。

内部委托成员与旁听成员均只做本职专业判断，工具装配与宿主校验均禁止其调用 `publish_deliverable`（旁听成员同时禁用 `delegate_to_member`）。只有主成员在形成可审阅阶段成果、明确版本或实质变化时，才通过 `publish_deliverable` 提供 `changeNote` 归档正式成果。过程回复、澄清及细小讨论调整只留对话；草稿须整轮成功后才归档。工具权限和最终写入都要保持这些规则，不能只在角色提示词里约定。

会话记录和占用由 [storage](../storage/README.md) 保存；工具注册与传输由 [rpc](../rpc/README.md) 实现；HTTP 状态与 SSE 消费见 [server](../server/README.md)。

从仓库根运行 `node --test test/continuity-collaboration.test.ts` 验证接续、范围隔离、委托、失败、取消和阶段交付。精确边界及兼容历史数据规则见[运行说明](../../docs/runtime-collaboration.md)。
