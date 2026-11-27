# 未来版本提案与演进清单（0.9.x 及以后）

本文档用于在 **`0.8.x LTS`** 使用与反馈收集阶段，统一承接「**不在 `0.8.x` 做破坏性改动、归档至未来版本推进**」的架构重构、产品能力与体验提案。

当前 `0.8.x` 基线冻结契约见 [0.8.x LTS 候选基线说明](../releases/v0.8-lts-baseline.md)；已落地架构见 [当前架构与后续计划](architecture-and-plan.md)。

---

## 1. 版本分流准则（`0.8.x LTS` vs `0.9.x` vs `1.0+`）

收到用户反馈、实机复盘或架构评审意见后，按以下规则分流：

| 目标轨道 | 准入标准 | 典型例子 |
| --- | --- | --- |
| **`0.8.x` 补丁版（立即修）** | 影响真实可用性、安全性、数据/权限隔离、回归缺陷，或**零破坏性**的小范围体验打磨与文档修正（不改 SQLite schema、不改存量 wire 格式、不大面积重构核心模块） | 安全漏洞、权限/ACL 越权或 403 噪音、Pi 原生资源发现与 `trust.json` 边界、消息复制/长命令展示、文档路径修正 |
| **`0.9.x` 演进版（结构性收敛）** | 收益明确但改动面较大、需要跨多文件重构或引入新交互/新基线，放在 LTS 之外集中推进更稳妥 | `matter_messages` 拆表与冷热分离、剩余老领域 DTO 全量迁入 `@pa/contracts`、≥1,000 行热点文件拆分、并发与内存基准量化、多端口 Cookie 隔离 |
| **`1.0+` 远期探索（新运行时边界）** | 引入新基础设施依赖或改变部署/信任前提，需独立立项设计 | OS 级执行沙箱/容器隔离、跨重启长期无人值守调度、公开角色/Skill 市场与第三方动态插件加载 |

---

## 2. `0.9.x` 候选提案

### `0.9.0` 整体推进顺序

为避免底座重构与上层拆分互相返工，建议按以下四阶段推进 `0.9.0`：

| 推进阶段 | 对应提案 | 目标与前置依赖说明 |
| --- | --- | --- |
| **阶段 1：底座定型** | `P-0906`（M1/M2/M3/M4/M5 已完成）、`P-0901`（已完成） | 已完成 `matter_events` / `matter_board_posts` / `matter_board_members` 拆表、`0.8.x` 无损回填迁移、懒加载 API（M1）、`@pa/contracts` 全量收口（`P-0901`）、Board 动态组队与 `@mention`/`@monitor` 异步编排（M2）、3 层看板 UI / HITL 控制 / `team-health` CoE RSI 证据闭环与 `demo:board`（M3）、共享 SSE 收口 / 多轮退场去噪 / Coordinator 防退场保护 / SVG `@mention` 关系图（M4），以及统一业务主链路、立项面板模式分流、单事项 `Lead ↔ Board` 双向无缝交接与 `spawn_board_agent` 模型覆盖（M5） |
| **阶段 2：热点解耦** | `P-0902`（已完成） | 基于稳定后的仓储接口与契约，按生命周期拆分 `worker-runner.ts`、`space-repo.ts`、`App.tsx`、`SpacePages.tsx` 与 `deliverables.css`，并新增 `npm run check:sizes` 行数门禁 |
| **阶段 3：体验增强** | `P-0904`、`P-0905` | 落地多端口 Cookie 隔离（`P-0904`），并基于 `P-0906` 的事件分页与委托摘要/懒加载推进长对话与工具事件交互打磨（`P-0905`） |
| **阶段 4：量化验收** | `P-0903` | 在 0.9.0 架构与存储模型收敛后，运行多并发 Pi RPC 基准测试并输出可复现的内存/冷启动/租约竞争基线（`P-0903`） |

### P-0901：剩余老领域 DTO 全量迁入 `@pa/contracts`（优先级：P1）

