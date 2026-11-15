# 前端状态与组件

[main.tsx](main.tsx) 挂载应用，[App.tsx](App.tsx) 持有事项选择、bootstrap/detail 刷新、SSE 订阅和顶层操作。页面内局部展开、输入等状态尽量留在所属组件，避免继续扩大根组件状态。

| 修改目标 | 入口 |
| --- | --- |
| HTTP DTO 和请求 | [api.ts](api.ts)，与服务响应一起核对 |
| Hash 路由与浏览器前进后退 | [hashRouter.ts](hashRouter.ts) |
| Markdown 展示 | [MarkdownView.tsx](MarkdownView.tsx)；保持无 `dangerouslySetInnerHTML` 的渲染边界 |
| 布局与共用样式/格式 | [styles.css](styles.css)、[utils.ts](utils.ts) |
| 事项导航、会话、运行状态 | [Sidebar](components/Sidebar.tsx)、[ChatStage](components/ChatStage.tsx)、[ExploringStatus](components/ExploringStatus.tsx) |
| 成果系列、版本、反馈 | [DeliverablesView](components/DeliverablesView.tsx)、[DeliverableCard](components/DeliverableCard.tsx) |
| 团队、资料及头像 | [TeamView](components/TeamView.tsx)、[MaterialsView](components/MaterialsView.tsx)、[BotFaceIcon](components/BotFaceIcon.tsx) |

组件数量尚小，本页直接定位文件，`components/` 不再加一层重复目录说明。

`matter_settled` 可没有成果，仍须结束运行状态并刷新对话；不能把事件或“修改”前缀当作自动发布信号。内部过程默认按需展开。工作区切换失败/409 需呈现错误，不能只乐观改变选项而忽略后端绑定。取消、错误和等待用户状态都要有对应刷新路径。

从仓库根运行 `npm run check`、`npm run build:web`。路由和 HTTP/SSE 行为覆盖在 [服务测试](../../test/phase3-server.test.ts)，该文件依赖已构建网页；视觉与交互效果仍需查看运行页面。更多构建和启动说明见[上层入口](../README.md)。
