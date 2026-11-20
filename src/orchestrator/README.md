# 事项执行与角色协作

职责分工：

- [team-orchestrator.ts](team-orchestrator.ts) 组织事项、角色和处理器，对外提供派发、中止和关闭入口。[matter-dispatch.ts](matter-dispatch.ts) 执行单轮交流，从运行占用、消息入库到成果收尾，并由 [types.ts](types.ts)、[prompts.ts](prompts.ts)、
  [matter-initiation.ts](matter-initiation.ts)、[worker-runner.ts](worker-runner.ts)、[delegation-runner.ts](delegation-runner.ts)、
  [observer-runner.ts](observer-runner.ts) 与 [distiller.ts](distiller.ts) 分担立项适配诊断、提示词装配、Worker 执行、内部委托、旁听与复盘。
  - `assessInitiation`（[matter-initiation.ts](matter-initiation.ts)）提供实时本地文字规则预判，并由 `assessInitiationWithModel` 通过 [pi-decision.ts](pi-decision.ts)（`runTypedPiDecision`，类型化 JSON 契约校验 + 成员名录白名单约束 + 可选 `["read"]` 只读仓库核查 + `AbortSignal` 中止）发起按需 Pi LLM 决策，推荐参与人数/协作模式（`solo` / `lead_consult` / `lead_review` / `human_first`）及角色缺口；`role-architect` 元角色可通过正常 `dispatchMatter` 发起持久化对话或被中途请入业务事项（保持零工具 `--tools ""` 并自动注入业务名录与运行体检摘要，结果解析为消息 `metadata.roleProposals` 供用户勾选生效，且不接管普通业务事项的自动路由与自动旁听）；当事项收窄为单兵模式（`aiMemberIds.length === 1`）时，[worker-runner.ts](worker-runner.ts) 与 [prompts.ts](prompts.ts) 在运行时与提示词同步关闭 `delegate_to_member` 并注入 `antiJobs` 边界约束。
- [execution-context.ts](execution-context.ts) 负责 Skill 路径（通过 `realpath` 校验所解析 `SKILL.md` 必须落在内建 `skills/` 及该角色作用域允许的 `resolveAllowedSkillRoots` 目录内，阻止跨租户或工作区外路径穿越）、工作区顶层目录摘要 `listWorkspaceTopLevelEntries`（供无 `bash`/`ls` 的角色直接定位目标仓库文件）、保存会话身份与成果文件/URL 校验。`prepareDelivery` 从文档 `sourcePath` 读取正文并记录快照，`validateDelivery` 在成功提交前核对文件内容与路径未变；纯文本 `content` 文档不绑定文件。
- [team-health.ts](team-health.ts) 收集有 ID 的有限配置与协作案例供架构师体检引用，并支持按用户/组织过滤可见成员与最近案例，解析时过滤不存在的来源。`role-design` 方法全文由宿主提供给无业务工具的架构师；技能目录、能力状态和具体边界见[角色设计](../../docs/reference/role-design.md)。
- [matter-context.ts](matter-context.ts) 按历史消息中的工作区锚点筛选证据与有来源关联的成果，不以事项今天的绑定推断旧消息范围。
  筛选同时校验组织快照；旁听主题、摘要、断点简报与复盘均不得带入其他组织的旧背景。

按问题找入口：

- [prompts.ts](prompts.ts) 使用英文组装岗位指令、对话回放、旁听和续接提示。回复与成果默认跟随用户请求的语言，并保留标识符、命令、路径和固定输出格式。[meta-architect.ts](meta-architect.ts) 对架构师的 JSON 回复采用相同语言约定，并支持按目标 `roleScope`/`ownerOrgId`/`ownerUserId` 筛选可读成员与推荐可选 `newSkills` 草案。
- [matter-initiation.ts](matter-initiation.ts) 优先用角色的 `responsibilityKeywords` 作为本地规则的职责信号。内置岗位通过该字段保留旧的中文匹配词，缺省字段的模板仍从原有正向职责正文推导。

