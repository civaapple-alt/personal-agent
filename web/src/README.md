# 前端状态与组件

[main.tsx](main.tsx) 挂载应用并排列样式加载顺序。[App.tsx](App.tsx) 装配页面、导航、bootstrap/事项详情刷新与 SSE 同步。认证、草稿、事项范围和面板加载分别由下表中的 hooks 维护，页面内的临时状态留在所属组件。

[WorkbenchBanners](components/WorkbenchBanners.tsx) 在各页共用的区域显示操作错误与通知，支持手动关闭、辅助技术播报，并在顶部轻量通知空闲 4.5 秒后自动隐藏（鼠标悬停或聚焦时暂停倒计时）；团队、资料及成果页不必跳回聊天查看结果。[TeamView](components/TeamView.tsx) 捕获主联系人设置及导出失败并上报；[MemberCard](components/team/MemberCard.tsx) 菜单打开后聚焦首项，支持方向键、Home/End、Escape 返回触发按钮及 Tab 离开。无经验时「详情与经验」先展示职责和身份，组织的编辑/设为默认入口仅供所有者显示，服务端权限校验仍是实际约束。

| 修改目标 | 入口 |
| --- | --- |
| HTTP DTO 和请求 | [api.ts](api.ts) 集中导出。[client.ts](api/client.ts) 处理请求错误和会话吊销。[matters.ts](api/matters.ts)、[team.ts](api/team.ts)、[organizations.ts](api/organizations.ts)、[deliverables.ts](api/deliverables.ts)、[experiences.ts](api/experiences.ts) 按业务维护契约，与各自服务响应一起核对 |
| 会话、注册和邀请 | [useAuthSession](hooks/useAuthSession.ts)、[OrgInviteModal](components/OrgInviteModal.tsx) |
| 当前事项有效工作区、组织与成员 | [useMatterScope](hooks/useMatterScope.ts) |
| 设置及超管页面加载与刷新 | [useWorkbenchPanels](hooks/useWorkbenchPanels.ts) |
| Hash 路由、浏览器前进后退和视图切换 | [hashRouter.ts](hashRouter.ts)、[useHashRouteNav](hooks/useHashRouteNav.ts)、[ViewFade](components/ViewTransitions.tsx) |
| Markdown 展示 | [MarkdownView.tsx](MarkdownView.tsx)；保持无 `dangerouslySetInnerHTML` 的渲染边界 |
| 布局与共用样式/格式 | [styles/tokens.css](styles/tokens.css)（`--text-*` 字号阶梯、`--page-pad-*`/`--section-gap`）、[styles/primitives.css](styles/primitives.css)（`.ui-sections-stack`、`.ui-section*`、`.ui-card` 等原语）及 [utils.ts](utils.ts)（聚合导出 [formatters.ts](utils/formatters.ts)、[matterStream.ts](utils/matterStream.ts)、[orgRoster.ts](utils/orgRoster.ts)） |
| 输入和附件草稿、附件预处理与粘贴折叠 | [useComposerDraft](hooks/useComposerDraft.ts) 管理草稿和数量限制。[imageAttachments.ts](imageAttachments.ts)（图片缩放压缩与 DOM 文件读取）与 [textAttachments.ts](textAttachments.ts)（UTF-8 文本/代码文件校验与长粘贴折叠判断）；附件灯箱与可取消远程预览位于 [AttachmentPreviewModals](components/chat/AttachmentPreviewModals.tsx) |
| 事项导航、会话、运行状态 | [Sidebar](components/Sidebar.tsx)（`memo` 包裹，传入的回调须保持引用稳定，用 [useStableCallback](hooks/useStableCallback.ts)）、[ElapsedTimer](components/ElapsedTimer.tsx)（运行耗时由该叶子组件自行每秒计时，根组件不再随计时器整树重渲染）、[ChatStage](components/ChatStage.tsx)（滚动吸底由 [useChatScroll](hooks/useChatScroll.ts) 维护，参与者/组织/名册投影由 [useChatStageParticipants](hooks/useChatStageParticipants.ts) 维护，右侧分屏文档由 [useMatterSideDocs](hooks/useMatterSideDocs.ts) 与 [MatterDocSidePane](components/chat/MatterDocSidePane.tsx) 维护，底部吸附澄清由 [useActiveClarification](hooks/useActiveClarification.ts) 与 [FloatingClarificationDock](components/chat/FloatingClarificationDock.tsx) 维护，对话空间文档卡位于 [SpaceDocumentCard](components/chat/SpaceDocumentCard.tsx)）、[ExploringStatus](components/ExploringStatus.tsx) |
| 资料空间（五类 Git 空间、五类内容类型筛选、单文件/目录条目与静态预览、跨空间最近修改、关联仓库路径与 Diff） | [DeliverablesView](components/DeliverablesView.tsx)、[SpacePages](components/SpacePages.tsx)、[SpaceFolderFilesPanel](components/SpaceFolderFilesPanel.tsx)、[space API](api/space.ts) |
| AI 团队、组织、工作区及头像 | [TeamView](components/TeamView.tsx)（专注 AI 角色名录、经验核验、角色包与协作体检）、[OrganizationsView](components/OrganizationsView.tsx) + [OrganizationDetailPanel](components/OrganizationDetailPanel.tsx)（独立「组织」两栏页，管理人类成员与邀请、组织启用的 AI 角色与主联系人、关联工作区）、[ExperienceReviewPanel](components/ExperienceReviewPanel.tsx)、[MaterialsView](components/MaterialsView.tsx)（左侧按组织分组的工作区导航 + 右侧内联 [WorkspaceDetailPanel](components/WorkspaceDetailPanel.tsx) 展示多目录、Rules/Skills 预算明细与事项/资料动态，接口位于 [workspaceFolders API](api/workspaceFolders.ts)）、[BotFaceIcon](components/BotFaceIcon.tsx) |
| 设置、Agent 底座与扩展视图 | [SettingsView](components/SettingsView.tsx) 展示 Pi 底座、扩展及运行配置；[PstackSettings](components/PstackSettings.tsx)、[WebAccessSettings](components/WebAccessSettings.tsx)（内嵌搜索密钥与在线测试搜索）与 [SystemOneSettings](components/SystemOneSettings.tsx)（内嵌 TypeSafe 密钥、启停开关与连通性测试）分别管理各自扩展 |
| 账号门禁与超级管理员控制台 | [AuthGateView](components/AuthGateView.tsx)（超管首次初始化、邮箱密码登录/开放注册、待审核提示及 `?invite=` / `orginv_` 加入组织）、[AdminView](components/AdminView.tsx)（对应 `#/admin`，管理用户审核/配额含 `maxPersonalRoles`/`defaultMaxPersonalRoles`、注册策略、克隆主目录、运行任务紧急中止与审计日志） |

