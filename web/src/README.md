# 前端状态与组件

[main.tsx](main.tsx) 挂载应用，[App.tsx](App.tsx) 持有事项选择、bootstrap/detail 刷新、SSE 订阅和顶层操作。页面内局部展开、输入等状态尽量留在所属组件，避免继续扩大根组件状态。

| 修改目标 | 入口 |
| --- | --- |
| HTTP DTO 和请求 | [api.ts](api.ts)，与服务响应一起核对 |
| Hash 路由与浏览器前进后退 | [hashRouter.ts](hashRouter.ts) |
| Markdown 展示 | [MarkdownView.tsx](MarkdownView.tsx)；保持无 `dangerouslySetInnerHTML` 的渲染边界 |
| 布局与共用样式/格式 | [styles.css](styles.css)、[utils.ts](utils.ts) |
| 图片附件前端预处理 | [imageAttachments.ts](imageAttachments.ts)（格式校验、缩略预览与超大图缩放压缩） |
| 事项导航、会话、运行状态 | [Sidebar](components/Sidebar.tsx)、[ChatStage](components/ChatStage.tsx)、[ExploringStatus](components/ExploringStatus.tsx) |
| 成果系列、版本、验收与提炼 | [DeliverablesView](components/DeliverablesView.tsx)、[DeliverableCard](components/DeliverableCard.tsx) |
| 团队、经验审核、资料及头像 | [TeamView](components/TeamView.tsx)、[ExperienceReviewPanel](components/ExperienceReviewPanel.tsx)、[MaterialsView](components/MaterialsView.tsx)、[BotFaceIcon](components/BotFaceIcon.tsx) |

组件数量尚小，本页直接定位文件，`components/` 不再加一层重复目录说明。

`matter_settled` 可没有成果，仍须结束运行状态并刷新对话；不能把事件或“修改”前缀当作自动发布信号。`fetchBootstrap` 与 `fetchMatterDetail` 会消费服务端返回的 `activeRuns` / `activeRun`，保证页面刷新后立即恢复进行中进度、计时与停止按钮；同时消费失败/中止消息 `metadata.progressSnapshot`，通过 [ExploringStatus](components/ExploringStatus.tsx)（`ProgressSnapshotCard`）在警告或中止气泡下持久化展示停滞阶段、已运行耗时、当时正在协同的岗位与最近工具步骤（支持折叠/展开，隔段时间回看仍可定位异常前状态）。`matter_progress` 附带 `collabUpdated` 时刷新事项详情（主负责人回复后、旁听同事主动插话后都会即时同步），`matter_updated` 同步旁听成员列表；[BotFaceIcon](components/BotFaceIcon.tsx) 支持按运行阶段/心情呈现拟人化眼神与小动作，[ExploringStatus](components/ExploringStatus.tsx) 和 [Sidebar](components/Sidebar.tsx) 分别展示主成员与协同/旁听同事的动态头像、5 阶段标签进度及最近工具/输出动态（`recentLogs`）。[ChatStage](components/ChatStage.tsx) 在每条 AI 回复上方显示对应角色头像、名称及「旁听补充」徽章，并在底部工具栏提供「旁听席」选择器以随时增减列席讨论的团队角色；同时按轮次显示可折叠「团队委托」摘要，顶部按钮明确区分委托数、事件数与「经验复盘」，并在右上角以浮动浮层展开分栏面板（「团队内部委托」支持 Markdown 渲染与长文本折叠、「过程与工具事件」按最新时间倒序并提供关键/异常筛选及 [utils.ts](utils.ts) `formatNoticeEventLine` 对历史截断工具 JSON 的正则兜底解析、「经验复盘」平铺展示无嵌套外框）。[ChatStage](components/ChatStage.tsx) 现支持在输入框点击图片按钮、拖拽图片到输入区或通过 `Ctrl/Cmd+V` 粘贴截图（每次最多 6 张，支持纯图片或文字+图片发送，发送前可预览/移除，发送后在用户气泡内展示并通过灯箱查看大图）。[DeliverableCard](components/DeliverableCard.tsx)、[ChatStage](components/ChatStage.tsx) 与 [TeamView](components/TeamView.tsx) 共用 [ExperienceReviewPanel](components/ExperienceReviewPanel.tsx)（含 `InlineExperienceReviewSection`、`ExperienceItemCard`、`ManualExperienceForm`），支持在同一协作上下文中按岗位和经验维度（提效/排障/协同/用户纠偏/项目规范）直接提炼（进行中支持「取消提炼」，同步中止请求与后台 reflection worker）、核验通过、批量通过、编辑改属与溯源跳转，无须强制跳回总库；其中 [DeliverableCard](components/DeliverableCard.tsx) 在 [DeliverablesView](components/DeliverablesView.tsx) 中采用「简练 · 有重点 · 有过程」阅读视图：移除重复状态横幅、双层嵌套灰框与正文小盒截断滚动，顶部以单行轻元信息 + [utils.ts](utils.ts) `parseDeliverableSummary` 提炼的「本版重点」与可展开「过程脉络」（依据要点清单、版本演进时间线与原对话直达）呈现结构化重点，底部操作栏收口为「记录/修改验收」（默认折叠验收表单）、「手动沉淀经验」与「AI 提炼团队经验」（内嵌的 `InlineExperienceReviewSection` 通过 `showManualToggle={false}` 并省略重复提炼入口，避免同一张成果卡片出现两套等价按钮），并在编辑/手动录入经验切换到仓库范围时通过 [utils.ts](utils.ts) `pickDefaultWorkspaceId` 优先默认当前事项或来源事项所属仓库（仍可手动切换其它仓库），「待核验」卡片聚焦核验/编辑/忽略并隐藏零值计数与误导性「待复核」标签，待核验通过后再开放 `+1/-1` 效用评价。工作区或旁听变更失败/409 需呈现错误，不能只乐观改变选项而忽略后端状态。取消、错误和等待用户状态都要有对应刷新路径。验收返回 `distillationError` 时须显示“验收已保存、复盘未完成”，并刷新已保存反馈，避免将可选复盘失败误报为保存失败。

从仓库根运行 `npm run check`、`npm run build:web`。路由和 HTTP/SSE 行为覆盖在 [服务测试](../../test/phase3-server.test.ts)，该文件依赖已构建网页；视觉与交互效果仍需查看运行页面。更多构建和启动说明见[上层入口](../README.md)。
