# 事项执行与角色协作

[team-orchestrator.ts](team-orchestrator.ts) 拥有一轮用户任务的生命周期；[execution-context.ts](execution-context.ts) 负责 Skill 路径、保存会话身份与成果文件/URL 校验；[matter-context.ts](matter-context.ts) 按历史消息中的工作区锚点筛选证据与有来源关联的成果，不以事项今天的绑定推断旧消息范围。

按问题找入口：

- `dispatchMatter` 选择或保留负责人、工作区与旁听成员（`observerMemberIds`），取得事项占用，保存交流并决定收尾；支持随用户消息传入可选 `images`（`PromptImageAttachment[]`），将轻量图片引用（`{ url, mimeType, name }`，不含原始 base64）存入用户消息 `metadata.images`，把 `ImageContent[]`（`{ type: "image", data, mimeType }`）同步传给主负责人及列席旁听 `runObservers` 的 `worker.runPromptAndWait`，并在无额外文字的纯图片消息中生成标题与指令兜底；主成员正常回复后，列席旁听成员在 `runObservers` 中并行快速评估本轮讨论，无实质风险或补充时返回 `[SILENT]` 保持静默，仅在发现关键问题/遗漏时以独立发言存入 `user` 通道（带 `observerIntervention: true` 元数据）。
- `executeWithWorker` 按事项、成员、工作区 ID/路径及用户/内部/旁听模式恢复确切会话，解析工作区所属 `Organization` 与 `resolveEffectiveGitIdentity`，在启动 `PiRpcWorker` 时注入 `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` 与 `PA_MEMBER_*` / `PA_ORG_*` 环境变量（使每次 Git 提交直接落在该岗位身份名下而不修改仓库 `.git/config`），并在 `buildMemberPrompt` 注入「角色与组织身份」段落及分三层组织的「岗位通用 / 组织记忆 / 仓库记忆」清单；同时装配实际能力（含面向主/内部成员的 `propose_experience`，旁听模式禁用）。不能用最近会话或无限历史拼接替代恢复；其中旁听模式首次接入事项时只注入精简的阶段摘要、已归档成果标题与最近对话摘录，不回放其他角色的完整过程记录或 `internal_collab` 细节。工具事件（`tool_execution_start` / `tool_execution_end`）仅将精简合法 JSON（工具名、截断后关键参数、`isError`）写入 `notice` 通道，避免超长工具输出被截断成非法 JSON。被注入的经验记录在 `memory_applications`，执行期的成果、经验提案和应用 ID 先暂存，成功子调用的暂存结果合并到父调用；只有主执行成功才统一提交。失败或取消的分支不留下候选经验；若当前工作区属于某组织，`propose_experience` 与 `distillExperiences` 均将 `company_private` 归入对应 `orgId`。
- `distillExperiences` 使用无状态、无工具/扩展/Skills 的只读 reflection pass，按当前工作区筛选用户纠偏、内部委托、异常、中断快照与反馈。指定成果时，证据截止其发布回复；候选只能归属实际参与成员或明确指定成员，写入前再次检查工作区与取消状态。同成员、同 scope、同 org、同 workspace 的无环替代关系才可提交。
- `delegate` 由真实 `delegate_to_member` 工具触发，校验目标、调用链、重复执行和数量边界，将内部答案/错误返回调用者；桥接等待期间暂停父 worker 空闲看门狗，并向 `onProgress` 转发同事工具阶段与 `collabUpdated`。
- `abortMatter`、`abortDistillation`、`shutdown` 传播取消并等待执行树与全部复盘清理后返回；中止与失败路径分别通过 `buildProgressSnapshot` 保留中断时的阶段、耗时、`activeDelegations` 与最近步骤摘要，并在同一事项工作区作用域续跑时由 `executeWithWorker` 为主负责人注入结构化的「上次中断状态简报」（仅作用于紧随中断后的下一轮，恢复成功后不重复带入旧报错）。其中 `abortDistillation(matterId)` 会立即中止该事项正在进行的 `distillExperiences` reflection worker 并丢弃未完成候选。

内部委托成员与旁听成员均只做本职专业判断，工具装配与宿主校验均禁止其调用 `publish_deliverable`（旁听成员同时禁用 `delegate_to_member`）。只有主成员在形成可审阅阶段成果、明确版本或实质变化时，才通过 `publish_deliverable` 结合 [technical-writing](../../skills/technical-writing/SKILL.md) 提供精简的 1–3 句 `changeNote` 与「核心结论 → 正文内容 → 交付过程与验证依据」结构归档正式成果。过程回复、澄清及细小讨论调整只留对话；草稿须整轮成功后才归档。工具权限和最终写入都要保持这些规则，不能只在角色提示词里约定。

会话记录和占用由 [storage](../storage/README.md) 保存；工具注册与传输由 [rpc](../rpc/README.md) 实现；HTTP 状态与 SSE 消费见 [server](../server/README.md)。

从仓库根运行 `node --test test/continuity-collaboration.test.ts test/rsi-boundaries.test.ts` 验证接续、范围隔离、委托、失败、取消和阶段交付。精确边界及兼容历史数据规则见[运行说明](../../docs/runtime-collaboration.md)。
