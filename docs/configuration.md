# 配置参考

本文集中说明 Personal Agent 当前实际生效的环境变量、服务路径、Pi RPC 参数、岗位模板字段以及编排核内置限制。所有默认数值均以当前源码为准；未列出的能力（如持久化定时后台调度、全局多租户配置或自定义工作流配置文件）尚未实现。

## 1. 环境变量

### 用户可配置项

| 变量名 | 默认值 | 生效位置 | 说明 |
| --- | --- | --- | --- |
| `PORT` | `4310` | [服务入口](../src/server/main.ts) | Web 工作台 HTTP/SSE 监听端口，固定绑定 `127.0.0.1` |
| `PA_DB_PATH` | `<cwd>/.data/personal-agent.db` | [服务入口](../src/server/main.ts) | SQLite 数据库文件路径（离线测试可传 `:memory:`）；`npm run check:startup` 会自动覆盖为临时库 |
| `PA_PI_EXTENSIONS` | 未设置（空） | [服务入口](../src/server/main.ts) → [编排核](../src/orchestrator/team-orchestrator.ts) | 运维者批准加载的额外 Pi 扩展路径列表，按系统路径分隔符（`path.delimiter`，macOS/Linux 为 `:`，Windows 为 `;`）拆分为多个 `--extension` |
| `PA_TURN_TIMEOUT_MS` | `0`（不设固定总上限） | [编排核](../src/orchestrator/team-orchestrator.ts) | 单轮用户事项的墙钟总时长上限（毫秒，覆盖主负责人、内部委托与旁听评估）。默认 `0` 表示按 Goal/Plan 长任务模式运行，不因墙钟固定时长掐断仍在活动的任务，改由无活动看门狗（`PA_IDLE_TIMEOUT_MS`）与手动「停止」收口；设为正整数时按指定毫秒数硬限时 |
| `PA_PROMPT_TIMEOUT_MS` | `0`（不设固定总上限） | [PiRpcWorker](../src/rpc/pi-rpc-worker.ts) / [编排核](../src/orchestrator/team-orchestrator.ts) | 单个 Pi worker 单次 `runPromptAndWait` 的墙钟硬上限（毫秒）；在未设置 `PA_TURN_TIMEOUT_MS` 时也作为编排核整轮总上限回退值（`0` 表示关闭） |
| `PA_IDLE_TIMEOUT_MS` | `900000`（15 分钟） | [PiRpcWorker](../src/rpc/pi-rpc-worker.ts) | 单个 Pi worker 连续无任何 RPC 事件或 notice 时的静默看门狗上限（毫秒，`0` 表示关闭）；在 `delegate_to_member` / `publish_deliverable` / 对话框等待期间自动暂停 |
| `NODE_ENV` | 未设置 | [前端构建脚本](../scripts/build-web.mjs) | 设为 `production` 时，`npm run build:web` 启用 esbuild 代码压缩 |

> **说明**：模型厂商凭证（如 `kimi-coding` 等 provider 的认证配置）不保存在本仓库变量中，直接复用本机 Pi CLI 环境配置；请勿将密钥写入代码或 `roles/*.md`。

### 宿主内部保留变量（请勿手工占用或覆写）

以下变量由编排核或预览管理器在拉起子进程时自动注入，用于工具桥接鉴权与端口隔离：

- **Pi 子进程注入**（[编排核](../src/orchestrator/team-orchestrator.ts) / [工具桥接](../src/rpc/team-tool-bridge.ts) / [团队扩展](../src/rpc/team-extension.ts)）：`PA_TEAM_BRIDGE_URL`、`PA_TEAM_BRIDGE_TOKEN`、`PA_CAN_PUBLISH`、`PA_CAN_DELEGATE`、`PA_CAN_EXPERIENCE`、`PA_REQUIRED_TOOLS`、`PA_MEMBER_CONTEXT`
- **本地预览子进程注入**（[PreviewManager](../src/server/preview-manager.ts)）：`PORT`、`HOST="127.0.0.1"`

---

## 2. 目录结构与默认存储位置

服务入口 [src/server/main.ts](../src/server/main.ts) 在当前工作目录（`process.cwd()`）下按以下固定路径加载或写入资产：