样式按页面职责定位到[团队](styles/team.css)、[角色架构师](styles/role-architect.css)、[设置](styles/settings.css)、[账号与超管](styles/account-admin.css)、[对话流](styles/chat-stream.css)和[对话卡片](styles/chat-cards.css)。修改共用选择器时按 [main.tsx](main.tsx) 中的加载顺序检查作用范围。
[RoleDesignDetails](components/team/RoleDesignDetails.tsx) 在角色候选卡片显示 Skills、依赖状态与验证约定，并在体检卡片展示经过宿主核对的来源。创建路径保留能力声明，未关联来源或尚待运行核查时不显示为能力已验证。

[useHashRouteNav](hooks/useHashRouteNav.ts) 将页签和路由选项一起更新。跨页、成果详情与协作浮层分别使用 [ViewFade](components/ViewTransitions.tsx) 淡入淡出。资料空间根路由显示资料，旧成果链接仍可打开对应版本，`#/space/:id` 打开资料。减少动态效果或浏览器缺少 View Transitions 时即时切换。

[ChatStage](components/ChatStage.tsx) 使用 `composerDraft` 和 `initiation` 接收草稿、附件与立项操作。输入区和立项面板定义各自的属性类型，状态仍由上层对应的 hooks 持有。

输入草稿保存在当前页面内存中，以事项 ID、新事项或新建角色架构师对话为键。附件预处理和发送成功后的清理使用操作发起时的草稿范围。

## 运行状态与事件同步

- 运行耗时只向下传递开始时间 `progressStartedAt`，不要在 `App` 或 `ChatStage` 重新引入每秒更新的状态。
- `matter_settled` 可没有成果，仍须结束运行状态并刷新对话；不能把事件或“修改”前缀当作自动发布信号。
- `fetchBootstrap` 与 `fetchMatterDetail` 消费服务端返回的 `organizations` 与 `activeRuns` / `activeRun`，保证页面刷新（F5）后立即恢复进行中进度、计时与停止按钮。
- 订阅 `organization_updated`、`workspace_updated`、`team_updated`、`memory_updated`、`matter_message`、
  `collaborator_updated` 等 SSE 事件完成实时同步。
- `matter_progress` 附带 `collabUpdated` 时刷新事项详情（主负责人回复或旁听同事主动插话后即时同步）；`matter_updated` 同步旁听成员列表。
- 工作区或旁听变更失败/409 需呈现错误，不能只乐观改变选项而忽略后端状态；取消、错误和等待用户状态都要有对应刷新路径。