- **来源**：0.8.x 架构核验与契约审计
- **背景**：`0.8.x` 已完成 10 个核心/新增契约模块（含 `Matter`、`MatterMessage` 与 SSE `/api/events` 事件映射）的单一事实源收口，但 `apps/web/src/api/` 中仍有数十个历史领域接口（组织、成员、工作区、资料空间文档、运行态概览等）在服务端与前端双写，存在字段可选性漂移风险。
- **方案要点**：
  - 按域分批迁入 `packages/contracts/src/`（`organization.ts`、`workspace.ts`、`team.ts`、`space.ts`、`runtime.ts`），服务端 `storage/types.ts` 与前端 `api/*.ts` 统一 re-export；
  - 在关键 HTTP 入参/出参边界补充轻量运行时校验，不引入重型 schema 框架。
- **验收标准**：`apps/web/src/api/` 中不再重复定义与服务端 `storage/types.ts` 同构的核心领域 DTO，`npm run check` 全通过。

### P-0902：核心热点大文件按生命周期拆分与规模软门禁（优先级：P1 · 已完成）

- **来源**：0.8.x 架构核验
- **落地情况**：已按生命周期与领域边界完成全部 5 个 `P-0902` 热点文件及其余 5 个 0.9.0 超千行文件拆分，全仓 350+ 源码/样式文件均 `<1,000` 行（0 豁免），并已将 `npm run check:sizes`（[check-file-sizes.mjs](../../scripts/check-file-sizes.mjs)）纳入 `npm run check`：
  - [worker-runner.ts](../../packages/server/src/orchestrator/execution/worker-runner.ts)（1,486 → 744 行，拆出 `worker-setup.ts`、`worker-tool-handler.ts`、`worker-telemetry.ts`）
  - [space-repo.ts](../../packages/server/src/storage/repos/space-repo.ts)（1,040 → 858 行，拆出 `space-types.ts`）
  - [board-repo.ts](../../packages/server/src/storage/repos/board-repo.ts)（1,010 → 703 行，拆出 `board-types.ts`）
  - [App.tsx](../../apps/web/src/App.tsx)（1,049 → 805 行，拆出 `AppStageRouter.tsx`）
  - [SpacePages.tsx](../../apps/web/src/views/SpacePages.tsx)（1,002 → 697 行，拆出 `SpaceDocumentEditorForm.tsx`、`SpaceDocumentDetailPane.tsx`）
  - [MatterBoardPane.tsx](../../apps/web/src/components/chat/MatterBoardPane.tsx)（1,075 → 592 行，拆出 `BoardMembersTab.tsx`、`BoardPostsTab.tsx`）
  - 样式表拆分：[deliverables.css](../../apps/web/src/styles/deliverables.css)（→ `spaces.css` / `workspaces.css`）、[board.css](../../apps/web/src/styles/board.css)（→ `board-feed.css`）、[chat-cards.css](../../apps/web/src/styles/chat-cards.css)（→ `chat-docks.css`）、[shell.css](../../apps/web/src/styles/shell.css)（→ `shell-nav.css`）

### P-0903：多并发 Pi RPC 进程模型基准测试与天花板量化（优先级：P2）

- **来源**：0.8.x 架构核验
- **背景**：当前每轮每成员独立拉起一个 `pi --mode rpc` 子进程与一个 per-turn loopback HTTP bridge，隔离清晰，但缺少面向团队部署的冷启动耗时、内存占用与并发上限实测数字。
- **方案要点**：
  - 新增可复跑的离线/真机基准脚本，采集 1 / 3 / 5 / 10 并发下的 RSS 内存峰值、冷启动延迟与 SQLite 租约竞争表现；
  - 将实测结果与推荐硬件配置写入 [架构说明](architecture-and-plan.md) 与 [团队部署指南](../guides/team-administration.md)。
- **验收标准**：文档中「个人或可信小团队」的并发建议具备可复现的实测数据支撑。

### P-0904：本机多端口实例 Cookie 隔离与本地开发体验增强（优先级：P2）