| 路径 | 用途 | 备注 |
| --- | --- | --- |
| `.data/personal-agent.db` | 默认用户 SQLite 数据库 | 可通过 `PA_DB_PATH` 重定向 |
| `.data/pi-sessions` | Pi 会话持久目录（`--session-dir`） | 按事项、成员、工作区路径与会话模式精确记录 `sessionFile` 与 `piSessionId` |
| `roles/` | 可分享岗位模板 Markdown 目录 | 启动时扫描 `.md`（自动跳过 `README.md`）；在工作台新建或导入角色会落盘至此 |
| `skills/<name>/SKILL.md` | 角色引用的技能说明文件 | 供启动参数 `--skill` 显式挂载 |
| `web/dist/` | 前端构建输出目录 | 由 `npm run build:web` 从 `web/src/main.tsx` 与 `web/index.html` 生成，勿手工编辑 |

启动初始化规则：
- 若数据库中 `workspace_links` 表为空，启动时自动登记当前仓库（名称 `personal-agent`，默认分支 `main`）。
- 若数据库中存在旧表结构，[database.ts](../src/storage/database.ts) 仅做幂等增量迁移（如 `worker_sessions.context_key`、`message_cursor`、`matters.observer_ids_json`、`matter_execution_leases`、`deliverables.feedback_rating`、`member_memories` 生命周期与评估计数字段及 `memory_applications` 表），不改写历史消息或成果。

---

## 3. Pi RPC、工作进程与桥接参数

### CLI 启动与能力装配

编排核启动每个成员 worker 时采用隔离策略（见 [团队编排核](../src/orchestrator/team-orchestrator.ts) 与 [运行说明](runtime-collaboration.md)）：

- 固定参数：`--mode rpc --no-extensions --no-skills`，再按顺序显式传入团队扩展（源码或构建后的 `team-extension`）、`PA_PI_EXTENSIONS`、角色声明的 `--skill` 路径，以及限定可用工具清单的 `--tools`。
- MCP 开关：当角色 `mcpDependencies` 为空时附加 `--no-mcp`；非空时附加 `--extension builtin:mcp`，并在工具列表中声明对应 `mcp__<server>__*` 前缀。
- 会话接续：未开启 `noSession` 且存在同上下文记录时，先由 [execution-context.ts](../src/orchestrator/execution-context.ts) 校验 JSONL 首行 `sessionId` 与真实 `cwd`，通过后传入 `--session <sessionFile>`；绝不使用 `--continue`。

### 进程与传输超时配置（代码常量 / 可构造参数）

| 参数 | 默认值 | 定义位置 | 说明 |
| --- | --- | --- | --- |
| `executable` | `"pi"` | `PiRpcWorkerOptions` | Pi CLI 可执行文件路径或命令名 |
| `commandTimeoutMs` | `30000`（30s） | `PiRpcWorkerOptions` | 单条 RPC 控制命令（如 `get_state`、`prompt`、`abort`）等待响应超时 |
| `shutdownGraceMs` | `2000`（2s） | `PiRpcWorkerOptions` | `stop()` 优雅关闭等待时长，超时后发送 `SIGTERM` / `SIGKILL` |
| `idleTimeoutMs` | `900000`（15 分钟，可由 `PA_IDLE_TIMEOUT_MS` 覆写） | `RunPromptOptions` | 无任何 RPC 事件或 notice 时的空闲看门狗（有正的 `timeoutMs` 时不超过 `timeoutMs`，设为 `0` 关闭）；在宿主执行 `delegate_to_member` / `publish_deliverable` 期间通过 `suspendIdleTimeout()` 暂停父 worker 计时 |
| 动态工具等待上限 | `10000`（10s） | [team-extension.ts](../src/rpc/team-extension.ts) | `session_start` 后轮询 `pi.getAllTools()` 等待异步扩展或 MCP 注册完成的最长时间 |
| 桥接 `/ready` 握手超时 | `30000`（30s） | [team-tool-bridge.ts](../src/rpc/team-tool-bridge.ts) | 宿主等待子扩展回报实际激活工具清单的最长时间 |
| 桥接 HTTP 传输超时 | `0`（禁用） | [team-extension.ts](../src/rpc/team-extension.ts) / [team-tool-bridge.ts](../src/rpc/team-tool-bridge.ts) | 使用 `node:http` 与关闭服务端 `requestTimeout`/`headersTimeout`/`keepAliveTimeout`，避免长耗时委托被默认 300s 传输超时中断 |
| 桥接单次请求体积上限 | `262144` 字节（256 KiB） | [team-tool-bridge.ts](../src/rpc/team-tool-bridge.ts) | 工具请求 JSON 上限 |
| 取消停止等待上限 | `1000`（1s） | [team-orchestrator.ts](../src/orchestrator/team-orchestrator.ts) | `abortMatter()` 等待每个 worker 响应 `abort` 的上限，随后强制 `stop()` |

