# HTTP、SSE 与本机服务

[main.ts](main.ts) 负责启动装配：合并仓库基线 `roles/` 与运行期自定义 `.data/roles/`（全局角色在根目录，组织和个人角色分别在 `orgs/<orgId>/`、`users/<userId>/`）、内置 `role-architect`、运行期自定义 Skill 目录（`.data/skills/{global,orgs,users}/`）、数据库、编排核、对话 broker、预览管理器及静态网页。
默认端口 4310、`PA_HOST` 默认 `127.0.0.1`，`PORT`、`PA_HOST`、`PA_DB_PATH`、`PA_PI_EXTENSIONS` 读取以此文件为准；
启动时探测 Pi CLI 并记录版本或失败原因。日常启动会接触用户数据库，绑定 `0.0.0.0` 时打印局域网地址供同事通过邀请链接加入。

[app.ts](app.ts) 装配 HTTP 服务，并由 [auth.ts](auth.ts)、[acl.ts](acl.ts)、[git-clone.ts](git-clone.ts)、[sse.ts](sse.ts)、[uploads.ts](uploads.ts)、[dispatch-runner.ts](dispatch-runner.ts) 与 [routes/](routes/context.ts) 分担鉴权与 CSRF/限流、组织/工作区/事项 ACL、Git 地址协议安全检验与组织主目录克隆、作用域隔离 SSE 推送、上传权限索引、后台派发与超级管理员/认证/业务路由。消息异步派发，事件交给 [web/src](../../web/src/README.md) 消费。

## 业务路由

| 变更范围 | 维护入口 |
| --- | --- |
| 事项详情、停止执行和交互应答 | [matters.ts](routes/matters.ts) |
| 立项评估、创建、发送消息和确认 AI 提请 | [matter-messages.ts](routes/matter-messages.ts) |
| 事项工作区、访问范围、协作配置与角色校验 | [matter-settings.ts](routes/matter-settings.ts)、[matter-roster.ts](routes/matter-roster.ts) |
| 成员管理、角色包导入和应用角色提案 | [team.ts](routes/team.ts)、[role-packages.ts](routes/role-packages.ts) |
| 角色设计、架构师对话及请求取消 | [role-design.ts](routes/role-design.ts) |
| 经验可见性、来源、审核和提炼 | [memories.ts](routes/memories.ts) |
| 组织、工作区与预览服务 | [deliverables-orgs.ts](routes/deliverables-orgs.ts) |
| Git 资料空间与文档提交/Diff | [spaces.ts](routes/spaces.ts)（[acl.ts](acl.ts) 提供 `canAccessSpace` / `canWriteSpace`） |
| 多目录工作区与 Rules/Skills 预算明细 | [workspace-folders.ts](routes/workspace-folders.ts) |

