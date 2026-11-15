# HTTP、SSE 与本机服务

[main.ts](main.ts) 负责启动装配：角色、数据库、编排核、对话 broker、预览管理器及静态网页。默认端口 4310，`PORT`、`PA_DB_PATH`、`PA_PI_EXTENSIONS` 的读取以此文件为准；日常启动会接触用户数据库。

[app.ts](app.ts) 是 HTTP 路由与 SSE 入口。消息异步派发，事件交给 [web/src](../../web/src/README.md) 消费。修改接口时同时核对 `api.ts` 的 DTO 和 `App.tsx` 的刷新/收尾逻辑，保留已有事项、工作区、成果和反馈兼容性。

- 同事项运行中消息、工作区切换及旁听成员（`PATCH /api/matters/:id` `observerMemberIds`）更新返回 409；取消要交给编排核，不只广播停止事件。`POST /api/matters` 与 `POST /api/matters/:id/messages` 也支持传入有效的 `observerMemberIds`。
- [dialog-broker.ts](dialog-broker.ts) 在内存中等待 Extension UI 回答，HTTP 回复最终经 RPC 回写 Pi。它不是对所有命令的通用权限拦截器。
- [preview-manager.ts](preview-manager.ts) 启停本地命令或登记外部服务链接；索引在内存中，不是部署系统，也不会因成果登记自动创建预览。
- 退出时先停止接收请求，再取消对话、清理执行树和预览，最后关闭数据库。

从仓库根先运行 `npm run build:web`，再运行 `node --test test/phase3-server.test.ts`。验证完整启动入口则先 `npm run build`，再 `npm run check:startup`，它使用临时数据库且不发模型请求。不要为验证重启用户现有服务或把模型任务送进业务工作区。

更多执行约束在 [orchestrator](../orchestrator/README.md)，整体服务关系见[当前架构](../../docs/architecture-and-plan.md)。