- **来源**：0.8.x 实机试用反馈
- **背景**：浏览器 Cookie 在 `127.0.0.1` 上跨端口共享，导致同时使用 `npm run start:team:sandbox`（`4399`）与个人版 `npm run start:web`（`4310`）时，旧 `pa_session` Cookie 会触发个人版先停在登录页（需手动点击「返回本机免密所有者视图」）。
- **方案要点**：
  - 评估按服务实例/沙盒模式区分 Cookie 名称（如沙盒使用独立 Cookie 名或通过环境变量 `PA_SESSION_COOKIE_NAME` 配置），确保本地多实例并行调试互不串号；
  - 保持生产同源单实例的向后兼容，不破坏已有登录会话。
- **验收标准**：在同一浏览器交替打开 `127.0.0.1:4399`（团队沙盒）与 `127.0.0.1:4310`（个人工作台）互不影响会话状态。

### P-0905：工作台细节与高频交互持续打磨（优先级：P2）

- **来源**：0.8.x 日常试用反馈池（持续追加）
- **候选方向**：
  - 长对话与多工具执行记录的筛选、搜索与快速折叠；
  - 窄屏/分屏下的顶栏、侧栏与资料空间双栏自适应优化；
  - 更多工作区级 Pi 原生状态可视化（如已加载的 `.pi/` 扩展、`.agents/skills` 来源标注）。

### P-0906：`matter_messages` 拆表与冷热分离（优先级：P1）