---

## 4. 岗位模板配置（`roles/*.md`）

角色模板由 [template-loader.ts](../src/roles/template-loader.ts) 解析，详细资产约定另见 [roles/README.md](../roles/README.md)。

### Frontmatter 字段说明

| 字段 | 是否必填 | 默认 / 合法值 | 说明 |
| --- | --- | --- | --- |
| `id` | 必填 | 唯一字符串 | 成员主键，决定与历史消息、会话、私有记忆的关联 |
| `name` | 必填 | 字符串 | 团队展示名（如「产品经理」） |
| `title` | 必填 | 字符串 | 岗位英文头衔（如 `Product Manager`） |
| `version` | 必填 | 版本串（如 `1.0.0`） | 模板版本号 |
| `defaultProvider` | 必填 | 字符串（内置默认 `kimi-coding`） | 默认模型提供商 |
| `defaultModel` | 必填 | 字符串（内置默认 `kimi-for-coding`） | 默认模型 ID |
| `thinkingLevel` | 必填 | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` | 思考深度；内置四角色默认 `high` |
| `shareable` | 可选 | 布尔，默认 `true` | 是否允许作为通用岗位定义导出 |
| `isPrimaryContact` | 可选 | 布尔，默认 `false` | 是否为新安装默认主要联系人（无关键词命中时兜底） |
| `keywords` | 可选 | 字符串数组 `[]` | 仅用于**新建事项未指定成员**时的初始关键词匹配评分 |
| `tools` | 可选 | 字符串数组 `[]` | 声明启用工具；`mcp` 分类标记会在装配时过滤；`TeamOrchestrator` 未读取到声明时兜底 `["read", "bash", "edit", "write"]`；工作台 `POST /api/members` 新建角色默认写入 `["read", "bash"]` |
| `skills` | 可选 | 字符串数组 `[]` | 技能清单。解析顺序：绝对路径 → 含 `/` 时相对角色文件目录 → `skills/<name>/SKILL.md` |
| `mcpDependencies` | 可选 | 字符串数组 `[]` | 声明依赖的 MCP 服务名，启动前校验存在对应 `mcp__<name>__*` 工具 |

### 正文结构要求

正文支持五个标准二级标题，每轮通过 `before_agent_start` 注入最新角色上下文：

- `## 职责与边界`
- `## 技能与工作方法`
- `## 工具与环境依赖`
- `## 协作和沟通约定`
- `## 交付与验证方式`

---

## 5. 编排边界、旁听席与工作台参数

以下规则目前内置在 [team-orchestrator.ts](../src/orchestrator/team-orchestrator.ts)、[team-tool-bridge.ts](../src/rpc/team-tool-bridge.ts)、[repositories.ts](../src/storage/repositories.ts)、[app.ts](../src/server/app.ts) 与 [preview-manager.ts](../src/server/preview-manager.ts) 中，作为系统运行边界：

### 协作与会话边界

| 规则项 | 当前内置值 | 说明 |
| --- | --- | --- |
| 内部委托调用链深度 | 最多 `3` 名成员 | `chain.length >= 3` 时拒绝，且禁止自委托与环形委托（调用祖先） |
| 单轮内部委托次数 | 最多 `8` 次不同委托 | 超出后拒绝新委托；同轮同参数成功委托会复用结果，失败则清除缓存允许重试 |
| 成员切换有界背景 | 最多 `12` 条 / `20000` 字符 | 仅对新会话或成员切换后 `afterCursor` 之后的同事项、同工作区 `user` 频道增量生效 |
| 私有记忆注入规则 | 按 `scope` 过滤 | `role_general` 跨项目注入；`company_private` 与 `project_private` 仅在匹配当前 `workspaceId` 时注入 |
| 新事项默认标题 | 首条提问前 `60` 字符 | 调用方未显式传 `title` 时取 `prompt.slice(0, 60)` |
| 事项摘要（`matter.summary`） | 主回复前 `200` 字符 | 每轮结束更新为 `replyText.slice(0, 200)` |

### 旁听席（`observerMemberIds`）与背景摘要预算

