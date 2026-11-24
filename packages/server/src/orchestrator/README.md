# 事项执行与角色协作

职责分工：

- [team-orchestrator.ts](team-orchestrator.ts) 组织事项、角色和处理器，对外提供派发、中止和关闭入口。[matter-dispatch.ts](execution/matter-dispatch.ts) 执行单轮交流，从运行占用、消息入库到成果收尾，并由 [types.ts](types.ts)、[prompts.ts](execution/prompts.ts)、
  [matter-initiation.ts](architect/matter-initiation.ts)、[worker-runner.ts](execution/worker-runner.ts)、[delegation-runner.ts](execution/delegation-runner.ts) 与 [observer-runner.ts](execution/observer-runner.ts) 分担立项适配诊断、提示词装配、Worker 执行、内部委托与旁听。
  - `assessInitiation`（[matter-initiation.ts](architect/matter-initiation.ts)）提供实时本地文字规则预判，并由 `assessInitiationWithModel` 通过 [pi-decision.ts](architect/pi-decision.ts)（`runTypedPiDecision`，类型化 JSON 契约校验 + 成员名录白名单约束 + 可选 `["read"]` 只读仓库核查 + `AbortSignal` 中止）发起按需 Pi LLM 决策，推荐参与人数/协作模式（`solo` / `lead_consult` / `lead_review` / `human_first`）及角色缺口；`role-architect` 元角色可通过正常 `dispatchMatter` 发起持久化对话或被中途请入业务事项（使用共享运行工具，按配置装配工作台帮助与方法扩展，并自动注入业务名录与运行体检摘要，结果解析为消息 `metadata.roleProposals` 供用户勾选生效，且不接管普通业务事项的自动路由与自动旁听）；当事项收窄为单兵模式（`aiMemberIds.length === 1`）时，[worker-runner.ts](execution/worker-runner.ts) 与 [prompts.ts](execution/prompts.ts) 在运行时关闭 `delegate_to_member`。岗位的 `antiJobs` 边界保留在系统提示中。
- [execution-context.ts](execution/execution-context.ts) 负责 Skill 路径（通过 `realpath` 校验所解析 `SKILL.md` 必须落在内建 `skills/` 及该角色作用域允许的 `resolveAllowedSkillRoots` 目录内，阻止跨租户或工作区外路径穿越）、按原生 Pi 规则编码会话目录 `resolveScopedPiSessionDir`、工作区顶层目录摘要 `listWorkspaceTopLevelEntries`（供无 `bash`/`ls` 的角色直接定位目标仓库文件）、保存会话身份与成果文件/URL 校验。[workspace-customizations.ts](runtime/workspace-customizations.ts) 统一扫描多目录工作区的 `AGENTS.md`/`CLAUDE.md` 与 `.agents/skills`/`.pi/skills`，按 Token 预算（默认 20,000 tokens）统计并自动将超限附加规则降级为路径指针，在 [worker-runner.ts](execution/worker-runner.ts) 中经 `--skill` 与 `team-extension` 的 `before_agent_start` `contextFiles` 注入。
- [team-health.ts](rsi/team-health.ts) 收集有 ID 的有限配置与协作案例供架构师体检引用，并支持按用户/组织过滤可见成员与最近案例，解析时过滤不存在的来源。`role-design` 方法全文由宿主提供给无业务工具的架构师；技能目录、能力状态和具体边界见[角色设计](../../../../docs/reference/role-design.md)。
- [matter-context.ts](runtime/matter-context.ts) 按历史消息中的工作区锚点筛选证据与有来源关联的成果，不以事项今天的绑定推断旧消息范围。
  筛选同时校验组织快照；旁听主题、摘要、断点简报与复盘均不得带入其他组织的旧背景。
