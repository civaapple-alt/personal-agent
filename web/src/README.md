# 前端状态与组件

[main.tsx](main.tsx) 挂载应用，[App.tsx](App.tsx) 持有事项选择、bootstrap/detail 刷新、SSE 订阅和顶层操作。
页面内局部展开、输入等状态尽量留在所属组件，避免继续扩大根组件状态。

[App.tsx](App.tsx) 在各页共用的区域显示操作错误与通知，支持关闭和辅助技术播报；团队、资料及成果页不必跳回聊天查看结果。[TeamView](components/TeamView.tsx) 捕获主联系人设置及导出失败并上报；[MemberCard](components/team/MemberCard.tsx) 菜单打开后聚焦首项，支持方向键、Home/End、Escape 返回触发按钮及 Tab 离开。无经验时「详情与经验」先展示职责和身份，组织的编辑/设为默认入口仅供所有者显示，服务端权限校验仍是实际约束。

| 修改目标 | 入口 |
| --- | --- |
| HTTP DTO 和请求 | [api.ts](api.ts)，与服务响应一起核对 |
| Hash 路由与浏览器前进后退 | [hashRouter.ts](hashRouter.ts) |
| Markdown 展示 | [MarkdownView.tsx](MarkdownView.tsx)；保持无 `dangerouslySetInnerHTML` 的渲染边界 |
| 布局与共用样式/格式 | [styles/tokens.css](styles/tokens.css)（`--text-*` 字号阶梯、`--page-pad-*`/`--section-gap`）、[styles/primitives.css](styles/primitives.css)（`.ui-sections-stack`、`.ui-section*`、`.ui-card` 等原语）及 [utils.ts](utils.ts) |
| 图片附件前端预处理 | [imageAttachments.ts](imageAttachments.ts)（格式校验、缩略预览与超大图缩放压缩） |
| 事项导航、会话、运行状态 | [Sidebar](components/Sidebar.tsx)、[ChatStage](components/ChatStage.tsx)、[ExploringStatus](components/ExploringStatus.tsx) |
| 成果系列、版本、验收与提炼 | [DeliverablesView](components/DeliverablesView.tsx)、[DeliverableCard](components/DeliverableCard.tsx) |
| 团队、经验审核、资料及头像 | [TeamView](components/TeamView.tsx)、[ExperienceReviewPanel](components/ExperienceReviewPanel.tsx)、[MaterialsView](components/MaterialsView.tsx)、[BotFaceIcon](components/BotFaceIcon.tsx) |
| 设置、Agent 底座与扩展视图 | [SettingsView](components/SettingsView.tsx)（对应 `#/settings` 与 `#/settings/{base,extensions,config}`，按类目展示 Pi 底座、扩展插件及按节分组的运行配置） |

组件数量尚小，本页直接定位文件，`components/` 不再加一层重复目录说明。
[RoleDesignDetails](components/team/RoleDesignDetails.tsx) 在角色候选卡片显示 Skills、依赖状态与验证约定，并在体检卡片展示经过宿主核对的来源。创建路径保留能力声明，未关联来源或尚待运行核查时不显示为能力已验证。

## 运行状态与事件同步

- `matter_settled` 可没有成果，仍须结束运行状态并刷新对话；不能把事件或“修改”前缀当作自动发布信号。
- `fetchBootstrap` 与 `fetchMatterDetail` 消费服务端返回的 `organizations` 与 `activeRuns` / `activeRun`，保证页面刷新（F5）后立即恢复进行中进度、计时与停止按钮。
- 订阅 `organization_updated`、`workspace_updated`、`team_updated`、`memory_updated`、`matter_message`、
  `collaborator_updated` 等 SSE 事件完成实时同步。
- `matter_progress` 附带 `collabUpdated` 时刷新事项详情（主负责人回复或旁听同事主动插话后即时同步）；`matter_updated` 同步旁听成员列表。
- 工作区或旁听变更失败/409 需呈现错误，不能只乐观改变选项而忽略后端状态；取消、错误和等待用户状态都要有对应刷新路径。

## 对话、旁听、图片与运行快照

