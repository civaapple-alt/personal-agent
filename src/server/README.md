# HTTP、SSE 与本机服务

[main.ts](main.ts) 负责启动装配：角色、数据库、编排核、对话 broker、预览管理器及静态网页。默认端口 4310，`PORT`、`PA_DB_PATH`、`PA_PI_EXTENSIONS` 的读取以此文件为准；日常启动会接触用户数据库。

[app.ts](app.ts) 是 HTTP 路由与 SSE 入口。消息异步派发，事件交给 [web/src](../../web/src/README.md) 消费。修改接口时同时核对 `api.ts` 的 DTO 和 `App.tsx` 的刷新/收尾逻辑，保留已有事项、工作区、成果和反馈兼容性。

- 同事项运行中消息及工作区切换返回 409；调整旁听成员（`PATCH /api/matters/:id` 仅传 `observerMemberIds`）不改动 `cwd`/会话，可在运行中即时更新。取消要交给编排核，不只广播停止事件。`POST /api/matters` 与 `POST /api/matters/:id/messages` 支持传入有效的 `observerMemberIds` 以及可选 `images`（最多 6 张、支持 PNG/JPEG/WebP/GIF、单张解码不超过 5MB、JSON 请求上限 36MB，允许纯图片无文字提交）；服务端将图片写入 `uploadsDir`（默认 `.data/uploads`，测试未指定时退化为有界内存缓存）并通过 `GET /api/uploads/:filename` 提供访问，仅将轻量引用存入消息 `metadata.images` 后把 `ImageContent[]` 转发给编排层。
- Phase 4 RSI 接口：`POST /api/deliverables/:id/feedback` 支持可选 `rating`（`positive`/`neutral`/`negative`）、`autoDistill` 与 `scopeMode`，反馈与计数原子保存，仅评价该成果版本明确关联的经验；改评更新当前票，neutral 撤回原票。可选自动复盘失败时仍返回已保存的反馈与 `distillationError`，客户端应分别呈现保存结果和复盘错误；`POST /api/rsi/distill`（支持 `scopeMode: "team" | "single"` 与客户端断连/`AbortSignal` 级联中止）、`POST /api/rsi/distill/abort`、`POST /api/memories`、`PATCH /api/memories/:id`（支持切换 `memberId`、`category`、`scope`、`status`）、`POST /api/memories/:id/evaluate` 与 `GET /api/memories/:id/applications` 分别支持只读多角色经验提炼、取消提炼、分类录入、核验/改写/改归属/忽略、手动正负评估与命中追踪查询，并对受影响成员逐个广播 `memory_updated`。
- `GET /api/bootstrap` 返回 `activeRuns`、`GET /api/matters/:id` 返回当前 `activeRun`（含阶段、已流式正文与 `startedAt`），确保前端刷新（F5）后可恢复进行中的状态卡片、计时与停止按钮；当执行失败时，错误捕获路径会先从 `activeRuns` 提取 `ProgressSnapshot` 并连同错误原因、当前 `workspaceId` / `repoPath` 写入 `user` 通道系统消息 `metadata`（同时通过 `matter_failed` 广播），供前端回看展示与编排层同作用域续跑衔接使用。
- [dialog-broker.ts](dialog-broker.ts) 在内存中等待 Extension UI 回答，HTTP 回复最终经 RPC 回写 Pi。它不是对所有命令的通用权限拦截器。
- [preview-manager.ts](preview-manager.ts) 启停本地命令或登记外部服务链接；索引在内存中，不是部署系统，也不会因成果登记自动创建预览。
- 退出时先停止接收请求，再取消对话、清理执行树和预览，最后关闭数据库。

从仓库根先运行 `npm run build:web`，再运行 `node --test test/phase3-server.test.ts`。验证完整启动入口则先 `npm run build`，再 `npm run check:startup`，它使用临时数据库且不发模型请求。不要为验证重启用户现有服务或把模型任务送进业务工作区。

更多执行约束在 [orchestrator](../orchestrator/README.md)，整体服务关系见[当前架构](../../docs/architecture-and-plan.md)。