- [team-capabilities.ts](runtime/team-capabilities.ts) 给主责提供当前可见事项成员的角色声明、委托状态和同事项同工作区最近一次内部协作启动清单，标注来源时间、轮次及模式。启动清单是历史证据，不预测下一次运行；`read_pa_help` 的 `team_capabilities` 提供同一视图。
- 独立合成场景的真实模型检查使用 `npm run demo:team:capabilities`，保留启动事件、回复和内部消息，仍需人工审阅；详见[运行验证](../../../../docs/validation/runtime-checks.md)。
- GitHub `fetch_content` 结束后，岗位运行器在事项事件中记录工具明确报告的获取方式、去除参数的来源和截断标记；不把临时路径当作持久工作区。续接时团队扩展对已知失效的临时路径补充提示。

- [conversation-intent.ts](architect/conversation-intent.ts) 通过 [system-one.ts](architect/system-one.ts) 调用 Jev，也可降级到隔离 Pi 决策和本地规则。编排核保留事项占用、授权证据和成员范围校验。[matter-roster-query.ts](runtime/matter-roster-query.ts) 直接从当前事项配置生成名单。
- [initiation-classifier.ts](architect/initiation-classifier.ts) 在用户主动请求参与建议时评估主责、请教和旁听。岗位缺口说明与选中的仓库只读预判由 Pi 决策生成。

按问题找入口：

- [prompts.ts](execution/prompts.ts) 使用英文组装岗位指令、对话回放、旁听和续接提示。回复与成果默认跟随用户请求的语言，并保留标识符、命令、路径和固定输出格式。[meta-architect.ts](architect/meta-architect.ts) 对架构师的 JSON 回复采用相同语言约定，并支持按目标 `roleScope`/`ownerOrgId`/`ownerUserId` 筛选可读成员与推荐可选 `newSkills` 草案。
- [matter-initiation.ts](architect/matter-initiation.ts) 优先用角色的 `responsibilityKeywords` 作为本地规则的职责信号。内置岗位通过该字段保留旧的中文匹配词，缺省字段的模板仍从原有正向职责正文推导。