- 经验查询与事件共用角色、组织和工作区访问规则。经验提炼只读取请求者有权使用的角色的经验。预览事件按所关联事项推送，独立预览仅对平台管理员推送。工作区更新事件用 ID 通知刷新。账号 SSE 在发送时复核会话，登出立即关闭该会话的连接。
- 已索引附件按其事项归属校验；非全局账号不能访问没有索引的附件。
- 已有事项的消息沿用现有工作区。先通过事项设置切换工作区，再发送消息。请求指定的负责人、成员与旁听角色按事项的有效组织校验。
修改接口时同时核对[网页 API 模块](../../web/src/README.md#前端状态与组件)的 DTO 和调用方的刷新逻辑，保留已有事项、工作区、成果和反馈兼容性。

[inner-matter.ts](inner-matter.ts) 按所有者显式打开准备内置演示；`POST /api/demos/inner-matter` 复用同一事项，仅补齐缺失初始文件，不运行模型或创建成果。默认目录为 `.data/inner-matter`，自定义数据库时跟随数据库目录。bootstrap 的 `innerDemoAvailable` 控制入口，事项详情的 `demoGuide` 控制引导；用法见[演示说明](../../docs/tutorials/inner-matter-demo.md)。

- 并发、工作区切换与图片上传：
  - 同事项运行中再次派发、切换工作区或负责人返回 409。团队讨论消息仍保存，待本轮结束后可再次邀请 AI。调整全局旁听开关（`observersEnabled`）、
    AI 参与名单（`aiMemberIds`）或旁听列表（`observerMemberIds`）可在运行中即时更新。取消要交给编排核，不只广播停止事件。
  - `POST /api/matters/assess` 默认以 `mode: "rules"` 执行即时本地规则预判（支持传入 `hasFiles: true` 以允许纯附件输入发起评估）；传入 `mode: "model"`（仅所有者可调用，支持 `readRepo: true` 只读查看工作区与连接断开自动 `responseCancellation` 中止）通过 Pi 类型化决策模型返回强校验的推荐阵型与把握度。
  - `POST /api/matters` 支持传入 `aiMemberIds`、`observersEnabled`、定向 `observerMemberIds`、`collaboratorIds` 与可选 `images` / `files`（`POST /api/matters/:id/messages`
    同样支持可选 `observerMemberIds` 与 `images` / `files`）：
    - 图片约束：最多 6 张、PNG/JPEG/WebP/GIF、单张解码 <= 5MB、JSON 上限 36MB，允许纯图片提交。
    - 文本/折叠粘贴文件约束：最多 6 个、单文件 UTF-8 文本 <= 512KB（拒绝含 NUL 的二进制负载），支持 `kind: "file" | "pasted_text"`，允许纯附件提交。
  - 上传图片与 `.txt` 规范化文本附件均按 `YYYY-MM/` 按月分桶落盘 `uploadsDir`（默认 `.data/uploads/YYYY-MM/`；测试未指定时用有界内存缓存）并经 `GET /api/uploads/:filename` 提供访问（`.txt` 响应带 `Content-Type: text/plain; charset=utf-8` 与 `X-Content-Type-Options: nosniff`），消息仅存轻量引用 `metadata.images` / `metadata.files`。
  - 统一发送使用 `conversation`，默认由主责先回应。仅点名人类同事时保存消息并返回 `human_recipient`。`observersEnabled` 只控制协作 AI 主动补充。`discussionAiEnabled` 继续用于旧客户端的显式 `discussion` 请求。启动 AI 仍需满足组织派发权限与并发额度。
  - AI 讨论失败时保留已发消息、已保存的回复及原事项状态。失败消息关联触发本轮讨论的消息。
- 组织与成员身份接口：
  - `PATCH /api/organizations/:id/ai-roles` 接收 `primaryMemberId`，供组织管理员切换到已启用的业务 AI 角色。已有角色配置保留模型、思考档位和 Git 署名。批量更新名册与组织 Git 署名开关时在同一事务保存。
  - [main.ts](main.ts) 启动时自动保证默认组织存在（`ensureDefaultOrganization`），并在首次无任何组织时将无历史、无授权的独立工作区归入默认组织。
  - `GET /api/bootstrap` 下发 `organizations`；`GET /api/organizations`、`POST /api/organizations`、
    `PATCH /api/organizations/:id` 与 `POST /api/organizations/:id/default` 管理组织字段与默认组织切换。
  - 字段覆盖名称、Git 邮箱域名、`isDefault` 与简介；`POST /api/workspaces` 省略 `orgId` 自动归入默认组织
    （显式传 `null` 保留独立工作区）。工作区配置和受限成员名单在同一事务保存。已有事项、经验、执行历史或授权名单时，改变所属组织返回 409。工作区返回含 `repoGitUser`。
  - `POST /api/matters/:id/messages/:messageId/human-decision` 处理已保存的计划决定和角色澄清。指定答复人可提交一次，事项管理者可更换答复人，具备派发权限的答复人或管理者可续跑。服务端校验事项范围与记录版本。
  - `POST /api/members/architect/chat`（对已激活非只读成员开放，无工具隔离、支持中断与按作用域筛选的团队摩擦体检摘要）提供多轮 Meta-Bot 角色与分工规划，返回待确认蓝图（含 `roleScope` 与可选 `newSkills` 草案，确认前不写盘）、结构化体检卡及已有角色调整提案；`POST /api/matters/:id/messages/:messageId/apply-role-proposals` 用于在持久化对话中一键确认/忽略架构师提案卡片，并支持将新建角色直接以协同/旁听/主责身份加入当前事项；`POST /api/members/adjustments/apply` 按勾选结果更新已有角色工具权责与不做清单；`POST /api/members/design` 同时支持即时 `mode: "rules"` 离线草案与显式 `mode: "model"`（`responseCancellation` + Pi 角色设计决策模型生成名称/英文头衔/已安装 Skills/可选 `newSkills` 草案/完整验证计划）；`POST /api/members`、`POST /api/members/batch` 与 `POST /api/members/import` 支持显式传入 `roleScope`（`global` 限超管、`org` 限对应 `org_owner`/`org_admin`/`super_admin`、`personal` 对活跃非 `org_viewer` 用户在 `maxPersonalRoles` 配额内开放）、`ownerOrgId`、已确认落盘的 `newSkills`（写入角色包 `<roleDir>/skills/<name>/SKILL.md` 或 `.data/skills/{global,orgs,users}/`）、`tools`、`antiJobs` 与分段职责；`DELETE /api/members/:id` 同步删除对应角色包目录与仅本人私有库文件；并按 `PATCH /api/members/:id` 维护成员私有 `gitName`、`gitEmail` 与 `identitySummary`。
  - 角色可见性与私有作用域隔离由 [acl.ts](acl.ts) 的 `canActorCreateRoleInScope`、`canActorUseMember` 与 `canActorManageMember` 强制校验：`personal` 角色、模板、`GET /api/runtime` 声明的 MCP 依赖、工具委派、`POST /api/memories` 与 `team_updated` SSE 仅对创建者自身可见与可用，其余用户及超管均不可读取或触发。
  - 私有身份字段不回写共享模板，`/api/members/:id/export` 始终保持脱敏。
  - 角色设计、创建和提案应用保留 `skills`、`mcpDependencies` 及正文中的沟通/验证约定；设计返回 `capabilityReport`，bootstrap 模板附带 MCP 声明。其状态不代替运行时能力核查，见[角色设计](../../docs/reference/role-design.md)。
  - 角色写入在当前服务内依次处理；批量提案先校验全部新增与调整，只有待应用提案可生效。新建 ID 冲突返回 409，非法文件名或思考档位返回 400；导入可更新业务模板，内置架构师不可覆盖。文件采用临时文件替换，删除标记保存在数据库，防止启动复活。具体边界见[角色管理一致性](../../docs/reference/runtime-collaboration.md#角色管理一致性)。
- 多用户团队账号、超级管理员与权限作用域（`PA_REQUIRE_AUTH=1` / `#/admin`）：
  - `GET /api/auth/session`、`GET /api/auth/invite-preview`（未登录安全预览 `orginv_` 邀请组织名/角色及当前用户是否已成员）、`POST /api/auth/setup-admin`（仅零已设密超管时开放一次性初始化超级管理员，支持原地升级 `usr_local_owner`）、`POST /api/auth/register`（支持 `open_auto` / `open_review` / `invite_only`，默认 `open_review`）、`POST /api/auth/login`（邮箱密码 + 可选组织邀请码；受滑动窗口限流 `429` 保护）、`POST /api/auth/logout`（服务端即时吊销）与 `POST /api/auth/change-password` 在 [routes/admin-auth.ts](routes/admin-auth.ts) 维护；`consumeOrgInviteByToken` 对已是成员的用户幂等返回且不扣减使用次数。
  - `GET /api/admin/overview`、`PATCH /api/admin/settings`、`PATCH /api/admin/users/:id`、`GET /api/admin/audit`、`POST /api/admin/matters/:id/abort` 及 `POST /api/admin/runtime/pstack/{install,enable,disable}`（调用 Pi 安装官方方法包，或保存、清除 `platform_settings.pstackDir`，后续岗位读取新设置）仅供 `super_admin`（或未启用强制认证时的本机回环所有者）访问；变更写入 `audit_logs`，禁用账号立即吊销全量会话并断开 SSE。
  - 任何已启用账号成员均可在 `maxOrgs` 配额内自建组织（`POST /api/organizations`），经 `/api/organizations/:id/members*`、`invites*`、`POST /api/organizations/join`、`PATCH /api/organizations/:id`（支持 `useRoleGitIdentity`，默认 `false`）与 `PUT /api/organizations/:id/ai-roles`（支持按组织启用 AI 角色、指定主联系人、覆写各启用角色的 `gitNameOverride` / `gitEmailOverride` 及同步切换 `useRoleGitIdentity`）配置组织人类成员、邀请链接与组织 AI 名册（`ensureOrgEnabledAiRequest` 拦截未启用角色）。
  - `POST /api/workspaces` 支持 `sourceType: "clone"`（校验 `cloneUrl` 禁用 `file:`/`ext::`/参数注入后安全克隆至 `<workspacesRoot>/<orgSlug>/`）与 `sourceType: "local"`（非超管受 `allowLocalWorkspacePath`、`localWorkspaceAllowlist` 与内部运行目录隔离保护），并按 `visibility: "org" | "restricted"` 控制可见成员。
  - 组织内 `org_member` / `org_admin` / `org_owner` 若账号 `canDispatchAi` 启用，可在可见项目与组织/指定私密（`visibility: "org" | "private"`）事项中直接触发 AI `dispatch`（受 `maxActiveDispatches` 并发配额限制），`org_viewer` 禁止直接触发 AI；`/api/bootstrap`、`/api/spaces*`、`/api/matters*`、`/api/uploads/:filename` 与 SSE 推送均按用户 ACL（`canAccessMatter`、`canAccessSpace`、`canAccessWorkspace`）严格隔离，并允许所属组织的 `org_owner`/`org_admin` 在 `POST /api/previews/:id/stop` 中停止其可访问事项的预览。
  - `POST /api/matters` 优先使用仓库所属组织，再使用请求中指定的组织。普通账号在未绑定仓库时省略 `orgId`，或传入 `null`、空字符串，均解析为其所属的默认组织或首个组织。无所属组织时返回 403。Role Architect 与普通事项共用此规则。
  - 本机回环可在未启用强制认证时以所有者访问；携带无效会话凭证时不会回退到免密身份。团队成员通过正式账号和组织邀请加入，并按组织角色和账号派发权限参与事项。
  - 提请只允许从 `pending` 原子转为 `approved` 或 `dismissed`；重复处理/非提请返回 409。批准先校验来源组织与仓库、AI 成员和附件，失败保持待处理；附件缺失返回 410。
  - 图片上传完成后由 `dispatch-runner` 统一检查运行占用，冲突返回 409，不能覆盖原运行进度。运行中的仓库也不能经 PATCH 或同路径 upsert 改归属组织。
- Phase 4 RSI 接口：
  - `POST /api/spaces/documents/:id/feedback` 按文档提交和评价人记录反馈，只评价该提交关联的经验；`neutral` 撤回该评价人的计数。
  - `POST /api/rsi/distill`（支持 `scopeMode` 与断连/`AbortSignal` 级联中止）及 `POST /api/rsi/distill/abort` 支持事项经验提炼与取消；组织 `org_owner`/`org_admin` 可为本组织可见事项触发复盘。
  - `POST /api/memories`、`PATCH /api/memories/:id`、`POST /api/memories/:id/evaluate` 与 `GET /api/memories/:id/applications` 维护三层记忆生命周期；`org_owner`/`org_admin` 可管理所属组织的 `company_private`、`project_private` 及组织内 `org` 角色经验，全局平台角色 `role_general` 仍限超级管理员管理，`org_member`/`org_viewer`/`legacy_token` 禁止写改记忆。
  - `PATCH /api/memories/:id` 支持 `memberId`、`category`、`scope`、`orgId`、`workspaceId`、`status`，并逐个广播 `memory_updated`。
- 运行态恢复与快照：
  - `GET /api/bootstrap` 返回 `activeRuns`、`GET /api/matters/:id` 返回 `activeRun`（含阶段、已流式正文与 `startedAt`），确保前端 F5 刷新恢复。
  - `GET /api/runtime` 返回当前 Agent 底座探测结果（Pi CLI 可用性与 `--version`、会话持久化策略、`pstack` 状态与各执行路径隔离边界）、已加载的 Pi Extensions（内置 `team-extension`、`pstack-methods`、`builtin:mcp` 声明汇总及 `PA_PI_EXTENSIONS` 文件校验），以及按节分组的当前运行配置（环境变量与服务、目录与存储位置、Pi RPC 与桥接参数、编排与工作台边界）；非所有者协同成员请求时将本机路径收口为目录/文件名。
  - 执行失败时先提取 `ProgressSnapshot` 并连同错误与工作区锚点写入 `user` 系统消息 `metadata`（并广播 `matter_failed`），供前端回看与同作用域续跑。
- [dialog-broker.ts](dialog-broker.ts) 在内存中等待 Extension UI 回答，HTTP 回复最终经 RPC 回写 Pi。它不是对所有命令的通用权限拦截器。
- [preview-manager.ts](preview-manager.ts) 启停本地命令或登记外部服务链接；索引在内存中，不是部署系统，也不会因成果登记自动创建预览。
- 退出时先停止接收请求，再取消对话、清理执行树和预览，最后关闭数据库。

从仓库根先运行 `npm run build:web`，再运行 `node --test test/phase3-server.test.ts`。
验证完整启动入口则先 `npm run build`，再 `npm run check:startup`（使用临时数据库且不发模型请求）。不要为验证重启用户现有服务或把模型任务送进业务工作区。

更多执行约束在 [orchestrator](../orchestrator/README.md)，整体服务关系见[当前架构](../../docs/concepts/architecture-and-plan.md)。

- `GET /api/models` 返回服务账号下 Pi 的可用模型、支持的思考等级和启动默认值。平台、组织和事项设置从同一目录校验显式选择。