- 新建事项时，[ComposerDock](components/chat/ComposerDock.tsx) 将输入区与 [MatterInitiationPanel](components/chat/MatterInitiationPanel.tsx)、[useMatterInitiationState](hooks/useMatterInitiationState.ts) 收口在居中新建卡片内（隐藏冗余英雄上下文栏），优先明确展示**当前实际参与安排**并将基于 `/api/matters/assess` 本地文字规则的即时预判与用户显式二次确认触发（支持取消及可选只读仓库核查）的 Pi 类型化决策模型建议（带来源/把握度标记与按需展开的「为什么这样建议？」）与细粒度阵型/旁听/人类同事微调折叠在「调整参与方式」抽屉内；已建事项可在 [MatterRosterPopover](components/chat/MatterRosterPopover.tsx) 内对单个非主责 AI 切换定向旁听。
- 团队页面与侧边栏均支持直接启动「角色架构师」持久化对话事项（侧边栏独立条呈现在业务成员网格下方，架构师对话默认全局名录不绑定具体代码仓库、隐藏底部组织/仓库选择器，欢迎页专注按工作流规划角色与示范填充，消息流内嵌 [RoleProposalCard](components/chat/RoleProposalCard.tsx) 与 [architectApi.ts](architectApi.ts)）；「团队协作体检」保留在 [TeamView](components/TeamView.tsx) 通过 [TeamHealthcheckPanel](components/team/TeamHealthcheckPanel.tsx) 弹窗发起，发起前需二次确认并支持随时取消（不占用事项列表或平铺撑破团队网格）；[ModalDialog](components/ModalDialog.tsx) 统一承接「新增邀请同事」「新建/编辑组织身份」「导入/导出角色能力包」及「登记项目 Git 工作区」（[CollaboratorsSection](components/team/CollaboratorsSection.tsx)、[OrganizationsSection](components/team/OrganizationsSection.tsx)、[MemberPackageForms](components/team/MemberPackageForms.tsx)、[MaterialsView](components/MaterialsView.tsx)），避免管理页内联展开表单撑乱布局；[MemberInspectorModal](components/team/MemberInspectorModal.tsx) 承接团队卡片完整职责/Skills/Anti-Jobs 边界、Git 署名编辑与三层记忆管理（[MemberCard](components/team/MemberCard.tsx) 正面保持轻量化展示与 `···` 菜单，[TeamView](components/TeamView.tsx) 将成员网格置于首屏并将同事邀请与组织管理默认折叠为轻量摘要条）；AI 复盘提炼经验等慢速 LLM 操作统一具备确认与中止机制；业务事项进行中支持经 [MatterRosterPopover](components/chat/MatterRosterPopover.tsx) 中途请入架构师诊断并一键将新建角色加入当前事项；[RoleArchitectModal](components/team/RoleArchitectModal.tsx) 同时支持二次确认与可取消的 Pi「AI 智能设计草案」（生成称谓/英文头衔/Skills/边界/验证计划）与离线「规则快速直出」卡片；[buildStarterTasks](utils.ts) 在未绑仓库时优先呈现讨论对齐与非研发起手示例。
- 新建事项欢迎页的“体验内置演示”按需调用准备接口，再打开演示事项。[InnerDemoGuide](components/chat/InnerDemoGuide.tsx) 只填入可修改的提问；[innerDemo.ts](innerDemo.ts) 依据真实消息、委托与版本计算进度。第四步沿正常验收接口保留已有反馈，再填入修订要求，不自动发给模型。

- [BotFaceIcon](components/BotFaceIcon.tsx) 支持按运行阶段/心情呈现拟人化眼神与小动作。
- [ExploringStatus](components/ExploringStatus.tsx) 与 [Sidebar](components/Sidebar.tsx) 分别展示主成员及协同/旁听同事的动态头像、5 阶段标签进度及 `recentLogs`；
  点击左上角 AI 头像仅用于按该角色发起新事项，已有事项顶栏始终显示该事项真实负责人且不随左上角选择切换。
- [ExploringStatus](components/ExploringStatus.tsx)（`ProgressSnapshotCard`）消费失败/中止消息的 `metadata.progressSnapshot`：
  - 在警告或中止气泡下持久化展示停滞阶段、耗时、协同岗位与最近工具步骤（支持折叠回看）。
- [ChatStage](components/ChatStage.tsx) 顶栏显示当前组织徽标、欢迎区展示 `组织` / `仓库` / `Git 真实提交者` 上下文栏，
  输入栏支持先选「所属组织」再选「仓库」（未绑仓库也可按组织发起）；每条 AI 回复显示角色头像与「旁听补充」徽章。