- 角色可在 Pi 资源目录中查看 Skill 与已加载扩展命令的名称和用途，按需读取方法或提交插件命令；命令提交不证明执行成功。独立 JSON 决策和反思沿用各自的隔离配置。 [Skill 配置](../../../../docs/guides/pstack-runtime.md)
- [团队扩展集成](../extensions/README.md#团队扩展) 给岗位提供本轮工具清单和启动环境。编排器使用同一组能力判断校验桥接调用。
- 安装网页检索扩展后，所有事项岗位执行均可用；历史 `webAccessDeniedRoles` 停用名单不再生效。[PA 扩展集成](../extensions/README.md#web-access) 为主责、内部成员、旁听与验收解析已安装的扩展入口及工具清单。
- [role-design-decision.ts](architect/role-design-decision.ts) 将用户指定的 ID、验证计划、约束、Anti-Jobs 与依赖保留到模型角色草案，同时按目标作用域校验并输出可选 `newSkills` 草案（`role_local` / 目标库位置，确认前不写盘）；已有缺失依赖仍须显示 `missing`。规则和模型设计都同时保留验证计划与额外约束。
- 决策结果的 `repoReadEnabled` 只表示开放只读工具，`usedRepoRead` / `repoReadPaths` 仅来自已完成且成功的工作区内读取记录；路径按真实文件解析，排除指向工作区外的符号链接。它们不证明模型正确理解或采用了文件内容。抛出异常的 Schema 校验统一归类为 `PiDecisionError.validation_error`。

- 工作台统一发送默认由主责回应。HTTP 层解析点名，只有人类同事被点名时直接保存消息；有派发权限时按角色配置的工具和单一主责 Pi 会话运行。前置路由处理名单查询、工作台速查和无主责时的自动选人。点名只作用于本轮，空间工具的写入由当前事项主责执行。
- `dispatchMatter`：经 `resolveMatterAiMembers(matter, actorUserId)` 结合当前调用者上下文、组织级有效 AI 名册（含调用者个人私有角色）、事项 `aiMemberIds`、`observersEnabled` 与旁听成员确定可执行名单（`MatterRun.startedByUserId` 记录触发人并用于 [delegation-runner.ts](execution/delegation-runner.ts) 拦截向他人 `personal` 角色的内部委托），
  取得事项占用，保存交流并决定收尾；`assessInitiation`、`routeMemberForRequest`、`buildMemberPrompt` 与 `delegate` 均受当前组织、调用者私有作用域与事项 AI 成员范围约束。
  - 支持可选 `author`（人类发送者 ID/姓名/角色/权限），自动记录非所有者同事到 `matter.collaboratorIds`。
  - `formatMessageHistorySpeaker` 回放讨论和提请时附带 `[Team discussion]` 或 `[Teammate request]`，并保留发言人姓名、角色与原文。
  - 支持可选 `images`（`PromptImageAttachment[]`）与 `files`（`PromptFileAttachment[]`），将轻量引用存入消息 `metadata.images` 与 `metadata.files`（不在 SQLite 重复存储大文本正文），并在回放历史 `formatMessageHistoryContent` 时附带附件摘要。
  - 并将 `ImageContent[]` 与分隔后的文件/折叠粘贴正文一并传给主负责人与旁听 `runObservers` Worker（纯图片或纯附件消息自动生成标题与指令兜底）。
  - 主成员正常回复后，旁听成员在 `runObservers` 中并行评估。宿主按触发者和事项名册筛选旁听角色。发现关键问题时在 `user` 通道补充，标记 `observerIntervention: true`。
  - `consultMemberIds` 与 `observerMemberIds` 独立。前者为空数组时不允许主责委托，为 `null` 时沿用旧事项全部可用在组成员的行为。
  - 讨论轮次使用独立会话键。未点名时由当前可用的主责或在组角色回复，点名时按提及顺序回复。明确查询当前成员时，服务端按当前事项配置返回共享 AI 名册。每轮模型上下文也以运行时名册为准。讨论保留岗位工具用于查证，宿主关闭成果发布和经验提案。回复保留在事项历史，正式执行会回放同范围内新增的讨论消息。
- `executeWithWorker`：按事项、成员、工作区 ID/路径及用户/内部/旁听模式恢复确切会话（不用最近会话或无限历史拼接替代恢复），并装配实际能力（含面向主/内部成员的 `propose_skill`，旁听模式禁用）。
  - 会话键包含有效组织 ID。含个人角色上下文时，再按触发用户隔离 Pi 会话；切回已有范围时可续接。详见[数据与会话边界](../../../../docs/reference/runtime-collaboration.md#数据与会话边界)。
  - 旁听模式首次接入事项时仅注入精简阶段摘要、已归档成果标题与最近对话摘录，不回放其他角色完整过程记录或 `internal_collab` 细节。
  - 经 `resolveMemberForOrg` 合并组织级 `organization_ai_roles` 覆盖后，结合工作区 `Organization` 与 `resolveRepoGitUserIdentity(cwd)` 读取目标仓库当前有效 `user.name` / `user.email`。
  - [prompts.ts](execution/prompts.ts) 将岗位规则、工作区约束和运行模式保存在系统提示中。实时名册、适用经验、目录清单和身份信息通过 `PA_TURN_CONTEXT` 追加到 Pi 会话。角色架构师的业务名录、Skill 目录和体检证据也随轮更新。
  - 默认（`organization.useRoleGitIdentity !== true` 或独立无组织仓库）**不注入** `GIT_AUTHOR_*` / `GIT_COMMITTER_*`，保持 `git commit` 使用目标仓库目录自身的 Git 配置；仅当所属组织显式启用 `useRoleGitIdentity` 时，经 `resolveEffectiveGitIdentity` 向 `PiRpcWorker` 注入角色/组织覆盖 `GIT_AUTHOR_*` 与仓库真实用户 `GIT_COMMITTER_*`（未配置真实用户时回退至角色身份），同时注入 `PA_MEMBER_*` / `PA_ORG_*` 环境变量（不改写目标仓库 `.git/config`）。
  - 在 `buildMemberPrompt` 中注入「角色与组织身份」、目标工作区作用域边界与顶层目录清单（并经 `PA_TARGET_WORKSPACE_ROOT` 在扩展内过滤掉宿主/父目录 `AGENTS.md`，同时在隔离辅助 pass `meta-architect.ts`/`pi-decision.ts` 传入 `--no-context-files`，且 `meta-architect.ts` 仅开放只读工具 `read,grep,find,ls`）。
  - 工具事件（`tool_execution_start` / `tool_execution_end`）只写入精简合法 JSON（工具名、截断后关键参数、`isError`）到 `notice` 通道。执行进度快照保留最近活动的工具状态，页面按来源轮次和范围重建实际工具调用及 Skill 读取；已注册不等于已调用，读取不等于应用。
  - 成果草稿与 `propose_skill` 提案先暂存，主执行成功后再提交，失败或取消分支不保留候选。
- 持久化澄清由 [human-decision.ts](human-decision.ts) 定义。主责在正式执行中提请人类决定，协作者将问题回交委托者。具体状态和分工见[运行说明](../../../../docs/reference/runtime-collaboration.md#等待人类决定)。
- `delegate`：由真实 `delegate_to_member` 工具触发，校验目标、调用链、重复执行和数量边界，将内部答案/错误返回调用者。
  - 桥接等待期间暂停父 worker 空闲看门狗，并向 `onProgress` 转发同事工具阶段与 `collabUpdated`。
  - [独立验收](execution/independent-verification.ts) 解析具体提交、文件或文档草稿，绑定版本和来源委托。验收专用会话使用共享运行工具。送审文档在 [单轮派发](execution/matter-dispatch.ts) 中按最终摘要重验归档条件。
- [运行巡检](execution/turn-monitor.ts) 追踪当轮 Worker 的活动、工具和等待状态。计时器由单轮派发清理，停滞提醒通过现有进度流和事项事件传播。
- `abortMatter`、`shutdown`：传播取消并等待执行树清理后返回。
  - 正常完成、中止与失败路径均通过 `buildProgressSnapshot` 写入 `metadata.progressSnapshot`（`outcome`: `"completed" | "aborted" | "failed"`），保留阶段、耗时、`activeDelegations` 与最多 60 条 `recentLogs` 活动轨迹；其中只有 `aborted`/`failed` 快照会在同事项工作区续跑时为主负责人注入「上次中断状态简报」。讨论中点名多位成员时，失败快照记录报错时正在执行的角色。

- 内部委托成员与旁听成员不能通过 `save_space_page` 直接修改事项资料。主责、内部成员、旁听和独立验收共享可用的基础工具、已配置扩展及 MCP；实际能力以启动握手为准。Pi 以服务账号权限运行，不是操作系统沙箱。
- 主成员可通过 `save_space_page` 将计划、过程资料直接提交到当前事项默认空间的独立 Git 仓库（私密事项自动路由至发起人的个人空间 `spc_usr_<userId>`，非私密事项按仓库空间优先、其次组织空间）；传入 `sourcePath` 时同步记录 `linked_org_id`、`linked_workspace_id`、`linked_file_path` 关联，并在本轮回复消息的 `metadata.spaceDocuments` 中精确绑定记录。业务代码仓的 `write` / `edit` 修改保留在业务仓库本身。
  - [publication-review.ts](execution/publication-review.ts) 向主负责人提供发布前的事实、跨章节规则与验收一致性复核方法，要求发现专业矛盾后实际咨询并修订；这是工作方法，不是宿主语义验收门禁。实际效果通过[对照验证](../../../../docs/validation/publication-review.md)检查。

会话记录和占用由 [storage](../storage/README.md) 保存；工具注册与传输由 [rpc](../rpc/README.md) 实现；HTTP 状态与 SSE 消费见 [server](../server/README.md)。

从仓库根运行 `node --test test/continuity-collaboration.test.ts test/rsi-boundaries.test.ts` 验证接续、范围隔离、委托、失败、取消和阶段交付。
精确边界见[运行说明](../../../../docs/reference/runtime-collaboration.md)。

模型选择在[编排层](runtime/model-selection.ts)按事项、组织和平台配置解析，再由 Pi 决定缺省值。主负责人在同一个 Pi 会话中切换，内部委托和旁听分别读取自己的组织岗位配置。运行就绪记录包含实际供应商、模型和思考等级。
