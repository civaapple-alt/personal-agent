# 前端状态与组件

[main.tsx](main.tsx) 挂载应用，[App.tsx](App.tsx) 持有事项选择、bootstrap/detail 刷新、SSE 订阅和顶层操作。
页面内局部展开、输入等状态尽量留在所属组件，避免继续扩大根组件状态。

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

## 运行状态与事件同步

- `matter_settled` 可没有成果，仍须结束运行状态并刷新对话；不能把事件或“修改”前缀当作自动发布信号。
- `fetchBootstrap` 与 `fetchMatterDetail` 消费服务端返回的 `organizations` 与 `activeRuns` / `activeRun`，保证页面刷新（F5）后立即恢复进行中进度、计时与停止按钮。
- 订阅 `organization_updated`、`workspace_updated`、`team_updated`、`memory_updated` 等 SSE 事件完成实时同步。
- `matter_progress` 附带 `collabUpdated` 时刷新事项详情（主负责人回复或旁听同事主动插话后即时同步）；`matter_updated` 同步旁听成员列表。
- 工作区或旁听变更失败/409 需呈现错误，不能只乐观改变选项而忽略后端状态；取消、错误和等待用户状态都要有对应刷新路径。

## 对话、旁听、图片与运行快照

- [BotFaceIcon](components/BotFaceIcon.tsx) 支持按运行阶段/心情呈现拟人化眼神与小动作。
- [ExploringStatus](components/ExploringStatus.tsx) 与 [Sidebar](components/Sidebar.tsx) 分别展示主成员及协同/旁听同事的动态头像、5 阶段标签进度及 `recentLogs`。
- [ExploringStatus](components/ExploringStatus.tsx)（`ProgressSnapshotCard`）消费失败/中止消息的 `metadata.progressSnapshot`：
  - 在警告或中止气泡下持久化展示停滞阶段、耗时、协同岗位与最近工具步骤（支持折叠回看）。
- [ChatStage](components/ChatStage.tsx) 在每条 AI 回复上方显示对应角色头像、名称及「旁听补充」徽章，底部工具栏提供「旁听席」选择器增减列席角色。
- 顶部浮层分栏面板区分「团队内部委托」（Markdown 渲染与长文本折叠）、「过程与工具事件」（倒序、关键/异常筛选及 [utils.ts](utils.ts) `formatNoticeEventLine` 对历史截断工具 JSON 的正则兜底解析）与平铺的「经验复盘」。
- [ChatStage](components/ChatStage.tsx) 支持在输入框点击图片按钮、拖拽图片到输入区或通过 `Ctrl/Cmd+V` 粘贴截图（最多 6 张，支持纯图片或图文发送，发送前可预览/移除，发送后气泡内展示并支持灯箱查看大图）。

## 组织身份、团队记忆与成果阅读

- [TeamView](components/TeamView.tsx) 与 [MaterialsView](components/MaterialsView.tsx) 覆盖组织与成员身份视图：
  - 支持组织创建/编辑、仓库与组织绑定、成员私有 Git 署名（`gitName <gitEmail>`）与个人背景编辑、三层记忆统计与层级筛选。
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