- `pstackDir` 可为正常岗位执行配置完整 pstack 方法包；[pstack.ts](../roles/pstack.ts) 检查来源并提供方法指引，[pstack-extension.ts](../rpc/pstack-extension.ts) 在 Pi 内按需读取模式、原则和 playbook。方法工具需通过握手，不增加岗位业务工具权限；独立 JSON 决策和反思不自动接入。启用与实机证据见[pstack 运行说明](../../docs/guides/pstack-runtime.md)。
- [role-design-decision.ts](role-design-decision.ts) 将用户指定的 ID、验证计划、约束、Anti-Jobs 与依赖保留到模型角色草案，同时按目标作用域校验并输出可选 `newSkills` 草案（`role_local` / 目标库位置，确认前不写盘）；已有缺失依赖仍须显示 `missing`。规则和模型设计都同时保留验证计划与额外约束。
- 决策结果的 `repoReadEnabled` 只表示开放只读工具，`usedRepoRead` / `repoReadPaths` 仅来自已完成且成功的工作区内读取记录；路径按真实文件解析，排除指向工作区外的符号链接。它们不证明模型正确理解或采用了文件内容。抛出异常的 Schema 校验统一归类为 `PiDecisionError.validation_error`。

- `dispatchMatter`：经 `resolveMatterAiMembers(matter, actorUserId)` 结合当前调用者上下文、组织级有效 AI 名册（含调用者个人私有角色）、事项 `aiMemberIds`、`observersEnabled` 与旁听成员确定可执行名单（`MatterRun.startedByUserId` 记录触发人并用于 [delegation-runner.ts](delegation-runner.ts) 拦截向他人 `personal` 角色的内部委托），
  取得事项占用，保存交流并决定收尾；`assessInitiation`、`routeMemberForRequest`、`buildMemberPrompt` 与 `delegate` 均受当前组织、调用者私有作用域与事项 AI 成员范围约束。
  - 支持可选 `author`（人类发送者 ID/姓名/角色/权限），自动记录非所有者同事到 `matter.collaboratorIds`。
  - `formatMessageHistorySpeaker` 回放讨论和提请时附带 `[Team discussion]` 或 `[Teammate request]`，并保留发言人姓名、角色与原文。
  - 支持可选 `images`（`PromptImageAttachment[]`）与 `files`（`PromptFileAttachment[]`），将轻量引用存入消息 `metadata.images` 与 `metadata.files`（不在 SQLite 重复存储大文本正文），并在回放历史 `formatMessageHistoryContent` 时附带附件摘要。
  - 并将 `ImageContent[]` 与分隔后的文件/折叠粘贴正文一并传给主负责人与旁听 `runObservers` Worker（纯图片或纯附件消息自动生成标题与指令兜底）。
  - 主成员正常回复后，旁听成员在 `runObservers` 中并行评估。宿主按触发者和事项名册筛选旁听角色。发现关键问题时在 `user` 通道补充，标记 `observerIntervention: true`。
  - `consultMemberIds` 与 `observerMemberIds` 独立。前者为空数组时不允许主责委托，为 `null` 时沿用旧事项全部可用在组成员的行为。
  - 讨论轮次使用独立会话键。未点名时由当前可用的主责或在组角色回复，点名时按提及顺序回复。讨论保留岗位工具用于查证，宿主关闭成果发布和经验提案。回复保留在事项历史，正式执行会回放同范围内新增的讨论消息。
