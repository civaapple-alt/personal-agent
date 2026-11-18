# 事项执行与角色协作

职责分工：

- [team-orchestrator.ts](team-orchestrator.ts) 拥有一轮用户任务的生命周期，并由 [types.ts](types.ts)、[prompts.ts](prompts.ts)、
  [matter-initiation.ts](matter-initiation.ts)、[worker-runner.ts](worker-runner.ts)、[delegation-runner.ts](delegation-runner.ts)、
  [observer-runner.ts](observer-runner.ts) 与 [distiller.ts](distiller.ts) 分担立项适配诊断、提示词装配、Worker 执行、内部委托、旁听与复盘。
  - `assessInitiation`（[matter-initiation.ts](matter-initiation.ts)）提供实时本地文字规则预判，并由 `assessInitiationWithModel` 通过 [pi-decision.ts](pi-decision.ts)（`runTypedPiDecision`，类型化 JSON 契约校验 + 成员名录白名单约束 + 可选 `["read"]` 只读仓库核查 + `AbortSignal` 中止）发起按需 Pi LLM 决策，推荐参与人数/协作模式（`solo` / `lead_consult` / `lead_review` / `human_first`）及角色缺口；`role-architect` 元角色可通过正常 `dispatchMatter` 发起持久化对话或被中途请入业务事项（保持零工具 `--tools ""` 并自动注入业务名录与运行体检摘要，结果解析为消息 `metadata.roleProposals` 供用户勾选生效，且不接管普通业务事项的自动路由与自动旁听）；当事项收窄为单兵模式（`aiMemberIds.length === 1`）时，[worker-runner.ts](worker-runner.ts) 与 [prompts.ts](prompts.ts) 在运行时与提示词同步关闭 `delegate_to_member` 并注入 `antiJobs` 边界约束。
- [execution-context.ts](execution-context.ts) 负责 Skill 路径、保存会话身份与成果文件/URL 校验。`prepareDelivery` 从文档 `sourcePath` 读取正文并记录快照，`validateDelivery` 在成功提交前核对文件内容与路径未变；纯文本 `content` 文档不绑定文件。
- [team-health.ts](team-health.ts) 收集有 ID 的有限配置与协作案例供架构师体检引用，解析时过滤不存在的来源。`role-design` 方法全文由宿主提供给无业务工具的架构师；技能目录、能力状态和具体边界见[角色设计](../../docs/role-design.md)。
- [matter-context.ts](matter-context.ts) 按历史消息中的工作区锚点筛选证据与有来源关联的成果，不以事项今天的绑定推断旧消息范围。
  筛选同时校验组织快照；旁听主题、摘要、断点简报与复盘均不得带入其他组织的旧背景。

按问题找入口：

- [prompts.ts](prompts.ts) 使用英文组装岗位指令、对话回放、旁听和续接提示。回复与成果默认跟随用户请求的语言，并保留标识符、命令、路径和固定输出格式。[meta-architect.ts](meta-architect.ts) 对架构师的 JSON 回复采用相同语言约定。
- [matter-initiation.ts](matter-initiation.ts) 优先用角色的 `responsibilityKeywords` 作为本地规则的职责信号。内置岗位通过该字段保留旧的中文匹配词，缺省字段的模板仍从原有正向职责正文推导。

- `pstackDir` 可为正常岗位执行配置完整 pstack 方法包；[pstack.ts](../roles/pstack.ts) 检查来源并提供方法指引，[pstack-extension.ts](../rpc/pstack-extension.ts) 在 Pi 内按需读取模式、原则和 playbook。方法工具需通过握手，不增加岗位业务工具权限；独立 JSON 决策和反思不自动接入。启用与实机证据见[pstack 运行说明](../../docs/pstack-runtime.md)。
- [role-design-decision.ts](role-design-decision.ts) 将用户指定的 ID、验证计划、约束、Anti-Jobs 与依赖保留到模型角色草案；只有模型新增的 Skill 限于已安装目录，显式缺失依赖仍须显示 `missing`。规则和模型设计都同时保留验证计划与额外约束。
- 决策结果的 `repoReadEnabled` 只表示开放只读工具，`usedRepoRead` / `repoReadPaths` 仅来自已完成且成功的工作区内读取记录；路径按真实文件解析，排除指向工作区外的符号链接。它们不证明模型正确理解或采用了文件内容。抛出异常的 Schema 校验统一归类为 `PiDecisionError.validation_error`。

- `dispatchMatter`：结合事项 `aiMemberIds`（`NULL` 默认全员 AI）、`observersEnabled` 与旁听成员选择或保留负责人与工作区，
  取得事项占用，保存交流并决定收尾；`routeMemberForRequest`、`buildMemberPrompt` 与 `delegate` 均受当前事项 AI 成员范围约束。
  - 支持可选 `author`（人类发送者 ID/姓名/角色/权限），自动记录非所有者同事到 `matter.collaboratorIds`。
  - `formatMessageHistorySpeaker` 回放讨论和提请时附带 `[Team discussion]` 或 `[Teammate request]`，并保留发言人姓名、角色与原文。
  - 支持可选 `images`（`PromptImageAttachment[]`），将轻量图片引用（`{ url, mimeType, name }`，不含原始 base64）存入消息 `metadata.images`。
  - 并将 `ImageContent[]` 同步传给主负责人与旁听 `runObservers` Worker（纯图片消息自动生成标题与指令兜底）。
  - 主成员正常回复后，旁听成员在 `runObservers` 中并行快速评估本轮讨论；无实质风险或补充时返回 `[SILENT]` 保持静默，仅在发现关键问题/遗漏时以独立发言存入 `user` 通道（带 `observerIntervention: true` 元数据）。