- **来源**：0.8.x 架构与库表评审
- **背景**：当前 `matter_messages` 作为单表承担了 `user` 正式对话、`internal_collab` 内部委托与大篇幅回报、高频 `notice` 工具事件摘要，以及 `metadata_json` 内的 `ai_request` / `humanDecision` 等交互状态机，存在冷热数据混放、长事项首屏读放大、委托方向与父子关系依赖前端内存投影、以及 `json_extract` 状态机耦合等问题（当前通过 [SQLite 库表设计参考](../reference/database-schema.md) 与 `idx_matter_messages_matter` 索引做基础隔离，但 `0.8.x` LTS 基线冻结了 `0x50413730` 结构）。
- **方案要点**：
  - **拆分高频过程日志（`notice`）**：将工具事件与巡检提示独立至 `matter_events` 表（或按事项落盘 JSONL），主事项详情接口默认不返回全量事件，过程面板按需分页拉取；
  - **结构化拆分内部委托（`internal_collab`）**：独立为 `matter_delegations` 等结构化表，显式建模 `from_member_id`、`to_member_id`、`parent_id`、`delegation_number`、`status` 与独立验收字段，长篇委托/回报正文支持摘要与按需懒加载；
  - **收口状态机与升级兼容**：评估将需要原子流转的 `ai_request` / `human_decisions` 从 `metadata_json` 剥离为显式列或独立表；明确 `0.8.x`（`0x50413730`）向 `0.9.0` 的幂等迁移脚本与回滚校验；
  - **同步更新库表文档**：落地时按 [SQLite 库表设计参考](../reference/database-schema.md#6-维护流程与变更记录) 同步更新 ER 图、字段定义、索引清单与变更记录。
- **完整设计草案**：见 [0.9.0 存储拆表与事项公告板协作设计草案](v0.9-board-and-storage-design.md)（合入 `matter_events` / `matter_board_posts` / `matter_board_members` 拆表、`Coordinator` + 定向 `@mention` 异步唤醒、`@monitor` 停滞检测及 Human-in-the-Loop 三层可观测设计）。
- **验收标准**：`matter_messages` 仅保留核心用户对话与必要消息引用；事项详情首屏加载不再携带海量过程事件与全量内部委托正文；存量 `0.8.x` 数据库可无损迁移至 `0.9.0` 并通过全量离线回归及 `demo:team` / `demo:mention-verify`。

### P-0907：便携 Pi 协作扩展家族（`board` + `delegation` + `roles`）（优先级：P1）

- **来源**：0.9.0 M5 架构复盘（依据「喂养而不自造 / Influence by feeding, never by assembling」）
- **背景**：`role-skills`、`skill-catalog`、`human-question`、`visualize` 与 `next-steps` 已可在原生终端 `pi` 独立使用，而 Lead 委托与 Board 公告板异步协同此前仍强依赖 PA Server 桥接扩展，导致原生 `pi` console 脱离宿主后无法直接复用同等的多 Agent 协同能力。
- **方案要点**：
  - 将团队工具拆分为三个职责单一的便携扩展包，通过 **双后端适配器**（有 `PA_TEAM_BRIDGE_URL` 走 PA 宿主桥接，否则走本地轻量存储与 `pi --mode rpc` 子进程）统一终端原生 `pi` 与 PA 宿主工具协议：
    - [pi-extensions/board](../../pi-extensions/board/README.md)：Board 异步公告板协作（`spawn_board_agent` / `post_to_board` / `read_board_post` + `/board`）；
    - [pi-extensions/delegation](../../pi-extensions/delegation/README.md)：Lead 同步跨岗委托（`delegate_to_member`，自动加载岗位人格并在 `verification` 时切为只读模式）；
    - [pi-extensions/roles](../../pi-extensions/roles/README.md)：便携打包 4 个默认业务岗位定义（PM / 研发 / QA / 市场），并提供 `list_roles` 与 `/roles` 查询。
  - 保留硬边界不变量（总控专属组队、`verifier` / `delegate_to_member(verification)` 无写/改工具、防自验证、异构 `modelOverride` 透传、增量游标摘要唤醒与 `ctx.ui` 澄清回写）；
  - PA 工作台的 `solo`（`Pi Default`）轨道默认保持零额外工具注入，避免干扰轻量单兵边界。
- **完整设计**：见 [0.9.x 便携 Pi 协作扩展设计](v0.9-portable-pi-collaboration-design.md)（`board` / `delegation` / `roles` 双后端合流、单测与 P3 终端原生 `pi --extension` `cross-verify` 实机联调 `005` 均已验证通过）。

---

## 3. `1.0+` 远期探索提案

### P-1001：操作系统级执行沙箱与容器隔离

- **目标**：为团队多租户模式或不可信业务仓库提供真正的 OS/容器级文件系统与网络隔离，补齐当前「Pi 子进程共享宿主服务账号权限」的安全边界（见 [安全说明](../../SECURITY.md)）。
- **前置约束**：必须继续「顺着 Pi 纹理生长」，优先通过容器/沙箱运行标准 `pi --mode rpc` 子进程，而非在宿主自造工具代理层。

### P-1002：长期无人值守后台调度与跨重启自治

- **目标**：支持定时巡检、长周期跟进事项与宿主重启后的任务队列恢复，替代当前仅限单机内存态的运行占用与 `PID` 租约。
- **前置约束**：明确人机审批边界（高风险操作仍经 `tool_call` 与信任四步门禁把关），避免失控循环消耗模型额度。

### P-1003：公开角色 / Skill 市场与第三方动态扩展生态

- **目标**：在现有 `roles/*.md` 导入导出与 `pi install` 包生态基础上，提供可分享/复用的角色与 Skill 目录、版本依赖解析、权限声明与第三方扩展生命周期钩子（补齐 `@pa/extension-sdk` 从声明式清单到外部插件 SDK 的演进）。

---

## 4. 提案维护约定

1. **先分流再入表**：新问题先按第 1 节判断是否属于 `0.8.x` 补丁范围；确认延后后再分配编号写入本文档。
2. **落地即移除并转入变更日志**：提案在对应版本实现后，从本文档移出（或标注已完成版本）并在 [CHANGELOG.md](../../CHANGELOG.md) 记录实际交付。
3. **保持诚实边界**：本文档只记录**尚未完成**的计划与提案，不得把其中条目在 README 或发布说明中表述为已上线能力。