- `executeWithWorker`：按事项、成员、工作区 ID/路径及用户/内部/旁听模式恢复确切会话（不用最近会话或无限历史拼接替代恢复），并装配实际能力（含面向主/内部成员的 `propose_experience`，旁听模式禁用）。
  - `v2` 会话键额外包含有效组织 ID。旧 `v1` 或无范围会话继续保留，但首次升级不自动恢复；新范围建立后可切回续接。详见[迁移说明](../../docs/reference/runtime-collaboration.md#兼容历史数据)。
  - 旁听模式首次接入事项时仅注入精简阶段摘要、已归档成果标题与最近对话摘录，不回放其他角色完整过程记录或 `internal_collab` 细节。
  - 经 `resolveMemberForOrg` 合并组织级 `organization_ai_roles` 覆盖后，结合工作区 `Organization` 与 `resolveRepoGitUserIdentity(cwd)` 读取目标仓库当前有效 `user.name` / `user.email`。
  - 默认（`organization.useRoleGitIdentity !== true` 或独立无组织仓库）**不注入** `GIT_AUTHOR_*` / `GIT_COMMITTER_*`，保持 `git commit` 使用目标仓库目录自身的 Git 配置；仅当所属组织显式启用 `useRoleGitIdentity` 时，经 `resolveEffectiveGitIdentity` 向 `PiRpcWorker` 注入角色/组织覆盖 `GIT_AUTHOR_*` 与仓库真实用户 `GIT_COMMITTER_*`（未配置真实用户时回退至角色身份），同时注入 `PA_MEMBER_*` / `PA_ORG_*` 环境变量（不改写目标仓库 `.git/config`）。
  - 在 `buildMemberPrompt` 中注入「角色与组织身份」、目标工作区作用域边界与顶层目录清单（并经 `PA_TARGET_WORKSPACE_ROOT` 在扩展内过滤掉宿主/父目录 `AGENTS.md`，同时在隔离辅助 pass `distiller.ts`/`meta-architect.ts`/`pi-decision.ts` 传入 `--no-context-files`），以及分三层组织的「岗位通用 / 组织记忆 / 仓库记忆」清单。
  - 工具事件（`tool_execution_start` / `tool_execution_end`）只写入精简合法 JSON（工具名、截断后关键参数、`isError`）到 `notice` 通道。
  - 注入的经验记入 `memory_applications`；成果草稿、经验提案（工作区属组织时 `company_private` 自动归入对应 `orgId`）与应用 ID 先暂存，主执行成功后再事务提交，失败或取消分支不保留候选。
- `distillExperiences`：使用无状态、无工具/扩展/Skills 的只读 reflection pass，按当前工作区筛选用户纠偏、内部委托、异常、中断快照与反馈（工作区属组织时 `company_private` 归入 `orgId`）。
  - 指定成果时证据截止其发布回复；候选仅可归属实际参与成员或明确指定成员，写入前再次检查工作区与取消状态，且仅允许同成员、同 scope、同 org、同 workspace 的无环替代关系。
- `delegate`：由真实 `delegate_to_member` 工具触发，校验目标、调用链、重复执行和数量边界，将内部答案/错误返回调用者。
  - 桥接等待期间暂停父 worker 空闲看门狗，并向 `onProgress` 转发同事工具阶段与 `collabUpdated`。
  - [独立验收](independent-verification.ts) 解析具体提交、文件或文档草稿，绑定版本和来源委托。验收专用会话限制工具范围。送审文档在 [单轮派发](matter-dispatch.ts) 中按最终摘要重验归档条件。
- [运行巡检](turn-monitor.ts) 追踪当轮 Worker 的活动、工具和等待状态。计时器由单轮派发清理，停滞提醒通过现有进度流和事项事件传播。
- `abortMatter`、`abortDistillation`、`shutdown`：传播取消并等待执行树与全部复盘清理后返回。
  - 中止与失败路径通过 `buildProgressSnapshot` 保留停滞阶段、耗时、`activeDelegations` 与最近步骤摘要，并在同一事项工作区续跑时为主负责人注入一次「上次中断状态简报」。
  - `abortDistillation(matterId)` 会立即中止进行中的 `distillExperiences` Worker 并丢弃未完成候选。

- 内部委托成员与旁听成员均只做本职专业判断，工具装配与宿主校验均禁止其调用 `publish_deliverable`（旁听成员同时禁用 `delegate_to_member`）。
- 只有主成员在形成可审阅阶段成果、明确版本或实质变化时，才通过 `publish_deliverable` 结合 [technical-writing](../../skills/technical-writing/SKILL.md) 归档正式成果：
  - 输出精简的 1–3 句 `changeNote` 与「核心结论 → 正文内容 → 交付过程与验证依据」结构。
  - 过程回复与澄清只留对话，草稿须整轮成功后才归档；工具权限和最终写入都要保持这些规则，不能只在角色提示词里约定。
  - 已落盘文档使用 `sourcePath`，宿主直接读取正文；不同时传 `content`。来源变化后须重新登记最终文件，同轮同标题文档替换草稿，跨轮保留版本。文件快照一致性不代表正文语义正确。
  - [publication-review.ts](publication-review.ts) 向主负责人提供发布前的事实、跨章节规则与验收一致性复核方法，要求发现专业矛盾后实际咨询并修订；这是工作方法，不是宿主语义验收门禁。实际效果通过[对照验证](../../docs/validation/publication-review.md)检查。

会话记录和占用由 [storage](../storage/README.md) 保存；工具注册与传输由 [rpc](../rpc/README.md) 实现；HTTP 状态与 SSE 消费见 [server](../server/README.md)。

从仓库根运行 `node --test test/continuity-collaboration.test.ts test/rsi-boundaries.test.ts` 验证接续、范围隔离、委托、失败、取消和阶段交付。
精确边界及兼容历史数据规则见[运行说明](../../docs/reference/runtime-collaboration.md)。

模型选择在[编排层](model-selection.ts)按事项、组织和平台配置解析，再由 Pi 决定缺省值。主负责人在同一个 Pi 会话中切换，内部委托和旁听分别读取自己的组织岗位配置。运行就绪记录包含实际供应商、模型和思考等级。