- `executeWithWorker`：按事项、成员、工作区 ID/路径及用户/内部/旁听模式恢复确切会话（不用最近会话或无限历史拼接替代恢复），并装配实际能力（含面向主/内部成员的 `propose_experience`，旁听模式禁用）。
  - `v2` 会话键额外包含有效组织 ID。旧 `v1` 或无范围会话继续保留，但首次升级不自动恢复；新范围建立后可切回续接。详见[迁移说明](../../docs/runtime-collaboration.md#兼容历史数据)。
  - 旁听模式首次接入事项时仅注入精简阶段摘要、已归档成果标题与最近对话摘录，不回放其他角色完整过程记录或 `internal_collab` 细节。
  - 依据工作区 `Organization` 与 `resolveEffectiveGitIdentity` 解析角色署名，并用 `resolveRepoGitUserIdentity(cwd)`
    读取目标仓库当前有效 `user.name` / `user.email`。
  - 向 `PiRpcWorker` 注入角色 `GIT_AUTHOR_*` 与真实用户 `GIT_COMMITTER_*`（未配置真实用户时回退至角色身份），
    同时注入 `PA_MEMBER_*` / `PA_ORG_*` 环境变量（不改写目标仓库 `.git/config`）。
  - 在 `buildMemberPrompt` 中注入「角色与组织身份」及分三层组织的「岗位通用 / 组织记忆 / 仓库记忆」清单。
  - 工具事件（`tool_execution_start` / `tool_execution_end`）只写入精简合法 JSON（工具名、截断后关键参数、`isError`）到 `notice` 通道。
  - 注入的经验记入 `memory_applications`；成果草稿、经验提案（工作区属组织时 `company_private` 自动归入对应 `orgId`）与应用 ID 先暂存，主执行成功后再事务提交，失败或取消分支不保留候选。
- `distillExperiences`：使用无状态、无工具/扩展/Skills 的只读 reflection pass，按当前工作区筛选用户纠偏、内部委托、异常、中断快照与反馈（工作区属组织时 `company_private` 归入 `orgId`）。
  - 指定成果时证据截止其发布回复；候选仅可归属实际参与成员或明确指定成员，写入前再次检查工作区与取消状态，且仅允许同成员、同 scope、同 org、同 workspace 的无环替代关系。
- `delegate`：由真实 `delegate_to_member` 工具触发，校验目标、调用链、重复执行和数量边界，将内部答案/错误返回调用者。
  - 桥接等待期间暂停父 worker 空闲看门狗，并向 `onProgress` 转发同事工具阶段与 `collabUpdated`。
- `abortMatter`、`abortDistillation`、`shutdown`：传播取消并等待执行树与全部复盘清理后返回。
  - 中止与失败路径通过 `buildProgressSnapshot` 保留停滞阶段、耗时、`activeDelegations` 与最近步骤摘要，并在同一事项工作区续跑时为主负责人注入一次「上次中断状态简报」。
  - `abortDistillation(matterId)` 会立即中止进行中的 `distillExperiences` Worker 并丢弃未完成候选。

- 内部委托成员与旁听成员均只做本职专业判断，工具装配与宿主校验均禁止其调用 `publish_deliverable`（旁听成员同时禁用 `delegate_to_member`）。
- 只有主成员在形成可审阅阶段成果、明确版本或实质变化时，才通过 `publish_deliverable` 结合 [technical-writing](../../skills/technical-writing/SKILL.md) 归档正式成果：
  - 输出精简的 1–3 句 `changeNote` 与「核心结论 → 正文内容 → 交付过程与验证依据」结构。
  - 过程回复与澄清只留对话，草稿须整轮成功后才归档；工具权限和最终写入都要保持这些规则，不能只在角色提示词里约定。
  - 已落盘文档使用 `sourcePath`，宿主直接读取正文；不同时传 `content`。来源变化后须重新登记最终文件，同轮同标题文档替换草稿，跨轮保留版本。文件快照一致性不代表正文语义正确。
  - [publication-review.ts](publication-review.ts) 向主负责人提供发布前的事实、跨章节规则与验收一致性复核方法，要求发现专业矛盾后实际咨询并修订；这是工作方法，不是宿主语义验收门禁。实际效果通过[对照验证](../../docs/publication-review.md)检查。

会话记录和占用由 [storage](../storage/README.md) 保存；工具注册与传输由 [rpc](../rpc/README.md) 实现；HTTP 状态与 SSE 消费见 [server](../server/README.md)。

从仓库根运行 `node --test test/continuity-collaboration.test.ts test/rsi-boundaries.test.ts` 验证接续、范围隔离、委托、失败、取消和阶段交付。
精确边界及兼容历史数据规则见[运行说明](../../docs/runtime-collaboration.md)。