- **配置入口**：可通过 `POST /api/matters`、`POST /api/matters/:id/messages` 或 `PATCH /api/matters/:id` 设置或调整旁听成员数组；与切换工作区（运行中返回 HTTP 409）不同，**旁听成员可在执行进行中实时调整**，不中断主负责人。
- **权限隔离**：旁听成员运行在独立 `observer` 会话模式下，工具列表自动剔除 `edit`、`write`、`publish_deliverable` 与 `delegate_to_member`（双端禁权，只读审视）。
- **静默识别**：默认哨兵 `[SILENT]`；同时兼容 `[PASS]`、`[NOOP]`、`暂无异议`、`无需补充`、`无需发言`（均不写入用户频道）。
- **旁听提示与摘要窗口**：
  - 当前轮输入：用户发言最多截取 `2000` 字符，主负责人回复最多截取 `6000` 字符。
  - 首次接入背景摘要（`buildObserverContextDigest`）：保留事项标题/最新摘要/已归档成果标题，并从最新往前取最多 **`16` 条** `user` 频道历史消息（单条最多 `400` 字符），整体控制在 **`6000` 字符**总预算内（并至少为消息摘录保留 `1200` 字符）；后续轮次仅按 `messageCursor` 增量传入新增交流，不回放 `internal_collab` 或 `notice` 全量日志。

### 私有记忆与 RSI 经验提炼边界

- **状态流转与范围隔离**：`member_memories.status` 区分 `candidate`（待核验，不视为已确认定稿）、`verified`（已验证）、`superseded`（被后续已验证新规 `supersedes_memory_id` 自动替代并退出注入）、`rejected`（人工忽略并退出注入）。`role_general` 强制保持 `workspaceId = null` 跨项目注入；`company_private` 与 `project_private` 仅匹配当前 `workspaceId` 时注入，且永不导出至 `roles/*.md`。
- **执行期经验提案**：非旁听成员可调用 `propose_experience`，单条 `content` 与 `rationale` 各自上限 `1200` 字符（暂存后仅在整轮无中止正常完成时写入 `"candidate"`）；旁听成员固定注入 `PA_CAN_EXPERIENCE="false"` 禁止提案。
- **只读 AI 复盘提炼**（`TeamOrchestrator.distillExperiences`）：以 `noSession: true` 及 `--no-extensions --no-skills --no-mcp --tools ""` 启动只读反思 worker，单次默认超时 `120000` ms（2 分钟），最多读取前 `8` 条候选并校验范围、成员和去重（可选 `supersedesMemoryId` 仅能指向同成员、同 scope/工作区旧规则，且不能成环）。
- **应用与验收评估幂等计数**（`memory_applications`）：每轮被注入提示词的经验记录一次 `applied` 与 `applied_count + 1`；当前版本只评价 `deliverable_memory_applications` 中精确关联的注入记录，`memory_feedback_votes` 每成果/经验一票；相同票幂等，改票替换、`neutral` 撤回。卡片手动评价独立累计，旧历史不猜测补关联或重算。

### 工具载荷、日志、SSE 与预览管理限制

- **桥接参数长度限制**（[team-tool-bridge.ts](../src/rpc/team-tool-bridge.ts)）：`callId` ≤ 256、`memberId` ≤ 256、`task` ≤ 16000、`title` ≤ 200、`changeNote` ≤ 2000、`summary` ≤ 1000（默认通用非空文本 ≤ 64000 字符）。
- **过程记录截断**：`notice` 单条工具事件截取 `16000` 字符；进度面板 `recentLogs` 最多保留最近 `6` 条活动。
- **SSE 心跳**（[app.ts](../src/server/app.ts)）：`/api/events` 每 `15000` ms 发送一次 `: ping` 保活帧。
- **本地预览管理**（[preview-manager.ts](../src/server/preview-manager.ts)）：命令预览默认端口监听超时 `startupTimeoutMs = 5000` ms、内存中最多保留 `200` 行日志、停止时等待 `SIGTERM` 宽限 `1500` ms 后强杀 `SIGKILL`；未传入 `port` 时自动分配 `127.0.0.1` 临时空闲端口。

---

## 相关文档

- 架构与模块边界：[当前架构与后续计划](architecture-and-plan.md)
- 会话隔离、委托与归档机制：[连续上下文与内部角色协作](runtime-collaboration.md)
- 岗位资产维护说明：[roles/README.md](../roles/README.md)、[skills/README.md](../skills/README.md)
- 常用构建与检验命令：[scripts/README.md](../scripts/README.md)
