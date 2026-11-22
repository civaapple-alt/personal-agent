# 配置参考

本页供服务管理员和维护者查找环境变量、数据目录、Pi RPC 参数及角色字段。在「设置 → 运行配置」（`#/settings/config`）查看当前实例的生效值。

- [环境变量](#1-环境变量)
- [默认存储位置](#2-目录结构与默认存储位置)
- [Pi RPC 与资源装配](#3-pi-rpc工作进程与桥接参数)
- [岗位模板字段](#4-岗位模板配置rolesmd)
- [编排、旁听与工作台参数](#5-编排边界旁听席与工作台参数)

## 1. 环境变量

### 用户可配置项

| 变量名 | 默认值 | 生效位置 | 说明 |
| --- | --- | --- | --- |
| `TYPESAFE_API_KEY` | 未设置 | [服务入口](../../src/server/main.ts) | 启用 Jev System One 分类器。优先读取服务环境变量，也可在启动目录的 `.env` 中配置。服务只从该文件读取此凭据。 |
| `PORT` | `4310` | [服务入口](../../src/server/main.ts) | Web 工作台 HTTP/SSE 监听端口 |
| `PA_HOST` | `127.0.0.1` | [服务入口](../../src/server/main.ts) | HTTP 服务绑定地址；设为 `0.0.0.0` 时开放局域网协作并在控制台打印可用局域网地址 |
| `PA_DB_PATH` | `<cwd>/.data/personal-agent.db` | [服务入口](../../src/server/main.ts) | SQLite 数据库文件路径（离线测试可传 `:memory:`）；`npm run check:startup` 会自动覆盖为临时库 |
| `PA_SESSION_DIR` | `<cwd>/.data/pi-sessions` | [服务入口](../../src/server/main.ts) | Pi CLI 会话文件持久化根目录；隔离脚本（如 [start-team-sandbox.mjs](../../scripts/start-team-sandbox.mjs)）可单独重定向以避免写入 `.data/pi-sessions` |
| `PA_REQUIRE_AUTH` | `0`（关闭） | [服务入口](../../src/server/main.ts) → [HTTP 鉴权](../../src/server/auth.ts) | 设为 `1`/`true` 启用多用户强制认证模式（禁止本机回环免登录回退，需超管初始化并凭账号会话或口令访问） |
| `PA_WORKSPACES_ROOT` | `<dataDir>/team-workspaces` | [服务入口](../../src/server/main.ts) → [Git 克隆](../../src/server/git-clone.ts) | 多团队默认 Git 克隆主目录；各组织从 Git 地址克隆的代码库自动落盘至 `<workspacesRoot>/<orgSlug>/`（也可在 `#/admin` 动态修改） |
| `PA_ADMIN_EMAIL` / `PA_ADMIN_PASSWORD` | 未设置（空） | [服务入口](../../src/server/main.ts) | 可选的非交互式初始超级管理员自举凭证；当 `users` 表为空且两者均有值（密码 ≥ 8 位）时启动即创建初始 `super_admin` 账号 |
| `PA_LOCAL_PI_RESOURCES` | 个人版回环监听下启用 | [服务入口](../../src/server/main.ts) | 设为 `0` 时恢复显式装配。本机所有者在个人版回环监听下启动的业务主责与内部委托可使用 Pi 原生资源发现 |
| `PA_PI_EXTENSIONS` | 未设置（空） | [服务入口](../../src/server/main.ts) → [编排核](../../src/orchestrator/team-orchestrator.ts) | 运维者批准加载的额外 Pi 扩展路径列表，按系统路径分隔符（`path.delimiter`，macOS/Linux 为 `:`，Windows 为 `;`）拆分为多个 `--extension` |
| `PA_PSTACK_DIR` | 未设置（可由工作台 `#/settings/extensions` 克隆启用至 `.data/extensions/repo/pstack`） | [服务入口](../../src/server/main.ts) → [执行装配](../../src/orchestrator/worker-runner.ts) | 完整 pstack 包根目录，包含 `plugin.json` 和 `skills/poteto-mode/SKILL.md`；启动未传该变量时回退读取 `platform_settings.pstackDir`，详见 [pstack 内循环](../guides/pstack-runtime.md) |
| `PA_TURN_TIMEOUT_MS` | `0`（不设固定总上限） | [编排核](../../src/orchestrator/team-orchestrator.ts) | 单轮用户事项的墙钟总时长上限（毫秒，覆盖主负责人、内部委托与旁听评估）。默认 `0` 表示按 Goal/Plan 长任务模式运行，不因墙钟固定时长掐断仍在活动的任务，改由无活动看门狗（`PA_IDLE_TIMEOUT_MS`）与手动「停止」收口；设为正整数时按指定毫秒数硬限时 |
| `PA_PROMPT_TIMEOUT_MS` | `0`（不设固定总上限） | [PiRpcWorker](../../src/rpc/pi-rpc-worker.ts) / [编排核](../../src/orchestrator/team-orchestrator.ts) | 单个 Pi worker 单次 `runPromptAndWait` 的墙钟硬上限（毫秒）；在未设置 `PA_TURN_TIMEOUT_MS` 时也作为编排核整轮总上限回退值（`0` 表示关闭） |
| `PA_IDLE_TIMEOUT_MS` | `900000`（15 分钟） | [PiRpcWorker](../../src/rpc/pi-rpc-worker.ts) | 单个 Pi worker 连续无任何 RPC 事件或 notice 时的静默看门狗上限（毫秒，`0` 表示关闭）；在 `delegate_to_member` / 对话框等待期间自动暂停 |
| `NODE_ENV` | 未设置 | [前端构建脚本](../../scripts/build-web.mjs) | 设为 `production` 时，`npm run build:web` 启用 esbuild 代码压缩 |

> **说明**：模型厂商凭证（如 `kimi-coding` 等 provider 的认证配置）不保存在本仓库变量中，直接复用本机 Pi CLI 环境配置；请勿将密钥写入代码或 `roles/*.md`。

### 宿主内部保留变量（请勿手工占用或覆写）

以下变量由编排核或预览管理器在拉起子进程时自动注入，用于工具桥接鉴权与端口隔离：

- **Pi 子进程注入**（见[编排核](../../src/orchestrator/team-orchestrator.ts)与[工具桥接](../../src/rpc/team-tool-bridge.ts) / [团队扩展](../../pi-extensions/team-extension/index.ts)）：
  - `PA_TEAM_BRIDGE_URL`、`PA_TEAM_BRIDGE_TOKEN`、`PA_CAN_SAVE_SPACE`
  - `PA_CAN_DELEGATE`、`PA_CAN_EXPERIENCE`、`PA_REQUIRED_TOOLS`、`PA_MEMBER_CONTEXT`
- **本地预览子进程注入**（[PreviewManager](../../src/server/preview-manager.ts)）：`PORT`、`HOST="127.0.0.1"`

---

## 2. 目录结构与默认存储位置

以下默认路径相对于启动服务的目录。`<dataDir>` 是数据库所在目录，默认是 `.data/`。来源见[服务入口](../../src/server/main.ts)。

```text
.data/
├── # ── 核心业务资产（备份必选）──────────────────────────────────────────────────
├── personal-agent.db (+ -wal / -shm)   # SQLite 主库（元数据、账号、RBAC、事项消息、记忆、索引）
├── spaces/                             # 【资料空间】按作用域分目录，每个空间独立 Git 仓库（懒初始化）
│   ├── orgs/<orgId>/                   #   组织默认空间（.git/ + pages/<docId>.md）
│   ├── workspaces/<workspaceId>/       #   仓库默认空间
│   ├── users/<userId>/                 #   人类用户个人空间（私密事项默认落此）
│   ├── members/<memberId>/             #   AI 角色默认空间
│   └── custom/<spaceId>/               #   自定义空间
├── roles/                              # 【运行期自定义 AI 角色】按作用域分层（覆盖/补充仓库内置 roles/）
│   ├── <roleId>.md 或 <roleId>/        #   global：平台通用角色
│   ├── orgs/<orgId>/<roleId>/          #   org：组织共享角色（支持角色包及内嵌 skills/）
│   └── users/<userId>/<roleId>/        #   personal：个人私有角色（仅本人可见）
├── skills/                             # 【运行期自定义 Skill】与 roles/ 对齐的三层作用域
│   ├── global/<skillName>/SKILL.md     #   平台通用
│   ├── orgs/<orgId>/<skillName>/       #   组织共享
│   └── users/<userId>/<skillName>/     #   个人私有
├── uploads/                            # 【对话附件】按 YYYY-MM/ 分桶存放图片与 .txt
│   └── 2026-11/<timestamp>-<hash>.{png,txt}
│
├── # ── 可重建运行态 / 缓存（备份可选，可按需重拉或清理）──────────────────────────
├── pi-sessions/                        # 【Pi 会话文件】对齐原生 ~/.pi/agent/sessions/--<encoded-cwd>--/
│   └── --Users-xxx-repo--/<timestamp>_<uuid>.jsonl
├── team-workspaces/                    # 【远程克隆的业务代码仓】按组织 slug 分组（可重新 clone）
│   └── <orgSlug>/<repoName>/
├── extensions/                         # 【托管扩展包】早期工作台克隆的方法包目录
│   └── repo/
└── inner-matter/                       # 【四步内置演示】按需准备的虚构演练 Git 仓库
```

| 路径 | 用途 | 备注 |
| --- | --- | --- |
| `.data/personal-agent.db` | 默认用户 SQLite 数据库 | 可通过 `PA_DB_PATH` 重定向 |
| `.data/spaces/` | 资料空间独立 Git 仓库目录 | 按作用域分目录存放（`orgs/<orgId>/`、`workspaces/<wsId>/`、`users/<userId>/`、`members/<memberId>/`、`custom/<spaceId>/`），首次写入或创建自定义空间时懒初始化；自定义 `PA_DB_PATH` 时跟随数据库目录，`:memory:` 时使用临时目录 |
| `.data/inner-matter` | 按需准备的内置演示 Git 工作区 | 自定义 `PA_DB_PATH` 时位于数据库同级的 `inner-matter/`；`:memory:` 启动不提供演示入口。初始化不运行模型、不覆盖已有文件 |
| `.data/pi-sessions` | Pi 会话文件 | 用 `PA_SESSION_DIR` 更改。按原生 Pi 规则在 `--<encoded-cwd>--/` 子目录下分仓存放（旧平铺会话文件仍按精确 `sessionFile` 继续恢复） |
| `.data/uploads/` | 消息附件 | 跟随数据库目录；上传按 `YYYY-MM/` 按月分桶落盘 |
| `.data/team-workspaces/` | 团队 Git 克隆 | 默认跟随数据库目录。可用 `PA_WORKSPACES_ROOT` 或超管控制台更改 |
| `.data/extensions/repo/` | 工作台克隆的方法包 | 跟随数据库目录；通过环境变量手动指定的包保留原路径 |
| `roles/` | 内置可分享岗位模板 Markdown 目录 | 启动时扫描 `.md`（自动跳过 `README.md`），保存仓库自带的基础模板 |
| `.data/roles/` | 运行时自建/调整角色目录 | 根目录属全局作用域（`global`），`orgs/<orgId>/` 属组织共享（`org`），`users/<userId>/` 属个人私有（`personal`）；各作用域同时支持 `<id>.md` 单文件与带包内 Skill 的 `<id>/<id>.md` 目录。自定义 `PA_DB_PATH` 时位于数据库同级 `roles/`；`:memory:` 时创建临时目录并于退出后清理 |
| `.data/skills/` | 运行时自定义 Skill 库目录 | 按 `global/`、`orgs/<orgId>/` 与 `users/<userId>/` 隔离存放确认后落盘的 `<skillName>/SKILL.md`（若随角色包隔离则位于 `<roleDir>/skills/<skillName>/SKILL.md`）；自定义 `PA_DB_PATH` 时位于数据库同级 `skills/` |
| `skills/<name>/SKILL.md` | 内置岗位引用的技能说明文件 | 供启动参数 `--skill` 显式挂载，执行器会校验所有解析后路径落在允许作用域根目录内 |
| `web/dist/` | 前端构建输出目录 | 由 `npm run build:web` 从 `web/src/main.tsx` 与 `web/index.html` 生成，勿手工编辑 |

修改 `PA_DB_PATH` 后，会话仍从 `PA_SESSION_DIR` 或启动目录下的 `.data/pi-sessions` 读取。手动指定的仓库和方法包路径也需要单独保留。迁移前请按[备份步骤](../guides/team-administration.md#保存与备份运行资料)收集数据。

### `.data/` 与组织、仓库、用户及 AI 角色的映射关系

| 维度 | SQLite (`personal-agent.db`) | `.data/` 磁盘位置 | 权限与隔离边界 |
| --- | --- | --- | --- |
| **组织 (Org)** | `organizations`、`organization_members`、`organization_invites`、`organization_ai_roles`、`member_memories(company_private)` | `spaces/orgs/<orgId>/`、`roles/orgs/<orgId>/`、`skills/orgs/<orgId>/`、`team-workspaces/<orgSlug>/` | 组织成员 RBAC（`org_owner`/`org_admin`/`org_member`/`org_viewer`） |
| **仓库 (Workspace)** | `workspace_links`、`workspace_members`、`member_memories(project_private)` | 远程克隆仓在 `team-workspaces/<orgSlug>/<repo>/`（本地绑定仓在宿主外部路径）；配套空间在 `spaces/workspaces/<wsId>/` | 仓库可见性 `org` / `restricted` 成员名单 |
| **人类用户 (User)** | `users`、`user_sessions`、`collaborators`、`audit_logs` | `spaces/users/<userId>/`、`roles/users/<userId>/`、`skills/users/<userId>/` | 严格本人隔离（个人空间与 `personal` 角色连超管也不可访问他人数据） |
| **AI 成员角色 (Member)** | `team_members`、`member_memories`、`worker_sessions` | 自定义定义在 `roles/`、`roles/orgs/`、`roles/users/`；配套空间在 `spaces/members/<memberId>/`；模型上下文在 `pi-sessions/--<encoded-cwd>--/*.jsonl` | 按 `role_scope` 隔离定义，会话键包含组织、仓库、事项与触发用户 |
| **事项 (Matter)** | `matters`、`matter_messages`、`space_documents`（索引）、`uploads_index` | 无独立事项目录：空间文档落入目标默认空间 Git 仓库（私密事项→发起人 `spaces/users/<userId>/`、非私密→`spaces/workspaces/<wsId>/` 或 `spaces/orgs/<orgId>/`）；附件按月落 `uploads/YYYY-MM/` | 按事项 `visibility`（`org`/`private`）与组织/仓库 ACL 控制 |

启动初始化规则：
- 若数据库中 `workspace_links` 表为空，启动时自动登记当前仓库（名称 `personal-agent`，默认分支 `main`）。
- [database.ts](../../src/storage/database.ts) 在空数据库创建当前表结构。其他格式的数据库会被拒绝，不会被修改；请为 0.7.0 指定新的数据目录。

---

## 3. Pi RPC、工作进程与桥接参数

### 模型选择

供应商与模型 ID 一起选择，思考等级可留空交给 Pi 解析。覆盖顺序为事项主责、组织岗位、平台设置中的 `defaultModelSelection`、服务账号的 Pi 默认。服务从独立的 Pi RPC 会话读取模型目录和有效默认。该查询不发送模型请求，也不加载工作区的项目配置。启用模型的操作见[使用指南](../guides/user-guide.md#调整岗位模型)。

### CLI 启动与能力装配

服务启动时运行 `pi --version`，在启动日志显示版本或检查失败原因。「设置 → Agent 底座」可查看同一次检查结果。安装 Pi CLI 或调整服务账号的 PATH 后，重启 PA 重新检查。

岗位工作进程使用 `--mode rpc`，显式传入团队扩展、角色声明的 `--skill` 路径、`PA_PI_EXTENSIONS` 指定的扩展和角色的 `--tools` 清单。配置 pstack 时还会装配它的模式入口及方法工具。所选工作区作为 Pi 的当前目录。团队扩展按工作区范围过滤自动发现的上下文文件。

超级管理员可为指定岗位启用 `pi-web-access`。PA 通过 `pi list --no-approve` 找到服务账号安装的 npm 包，并按其清单加载入口。安装和岗位授权分别管理。 [网页检索设置](../guides/web-search.md)

个人版仅监听回环地址时，本机免密所有者发起的业务主责与内部委托沿用 Pi 的原生资源发现：

- 已登记的本地仓库可使用仓库 `.agents/skills` 和 Pi 认可的 `.pi/` 设置与资源。Pi 读取现有的项目可信记录，设置合并与资源启停由 Pi 处理。
- 用户级 `~/.agents/skills` 和 Pi 配置目录中已启用的扩展可继续使用。Pi 配置目录也可由 `PI_CODING_AGENT_DIR` 指定。未绑定仓库时只启用用户级资源发现。
- 团队版、局域网监听、账号或邀请口令访问、托管克隆仓库、讨论和旁听继续通过 `--no-extensions --no-skills` 显式装配。独立决策、架构师和复盘使用各自的窄工具配置。
- 角色的 `mcpDependencies` 仍决定 MCP 工具的启用及允许名单。启用原生资源发现时，Pi 关闭启动阶段的网络操作。

工作进程使用匹配当前事项、工作区、组织、执行模式与资源策略的会话。继承本机资源的会话与显式装配的会话独立保存。接续前核对会话首行的 ID 和真实 `cwd`，确认后传入 `--session <sessionFile>`。 [会话文件核对](../../src/orchestrator/execution-context.ts)

### 项目信任与文件访问

主责、内部委托、旁听和讨论回复都在 Pi RPC 中运行。Pi 在启动时根据工作目录判断是否加载受项目信任保护的资源。RPC 跳过交互确认。没有命令行覆盖、扩展决定或已保存记录时，全局 `defaultProjectTrust` 为 `ask` 或 `never` 会跳过这些项目资源，为 `always` 会加载它们。显式装配的 `--no-extensions --no-skills` 关闭这两类资源的自动发现。项目可信时，项目提示模板等其他资源仍可加载。 [Pi 项目信任规则](https://docs.pi.dev/latest/security#understand-project-trust)

消息里提到的参考路径不会改变 Pi 的当前目录。内置文件工具接受绝对路径，访问范围取决于本轮装配的工具、运行工作台的系统账号和执行环境。即使参考仓库的项目可信记录为拒绝，具备相应系统权限的 `read`、`edit` 或 `write` 仍可访问其文件。当前统一输入框的讨论回复只装配读取类工具，旁听会排除 `edit` 和 `write`。 [岗位工具装配](../../src/orchestrator/worker-runner.ts) · [本机执行与数据流](../../SECURITY.md#本机执行与数据流)

以文件为来源发布文档成果时，PA 另外校验文件的真实路径，要求它位于当前事项工作区。 [文件成果来源校验](../../src/orchestrator/execution-context.ts)

### 进程与传输超时配置（代码常量 / 可构造参数）

| 参数 | 默认值 | 定义位置 | 说明 |
| --- | --- | --- | --- |
| `executable` | `"pi"` | `PiRpcWorkerOptions` | Pi CLI 可执行文件路径或命令名 |
| `commandTimeoutMs` | `30000`（30s） | `PiRpcWorkerOptions` | 单条 RPC 控制命令（如 `get_state`、`prompt`、`abort`）等待响应超时 |
| `shutdownGraceMs` | `2000`（2s） | `PiRpcWorkerOptions` | `stop()` 优雅关闭等待时长，超时后发送 `SIGTERM` / `SIGKILL` |
| `idleTimeoutMs` | `900000`（15 分钟，可由 `PA_IDLE_TIMEOUT_MS` 覆写） | `RunPromptOptions` | 无任何 RPC 事件或 notice 时的空闲看门狗（有正的 `timeoutMs` 时不超过 `timeoutMs`，设为 `0` 关闭）；在宿主执行 `delegate_to_member` 期间通过 `suspendIdleTimeout()` 暂停父 worker 计时 |
| 动态工具等待上限 | `10000`（10s） | [team-extension.ts](../../pi-extensions/team-extension/index.ts) | `session_start` 后轮询 `pi.getAllTools()` 等待异步扩展或 MCP 注册完成的最长时间 |
| 桥接 `/ready` 握手超时 | `30000`（30s） | [team-tool-bridge.ts](../../src/rpc/team-tool-bridge.ts) | 宿主等待子扩展回报实际激活工具清单的最长时间 |
| 桥接 HTTP 传输超时 | `0`（禁用） | [team-extension.ts](../../pi-extensions/team-extension/index.ts) / [team-tool-bridge.ts](../../src/rpc/team-tool-bridge.ts) | 使用 `node:http` 与关闭服务端 `requestTimeout`/`headersTimeout`/`keepAliveTimeout`，避免长耗时委托被默认 300s 传输超时中断 |
| 桥接单次请求体积上限 | `262144` 字节（256 KiB） | [team-tool-bridge.ts](../../src/rpc/team-tool-bridge.ts) | 工具请求 JSON 上限 |
| 取消停止等待上限 | `1000`（1s） | [team-orchestrator.ts](../../src/orchestrator/team-orchestrator.ts) | `abortMatter()` 等待每个 worker 响应 `abort` 的上限，随后强制 `stop()` |

---

## 4. 岗位模板配置（`roles/*.md`）

角色模板由 [template-loader.ts](../../src/roles/template-loader.ts) 解析，详细资产约定另见 [roles/README.md](../../roles/README.md)。

### Frontmatter 字段说明

| 字段 | 是否必填 | 默认 / 合法值 | 说明 |
| --- | --- | --- | --- |
| `id` | 必填 | 最长 128 字符的小写字母、数字和连接短横线，如 `contract-reviewer`；不接受 `readme` | 成员主键与文件名；新建冲突返回 409，导入同 ID 可更新业务模板，内置 `role-architect` 不可覆盖 |
| `name` | 必填 | 字符串 | 团队展示名。内置模板使用英文，如 `Product Manager` |
| `title` | 必填 | 字符串 | 岗位英文头衔（如 `Product Manager`） |
| `version` | 必填 | 版本串（如 `1.0.0`） | 模板版本号 |
| `shareable` | 可选 | 布尔，默认 `true` | 是否允许作为通用岗位定义导出 |
| `isPrimaryContact` | 可选 | 布尔，默认 `false` | 是否为新安装默认主要联系人（无关键词命中时兜底） |
| `roleKind` | 可选 | `"architect"` 或省略 | 为 `"architect"` 时标识系统元角色（如内置「角色架构师」），与普通业务团队名录隔离 |
| `keywords` | 可选 | 字符串数组 `[]` | 用于事项初始派单与立项评分。内置业务角色同时保留中文岗位名作为别名 |
| `responsibilityKeywords` | 可选 | 字符串数组 | 为本地立项评分显式提供职责匹配词。省略时从职责正文推导 |
| `tools` | 可选 | 字符串数组 `[]` | 声明启用工具；`mcp` 分类标记会在装配时过滤；`TeamOrchestrator` 未读取到声明时兜底 `["read", "bash", "edit", "write"]`；通过架构师/快速设计官新建的非研发角色按最小权限默认收缩至只读或无工具 |
| `skills` | 可选 | 字符串数组 `[]` | 使用 Skill 名称或角色包相对引用 `skills/<name>/SKILL.md`。名称优先从角色的个人或组织范围查找，再查平台通用和内置目录 |
| `mcpDependencies` | 可选 | 字符串数组 `[]` | 声明依赖的 MCP 服务名，启动前校验存在对应 `mcp__<name>__*` 工具 |
| `antiJobs` | 可选 | 字符串数组 `[]` | 显式「不做清单 / 边界约束」（One Job + Explicit Anti-Jobs）；每轮通过 `before_agent_start` 与单兵模式上下文注入提醒 |

### 正文结构要求

正文使用以下五个标准二级标题。解析器也接受旧版中文标题。每轮通过 `before_agent_start` 注入最新角色上下文。

- `## Responsibilities and Boundaries`
- `## Skills and Methods`
- `## Tools and Environment`
- `## Collaboration and Communication`
- `## Delivery and Verification`

---

## 5. 编排边界、旁听席与工作台参数

以下规则目前内置在以下源码模块中，作为系统运行边界：

- [team-orchestrator.ts](../../src/orchestrator/team-orchestrator.ts) 与 [team-tool-bridge.ts](../../src/rpc/team-tool-bridge.ts)
- [repositories.ts](../../src/storage/repositories.ts)、[app.ts](../../src/server/app.ts) 与 [preview-manager.ts](../../src/server/preview-manager.ts)

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

- **配置入口**：
  - 可通过 `POST /api/matters`、`POST /api/matters/:id/messages` 或 `PATCH /api/matters/:id` 设置或调整旁听成员数组。
  - 与切换工作区（运行中返回 HTTP 409）不同，**旁听成员可在执行进行中实时调整**，不中断主负责人。
- **权限隔离**：旁听成员运行在独立 `observer` 会话模式下，工具列表自动剔除 `edit`、`write`、`save_space_page` 与 `delegate_to_member`（双端禁权，只读审视）。
- **静默识别**：默认哨兵 `[SILENT]`；同时兼容 `[PASS]`、`[NOOP]`、`暂无异议`、`无需补充`、`无需发言`（均不写入用户频道）。
- **旁听提示与摘要窗口**：
  - 当前轮输入：用户发言最多截取 `2000` 字符，主负责人回复最多截取 `6000` 字符。
  - 首次接入背景摘要（`buildObserverContextDigest`）：
    - 保留事项标题/最新摘要/已归档成果标题，并从最新往前取最多 **`16` 条** `user` 频道历史消息（单条最多 `400` 字符）。
    - 整体控制在 **`6000` 字符**总预算内（并至少为消息摘录保留 `1200` 字符）。
    - 后续轮次仅按 `messageCursor` 增量传入新增交流，不回放 `internal_collab` 或 `notice` 全量日志。

### 私有记忆与 RSI 经验提炼边界

- **状态流转与范围隔离**：
  - `member_memories.status` 区分四类状态：`candidate`（待核验，不视为定稿）、`verified`（已验证）、`superseded`（已被新规替代并退出注入）与 `rejected`（人工忽略）。
  - `role_general` 强制保持 `workspaceId = null` 跨项目注入；`company_private` 与 `project_private` 仅在匹配当前范围时注入，且永不导出至 `roles/*.md`。
- **执行期经验提案**：
  - 非旁听成员可调用 `propose_experience`，单条 `content` 与 `rationale` 各自上限 `1200` 字符（暂存后仅在整轮无中止正常完成时写入 `"candidate"`）。
  - 旁听成员固定注入 `PA_CAN_EXPERIENCE="false"` 禁止提案。
- **只读 AI 复盘提炼**（`TeamOrchestrator.distillExperiences`）：
  - 以 `noSession: true` 及 `--no-extensions --no-skills --no-mcp --tools ""` 启动只读反思 worker，单次默认超时 `120000` ms（2 分钟）。
  - 最多读取前 `8` 条候选并校验范围、成员和去重（可选 `supersedesMemoryId` 仅能指向同成员、同 scope/工作区旧规则，且不能成环）。
- **应用与验收评估幂等计数**（`memory_applications`）：
  - 每轮被注入提示词的经验记录一次 `applied` 与 `applied_count + 1`；当前版本只评价 `deliverable_memory_applications` 中精确关联的注入记录。
  - `memory_feedback_votes` 每成果/经验一票；相同票幂等，改票替换、`neutral` 撤回。卡片手动评价独立累计，旧历史不猜测补关联或重算。

### 工具载荷、日志、SSE 与预览管理限制

- **桥接参数长度限制**（[team-tool-bridge.ts](../../src/rpc/team-tool-bridge.ts)）：
  - `callId` ≤ 256、`memberId` ≤ 256、`task` ≤ 16000、`title` ≤ 200、`changeNote` ≤ 2000、`summary` ≤ 1000（默认通用非空文本 ≤ 64000 字符）。
- **过程记录截断**：`notice` 单条工具事件截取 `16000` 字符；进度面板 `recentLogs` 最多保留最近 `6` 条活动。
- **SSE 心跳**（[app.ts](../../src/server/app.ts)）：`/api/events` 每 `15000` ms 发送一次 `: ping` 保活帧。
- **本地预览管理**（[preview-manager.ts](../../src/server/preview-manager.ts)）：
  - 命令预览默认端口监听超时 `startupTimeoutMs = 5000` ms，内存中最多保留 `200` 行日志，停止时等待 `SIGTERM` 宽限 `1500` ms 后强杀 `SIGKILL`。
  - 未传入 `port` 时自动分配 `127.0.0.1` 临时空闲端口。

---

## 相关文档

- 架构与模块边界：[当前架构与后续计划](../concepts/architecture-and-plan.md)
- 会话隔离、委托与归档机制：[连续上下文与内部角色协作](runtime-collaboration.md)
- 岗位资产维护说明：[roles/README.md](../../roles/README.md)、[skills/README.md](../../skills/README.md)
- 常用构建与检验命令：[scripts/README.md](../../scripts/README.md)