## 对话、旁听、图片与运行快照

- 团队页的组织主联系人切换只发送目标成员 ID。名册启用状态、模型和署名仍由组织角色设置管理。
- [ComposerDock](components/chat/ComposerDock.tsx) 使用一个「发送」动作和在组角色 `@` 菜单。服务端判断交流、正式执行或澄清，并在消息流显示相应进度。
- 新建事项时，[ComposerDock](components/chat/ComposerDock.tsx) 将输入区与 [MatterInitiationPanel](components/chat/MatterInitiationPanel.tsx)、[useMatterInitiationState](hooks/useMatterInitiationState.ts) 收口在居中新建卡片内（隐藏冗余英雄上下文栏），优先明确展示**当前实际参与安排**并将基于 `/api/matters/assess` 本地文字规则的即时预判与用户显式二次确认触发（支持取消及可选只读仓库核查）的 Pi 类型化决策模型建议（带来源/把握度标记与按需展开的「为什么这样建议？」）与细粒度阵型/旁听/人类同事微调折叠在「调整参与方式」抽屉内；已建事项可在 [MatterRosterPopover](components/chat/MatterRosterPopover.tsx) 内对单个非主责 AI 切换定向旁听。
- 新事项的主责模型和思考等级选择即时更新输入区，并随事项创建提交；已有事项的模型修改仍需点击「应用」保存。
- 团队页面与侧边栏均支持直接启动「角色架构师」持久化对话事项（侧边栏独立条呈现在业务成员网格下方，架构师对话沿用同一 [ComposerDock](components/chat/ComposerDock.tsx) 输入卡片并在顶栏显示「角色架构师 · 只读建队规划」，全局名录不绑定具体代码仓库，欢迎页专注按工作流规划角色与示范填充，消息流内嵌 [RoleProposalCard](components/chat/RoleProposalCard.tsx) 与 [architectApi.ts](architectApi.ts)）；「团队协作体检」保留在 [TeamView](components/TeamView.tsx) 通过 [TeamHealthcheckPanel](components/team/TeamHealthcheckPanel.tsx) 弹窗发起，发起前需二次确认并支持随时取消（不占用事项列表或平铺撑破团队网格）；[ModalDialog](components/ModalDialog.tsx) 统一承接「新建/编辑组织身份」「导入/导出角色能力包」「登记项目 Git 工作区」以及「文本/折叠粘贴附件预览」（[OrganizationsView](components/OrganizationsView.tsx)、[MemberPackageForms](components/team/MemberPackageForms.tsx)、[MaterialsView](components/MaterialsView.tsx)、[AttachmentPreviewModals](components/chat/AttachmentPreviewModals.tsx)），避免管理页内联展开或大段文本撑乱布局；[MemberInspectorModal](components/team/MemberInspectorModal.tsx) 承接团队卡片完整职责/Skills/Anti-Jobs 边界、Git 署名编辑与三层记忆管理（[MemberCard](components/team/MemberCard.tsx) 正面保持轻量化展示作用范围标签 `平台通用`/`组织共享`/`仅我可用` 与 `···` 菜单，经验计数位于底部元信息行避免挤压长角色标题，[TeamView](components/TeamView.tsx) 提供动态作用域筛选标签及个人私有配额计数，专注于 AI 角色管理）；AI 复盘提炼经验等慢速 LLM 操作统一具备确认与中止机制；业务事项进行中支持经 [MatterRosterPopover](components/chat/MatterRosterPopover.tsx) 中途请入架构师诊断并一键将新建角色加入当前事项；[RoleArchitectModal](components/team/RoleArchitectModal.tsx)、[MemberPackageForms](components/team/MemberPackageForms.tsx) 与 [RoleProposalCard](components/chat/RoleProposalCard.tsx) 均集成 [NewSkillsDraftSection](components/team/NewSkillsDraftSection.tsx) 与 `buildRoleScopeChoices`：按用户身份限制角色作用范围与允许的 Skill 存储位置，并在最终提交确认后才把勾选项写入磁盘（[RoleArchitectModal](components/team/RoleArchitectModal.tsx) 同时支持二次确认与可取消的 Pi「AI 智能设计草案」与离线「规则快速直出」卡片）；[Sidebar](components/Sidebar.tsx) 与各组织名册过滤始终保留创建者自身的 `personal` 角色。

