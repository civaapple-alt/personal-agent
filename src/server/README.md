# HTTP、SSE 与本机服务

[main.ts](main.ts) 负责启动装配：角色、数据库、编排核、对话 broker、预览管理器及静态网页。
默认端口 4310、`PA_HOST` 默认 `127.0.0.1`，`PORT`、`PA_HOST`、`PA_DB_PATH`、`PA_PI_EXTENSIONS` 读取以此文件为准；
日常启动会接触用户数据库，绑定 `0.0.0.0` 时打印局域网地址供同事通过邀请链接加入。

[app.ts](app.ts) 装配 HTTP 服务，并由 [auth.ts](auth.ts)、[sse.ts](sse.ts)、[uploads.ts](uploads.ts)、[dispatch-runner.ts](dispatch-runner.ts) 与 [routes/](routes/context.ts) 分担鉴权、推送、上传、后台派发与领域路由。消息异步派发，事件交给 [web/src](../../web/src/README.md) 消费。
修改接口时同时核对 `api.ts` 的 DTO 和 `App.tsx` 的刷新/收尾逻辑，保留已有事项、工作区、成果和反馈兼容性。

- 并发、工作区切换与图片上传：
  - 同事项运行中发送消息、切换工作区及切换事项负责人（`leadMemberId`）返回 409；调整全局旁听开关（`observersEnabled`）、
    AI 参与名单（`aiMemberIds`）或旁听列表（`observerMemberIds`）可在运行中即时更新。取消要交给编排核，不只广播停止事件。
  - `POST /api/matters` 支持传入 `aiMemberIds`、`observersEnabled` 与可选 `images`（`POST /api/matters/:id/messages`
    同样支持可选 `observerMemberIds` 与 `images`）：
    - 图片约束：最多 6 张、PNG/JPEG/WebP/GIF、单张解码 <= 5MB、JSON 上限 36MB，允许纯图片提交。
  - 图片落盘 `uploadsDir`（默认 `.data/uploads`，测试未指定时用有界内存缓存）并经 `GET /api/uploads/:filename` 提供访问，消息仅存轻量引用 `metadata.images`。
- 组织与成员身份接口：
  - [main.ts](main.ts) 启动时自动保证默认组织存在（`ensureDefaultOrganization`），并在首次无任何组织时将既有无归属工作区及自举仓库归入默认组织。
  - `GET /api/bootstrap` 下发 `organizations`；`GET /api/organizations`、`POST /api/organizations`、
    `PATCH /api/organizations/:id` 与 `POST /api/organizations/:id/default` 管理组织字段与默认组织切换。
  - 字段覆盖名称、Git 邮箱域名、`isDefault` 与简介；`POST /api/workspaces` 省略 `orgId` 自动归入默认组织
    （显式传 `null` 保留独立工作区），`PATCH /api/workspaces/:id` 调整绑定（未知 `orgId` 返回 404），工作区返回含 `repoGitUser`。
  - `POST /api/members` 与 `PATCH /api/members/:id` 维护成员私有 `gitName`、`gitEmail` 与 `identitySummary`。
  - 私有身份字段不回写共享模板，`/api/members/:id/export` 始终保持脱敏。
- 多人类受限协作与显式讨论隔离（方案 B）：
  - `127.0.0.1`/`::1` 仅在未携带 `pa_session` Cookie 时默认映射为所有者（已持失效 `pa_session` 不回落所有者，须重新登录或显式
    登出）；非回环局域网与 `requireAuth: true` 须通过 `/api/auth/login` 签发 `pa_session` 或携带 `x-pa-token` / `Bearer`。
  - `/api/collaborators` 与 `/api/collaborators/:id/regenerate-token` 仅所有者可管理（向协同成员隐藏 `token`）；重置口令或删除成员会
    立即向对应在线 SSE 推送 `auth_revoked` 并断开连接，后续请求统一返回 `401`。
  - `POST /api/matters` 与 `POST /api/matters/:id/messages` 支持 `mode`：`"discussion"`（团队讨论，不占 AI 锁且支持
    AI 运行中续发）、`"ai_request"`（同事提请单）与 `"dispatch"`（仅所有者可触发）。
  - 所有者可通过 `/api/matters/:id/messages/:msgId/approve-ai` 或 `dismiss-ai` 一键批准并派发或忽略提请；
    仓库/组织/成员/记忆/弹窗/预览写入与 `autoDistill: true` 均对协同成员返回 `403`。
  - 提请只允许从 `pending` 原子转为 `approved` 或 `dismissed`；重复处理/非提请返回 409。批准先校验来源组织与仓库、AI 成员和附件，失败保持待处理；附件缺失返回 410。
  - 图片上传完成后由 `dispatch-runner` 统一检查运行占用，冲突返回 409，不能覆盖原运行进度。运行中的仓库也不能经 PATCH 或同路径 upsert 改归属组织。
- Phase 4 RSI 接口：
  - `POST /api/deliverables/:id/feedback` 支持可选 `rating`、`autoDistill` 与 `scopeMode`，反馈与计数原子保存并仅评价该版本关联的经验（`neutral` 撤回当前票）。
  - 可选自动复盘失败时仍返回已保存反馈与 `distillationError`。
  - `POST /api/rsi/distill`（支持 `scopeMode` 与断连/`AbortSignal` 级联中止）、`POST /api/rsi/distill/abort` 支持只读多角色经验提炼与取消。
  - `POST /api/memories`、`PATCH /api/memories/:id`、`POST /api/memories/:id/evaluate` 与 `GET /api/memories/:id/applications` 维护三层记忆生命周期。
  - `PATCH /api/memories/:id` 支持 `memberId`、`category`、`scope`、`orgId`、`workspaceId`、`status`，并逐个广播 `memory_updated`。
- 运行态恢复与快照：
  - `GET /api/bootstrap` 返回 `activeRuns`、`GET /api/matters/:id` 返回 `activeRun`（含阶段、已流式正文与 `startedAt`），确保前端 F5 刷新恢复。
  - 执行失败时先提取 `ProgressSnapshot` 并连同错误与工作区锚点写入 `user` 系统消息 `metadata`（并广播 `matter_failed`），供前端回看与同作用域续跑。
- [dialog-broker.ts](dialog-broker.ts) 在内存中等待 Extension UI 回答，HTTP 回复最终经 RPC 回写 Pi。它不是对所有命令的通用权限拦截器。
- [preview-manager.ts](preview-manager.ts) 启停本地命令或登记外部服务链接；索引在内存中，不是部署系统，也不会因成果登记自动创建预览。
- 退出时先停止接收请求，再取消对话、清理执行树和预览，最后关闭数据库。

从仓库根先运行 `npm run build:web`，再运行 `node --test test/phase3-server.test.ts`。
验证完整启动入口则先 `npm run build`，再 `npm run check:startup`（使用临时数据库且不发模型请求）。不要为验证重启用户现有服务或把模型任务送进业务工作区。

更多执行约束在 [orchestrator](../orchestrator/README.md)，整体服务关系见[当前架构](../../docs/architecture-and-plan.md)。