- [ChatStage](components/ChatStage.tsx) 顶栏右上角保留「协作成员」入口（展示当前人类协作成员头像/名单与 AI 旁听
  状态），并将「团队委托与事件」「经验复盘」「成果库」收纳入 `···` 更多菜单；点击「协作成员」展开紧凑型成员
  网格浮层（搜索、4 列头像网格、`+ 添加`/`− 移出` 管理人类同事与默认全员参与的 AI 角色、设置事项负责人、
  以及全局「AI 旁听」开关）；发言区显式切换「团队聊天讨论」与「给 AI 安排事项 / 提请 AI 处理」（由当前事项负
  责人统一承接并按需团队协同，移除底部多余跟进选择框），讨论/提请/派发消息带独立归属徽章，所有者可一键「确
  认并派发 AI」或「忽略提请」。
- 顶部浮层分栏面板区分「团队内部委托」（Markdown 渲染与长文本折叠）、「过程与工具事件」（倒序、关键/异常筛选及
  [utils.ts](utils.ts) `formatNoticeEventLine` 对历史截断工具 JSON 的正则兜底解析）与平铺的「经验复盘」。
- [ChatStage](components/ChatStage.tsx) 支持在输入框点击图片按钮、拖拽图片到输入区或通过 `Ctrl/Cmd+V` 粘贴截图
  （最多 6 张，支持纯图片或图文发送，发送前可预览/移除，发送后气泡内展示并支持灯箱查看大图）；[ComposerDock](components/chat/ComposerDock.tsx) 输入区随多行内容自动增高（统一外框聚焦高光，移除内部矩形轮廓）并切换多行圆角轮廓；[MarkdownView](MarkdownView.tsx) 配合 [deliverables.css](styles/deliverables.css) / [chat-stream.css](styles/chat-stream.css) 支持单元格与行内代码自然换行与两列表格首列保底宽度，避免窄列单字竖排挤压。

## 组织身份、团队记忆与成果阅读

- [TeamView](components/TeamView.tsx) 与 [MaterialsView](components/MaterialsView.tsx) 覆盖协同同事管理、组织与成员身份视图：
  - 支持所有者新增协同同事、复制局域网邀请链接（`?invite=<token>`）、重置口令、以同事视角本地体验并支持在侧栏「恢复所有者」，
    同时在未认证局域网访问时经 [App.tsx](App.tsx) 显示邀请登录门禁，并在协同成员视图屏蔽管理员操作与 AI 经验提炼入口。
  - 支持默认组织徽标与「设为默认」切换、组织创建/编辑、新仓库默认选定默认组织（可选独立无组织）、
    仓库 `Git Committer` 真实用户展示、成员 `Git Author（角色）` vs `Git Committer（真实用户）` 与三层记忆筛选；
    经验表单与卡片亦优先预选默认组织。
- 团队复盘共用组件 [ExperienceReviewPanel](components/ExperienceReviewPanel.tsx)：
  - 供 [DeliverableCard](components/DeliverableCard.tsx)、[ChatStage](components/ChatStage.tsx) 与 [TeamView](components/TeamView.tsx) 调用。
  - 导出 `InlineExperienceReviewSection`、`ExperienceItemCard`、`ManualExperienceForm` 等组件。
  - 支持在同一协作上下文按岗位和经验维度（提效/排障/协同/用户纠偏/项目规范）直接提炼，进行中支持「取消提炼」同步中止请求与后台 reflection worker。
  - 支持核验通过、批量通过、编辑改属与溯源跳转；为 `company_private` 提供组织（或退化单仓库）选择器，切换到仓库范围时通过 `pickDefaultWorkspaceId` 优先默认当前/来源事项所属仓库（仍可手动切换）。
  - 「待核验」卡片聚焦核验/编辑/忽略并隐藏零值计数；核验通过后再开放 `+1/-1` 效用评价。
- [DeliverableCard](components/DeliverableCard.tsx) 在 [DeliverablesView](components/DeliverablesView.tsx) 中采用「简练 · 有重点 · 有过程」阅读视图：
  - 顶部单行轻元信息 + [utils.ts](utils.ts) `parseDeliverableSummary` 提炼的「本版重点」与可展开「过程脉络」（依据清单、版本时间线与原对话直达）。
  - 底部操作栏收口为「记录/修改验收」（默认折叠表单）、「手动沉淀经验」与「AI 提炼团队经验」，嵌入区设 `showManualToggle={false}` 避免重复按钮。
  - 验收返回 `distillationError` 时须显示“验收已保存、复盘未完成”，并刷新已保存反馈，避免误报保存失败。

从仓库根运行 `npm run check`、`npm run build:web`。
路由和 HTTP/SSE 行为覆盖在 [服务测试](../../test/phase3-server.test.ts)，该文件依赖已构建网页；视觉与交互效果仍需查看运行页面。更多构建和启动说明见[上层入口](../README.md)。