- [BotFaceIcon](components/BotFaceIcon.tsx) 支持按运行阶段/心情呈现拟人化眼神与小动作。
- [ExploringStatus](components/ExploringStatus.tsx) 与 [Sidebar](components/Sidebar.tsx) 分别展示主成员及协同/旁听同事的动态头像、5 阶段标签进度及 `recentLogs`；
  点击左上角 AI 头像仅用于按该角色发起新事项，已有事项顶栏始终显示该事项真实负责人且不随左上角选择切换。
- [ExploringStatus](components/ExploringStatus.tsx)（`ProgressSnapshotCard`）消费已完成、失败与中止消息的 `metadata.progressSnapshot`：
  - 运行中的 `.exploring-feed` 保持紧凑固定高度并支持向上滚动查看本轮最多 60 条完整活动轨迹（新日志自动滚底）；
  - 正常完成回复下方默认折叠展示「执行过程 · 角色 · 耗时 · 活动条数」，点击可就地展开回看；警告或中止气泡下默认展开停滞阶段、耗时、协同岗位与步骤摘要。
- [ChatStage](components/ChatStage.tsx) 顶栏显示当前组织徽标、欢迎区展示 `组织` / `仓库` / `Git 真实提交者` 上下文栏，
  输入栏支持先选「所属组织」再选「仓库」（未绑仓库也可按组织发起）；每条 AI 回复显示角色头像与「旁听补充」徽章。
- 「协作成员」面板列出主责和在组成员。「AI 旁听」开关只控制协作 AI 的主动补充。点开 AI 成员可以分别设置「允许主责委托」和「旁听补充」。统一输入框用「@成员」点名同事或 AI。
- [Sidebar](components/Sidebar.tsx) 用事项关联的组织和仓库标注最近事项。[事项协作面板](components/chat/MatterCollabDrawer.tsx) 的「资料空间」展示当前事项默认空间中的文档（含可选关联仓库路径），不再重复平铺旧成果列表；对话流中直接依据消息 `metadata.spaceDocuments` 渲染文档卡片（带 `方案`/`规格`/`决策`/`规范`/`资料` 类型徽章，「查看全文」在 [MatterDocSidePane](components/chat/MatterDocSidePane.tsx) 打开正文视图，「查看变更」直接切至顶部「变更对比」Git Diff 视图，仅 `plan` 类型最新一轮显示「确认并推进」，支持多 Tab、SSE 热更新与就地编辑提交）；待回答的人类澄清/决定在 [FloatingClarificationDock](components/chat/FloatingClarificationDock.tsx) 中吸附于输入框正上方，支持多题分页（`1/N`）、编号选项、自定义输入与跳过/提交。
- [团队委托面板](components/chat/MatterDelegationPanel.tsx) 根据 [轮次投影](utils/matterDelegations.ts) 展示派发、回报和转派关系，从消息或运行卡片直达对应轮次，并可定位到原始消息。[关系图](components/chat/DelegationGraph.tsx) 同时用于进行中和历史轮次。「事项事件」保留事项级工具记录与关键事件筛选，截断的历史工具 JSON 由 [matterStream.ts](utils/matterStream.ts) 解析。
- [ComposerDock](components/chat/ComposerDock.tsx) 在「开始新事项 / 已有事项空闲 / 角色架构师 / 执行中」统一使用同一 `.composer-card` 结构：运行中在卡片顶部显示含阶段徽标、实时耗时和「停止执行」的 `.composer-run-banner`；顶部栏保留组织、仓库与新事项操作；工具栏仅保留单一 `+` 按钮用于同时上传图片（最多 6 张，支持缩放与灯箱预览）和 UTF-8 文本/代码文件（最多 6 个、单文件 `<= 512KB`），并支持拖拽与 `Ctrl/Cmd+V` 粘贴截图；粘贴超过 600 字符或 10 行的大段纯文本自动折叠为附件胶囊，发送前后均可经 [ModalDialog](components/ModalDialog.tsx) 弹层查看完整内容（草稿状态支持「放回输入框」展开编辑），输入区随单行紧凑默认与多行自动增高平滑过渡（显示行数与发送快捷键提示）；[MarkdownView](MarkdownView.tsx) 配合 [deliverables.css](styles/deliverables.css) / [chat-stream.css](styles/chat-stream.css) 支持单元格与行内代码自然换行与两列表格首列保底宽度，避免窄列单字竖排挤压。

## 组织身份、团队记忆与成果阅读

- [TeamView](components/TeamView.tsx)、[OrganizationsView](components/OrganizationsView.tsx) 与 [MaterialsView](components/MaterialsView.tsx) 覆盖多组织团队协同与项目接入边界：
  - 任何已启用账号可在配额内自建组织，在组织卡片内管理人类成员角色（`org_owner` / `org_admin` / `org_member` / `org_viewer`）、生成 `orginv_` 邀请链接、通过邀请码加入其他组织，以及在「AI 角色」与「编辑组织身份」中切换本组织是否启用 AI 角色独立 Git Author 署名（默认关闭，提交直接沿用目标仓库目录自身的 Git `user.name` / `user.email`）、勾选启用的 AI 角色、指定组织主联系人并为已启用角色单独覆写本组织的 `gitNameOverride` / `gitEmailOverride`（[Sidebar](components/Sidebar.tsx)、[ChatStage](components/ChatStage.tsx) 与 [MatterInitiationPanel](components/chat/MatterInitiationPanel.tsx) 同步按当前组织有效 AI 名册及组织主联系人过滤/预设，[TeamView](components/TeamView.tsx) 顶部另提供按组织或全局直达的主联系人切换栏并投影组织级名称与 Git 覆盖，[MemberInspectorModal](components/team/MemberInspectorModal.tsx) 如实提示当前默认仓库提交或角色署名启用状态）。
  - [useAuthSession](hooks/useAuthSession.ts)、[AuthGateView](components/AuthGateView.tsx) 与 [Sidebar](components/Sidebar.tsx) 区分 `loopback`（本机免密态显示「切换账号」）与 `session`（账号会话显示「退出登录」）；携带 `?invite=orginv_...` 访问时若当前浏览器尚未登录则默认展开含邀请组织提示的「注册账号」表单，若已登录则弹出确认弹窗由用户选择以当前账号加入或「退出并注册新成员」（不静默自动消耗同浏览器旧会话的邀请次数）。
  - [MaterialsView](components/MaterialsView.tsx) 登记仓库支持切换「从 Git 地址克隆到组织主目录（`cloned`）」与受平台策略控制的「指定服务器本地目录（`local`）」，并可配置仓库可见范围（`org` / `restricted` 授权成员）。
  - [MatterInitiationPanel](components/chat/MatterInitiationPanel.tsx) 支持设置新建事项范围（`org` 组织可见 / `private` 仅发起人与指定人类成员）与选择组织人类同事；已授权的 `org_member` 可直接向 AI 派发任务。
  - [ComposerDock](components/chat/ComposerDock.tsx) 对团队版非超管账号隐藏「不归属组织」。[useMatterActions](hooks/useMatterActions.ts) 在普通新建事项和 Role Architect 对话中提交用户所选或默认可用组织。Role Architect 对话隐藏仓库选择，组织归属由服务端复核。
  - 支持默认组织徽标与「设为默认」切换、组织创建/编辑、新仓库默认选定默认组织（可选独立无组织）、
    仓库 `Git Committer` 真实用户展示、成员 `Git Author（角色）` vs `Git Committer（真实用户）` 与三层记忆筛选；
    经验表单与卡片亦优先预选默认组织。
- 团队复盘共用组件 [ExperienceReviewPanel](components/ExperienceReviewPanel.tsx)：
  - 供 [ChatStage](components/ChatStage.tsx) 与 [TeamView](components/TeamView.tsx) 调用。
  - 导出 `InlineExperienceReviewSection`、`ExperienceItemCard`、`ManualExperienceForm` 等组件。
  - 支持在同一协作上下文按岗位和经验维度（提效/排障/协同/用户纠偏/项目规范）直接提炼，进行中支持「取消提炼」同步中止请求与后台 reflection worker。
  - 支持核验通过、批量通过、编辑改属与溯源跳转；为 `company_private` 提供组织（或退化单仓库）选择器，切换到仓库范围时通过 `pickDefaultWorkspaceId` 优先默认当前/来源事项所属仓库（仍可手动切换）。
  - 「待核验」卡片聚焦核验/编辑/忽略并隐藏零值计数；核验通过后再开放 `+1/-1` 效用评价。支持 `canManage` 权限收口，当非管理员或只读 `org_viewer` 查阅时隐藏「全部核验通过」「核验通过」「+1/-1」「编辑」「忽略」等写操作按钮。
- [DeliverablesView](components/DeliverablesView.tsx) 在 `#/deliverables` 显示资料空间。文档可编辑、查看 Git 版本与提交差异，并对具体提交记录反馈。

从仓库根运行 `npm run check`、`npm run build:web`。
路由和 HTTP/SSE 行为覆盖在 [服务测试](../../test/phase3-server.test.ts)，该文件依赖已构建网页；视觉与交互效果仍需查看运行页面。更多构建和启动说明见[上层入口](../README.md)。
