# 便携协作板扩展（`pa-board`）

## 能力概览

将 Personal Agent 的 **Board（交付总控 Coordinator + 动态 Builder / Verifier 异步协作板）** 下沉为零宿主耦合的便携 Pi 扩展，基于 `PA_TEAM_BRIDGE_URL` 实现双后端自动路由。暴露工具与命令如下：

| 工具 / 命令 | 作用说明 | 作用域与硬边界 |
| --- | --- | --- |
| `spawn_board_agent` | 创建或更新 `builder` / `verifier` 成员，配置 `ownedScope`、`acceptanceCriteria`、`sourceMemberId` 与 `modelOverride` | **仅 Coordinator**（子 Worker 禁止调用） |
| `post_to_board` | 发布 `assign`/`handoff`/`verify_pass`/`verify_rework`/`clarification` 等板帖并按 `@mention` 异步唤醒目标成员 | 全部 Board 成员可用；强制拦截自验证（`verify_pass`） |
| `read_board_post` | 按 `postNo` 懒加载完整板帖正文与结构化 `artifacts` / `verification` | 全部 Board 成员可用 |
| `/board` | 发起 Board 协作（`/board <目标>`）或管理协作板（`status` / `posts` / `new <id>`） | 仅独立终端 Root 会话可用；管理子命令不触发模型，传 `<目标>` 会作为总控任务发给模型 |
| [board-collaboration](skills/board-collaboration/SKILL.md)（内置工作流 Skill） | 规范 Coordinator 拆解 `ownedScope`、异构 Verifier、返工闭环、防自验证与 `@user` 拍板的 SOP | 通过 [package.json](package.json) `pi.skills` 随包原生安装；终端亦可用 `/skill:board-collaboration` 显式调用 |

详细架构与里程碑见 [0.9.x 便携 Pi 协作扩展设计](../../docs/concepts/v0.9-portable-pi-collaboration-design.md)。

---

## 插件依赖与推荐搭配

- **内部代码依赖**：
  - [../shared/team-bridge-client.ts](../shared/team-bridge-client.ts)：PA 宿主下通过 HTTP Bridge 转发工具调用；
  - [../shared/local-rpc-worker.ts](../shared/local-rpc-worker.ts)：独立终端下通过 `local-rpc-worker.ts` 拉起与控制 `pi --mode rpc` 子进程；
  - [../roles/loader.ts](../roles/loader.ts)（可选解析）：`spawn_board_agent` 传入 `sourceMemberId` 时尝试解析本地或内置岗位人格；未安装或未匹配时优雅忽略，不影响建组。
- **运行时环境要求**：
  - **独立终端模式**：依赖本机可执行 `pi` CLI；成员发 `clarification @user` 时，若终端具备 `ctx.ui.input` 则即时弹窗收集人工答复并唤醒，无交互 UI 时保留 `blocked_human`。
  - **PA 宿主模式**：由宿主注入 `PA_TEAM_BRIDGE_URL`、`PA_TEAM_BRIDGE_TOKEN`、`PA_BOARD_ROLE` 与 `PA_BOARD_AGENT_ID`。
- **推荐搭配扩展**：[../roles/README.md](../roles/README.md)（提供 4 个标准岗位定义）、[../role-skills/README.md](../role-skills/README.md)（补充岗位方法论）；如需 Lead 同步单轮委托，请另行挂载 [../delegation/README.md](../delegation/README.md)。

---

## 在原生终端 `pi`（Pi Console）中使用

### 1. 启动扩展

在任意目标仓库目录直接加载包目录（或 `pi install ./pi-extensions/board` 安装后使用）；传包目录时 `pi` 会自动同时注册扩展与内置工作流 Skill [board-collaboration](skills/board-collaboration/SKILL.md)：

```bash
# 基础用法（纯动态组队）
pi -e ./pi-extensions/board

# 推荐组合（支持 sourceMemberId 继承 4 个默认岗位 + 岗位方法 + 人工澄清）
pi -e ./pi-extensions/board \
   -e ./pi-extensions/roles \
   -e ./pi-extensions/role-skills \
   -e ./pi-extensions/human-question/index.ts
```

### 2. 在控制台里怎么触发和调用？

用户**不需要记住或点名内部工具名**，可以通过以下两种方式进入 Board 多 Agent 协作（工具均已配置 `promptGuidelines`）：

- **方式 A：斜杠命令 `/board`（既可发起任务，也可本地查板）**：
  - **发起一轮 Board 协作**：直接输入 `/board 实现限流器并安排独立测试验收`，扩展会自动把目标包装成总控任务发给 Coordinator 开始动态组队与验收；
  - **本地管理子命令（不触发模型）**：
    - `/board` 或 `/board status`：打印当前 `.pi/boards/<id>/` 中的成员状态、游标位置、`ownedScope` 与最近板帖摘要；
    - `/board posts`：查看最近 15 条板帖摘要；
    - `/board new sprint-2`：切换到全新的隔离协作板目录；
    - 上述本地管理子命令仅读盘切换状态，**不会**调用 `spawn_board_agent`。
- **方式 B：普通自然语言对话（模型自主判断是否启用看板）**：
  - 例如直接提出「这个改动请拆分实现与独立测试验收，各写各的模块并交叉复核」，模型在需要分拆多节点或独立验收时会自动创建 Builder / Verifier 并走公告板闭环。
- **模式边界（已移除 `delegate_to_role`）**：`board` 包内**不包含** `delegate_to_member` 或已废弃的 `delegate_to_role`。若只想做 Lead 单轮同步跨岗委托而不是异步看板协作，请挂载 [../delegation/README.md](../delegation/README.md)（支持 `/delegate`）。

### 3. 本地数据落盘与运行机制

- **本地数据落盘**：协作记录自动存入当前目录 `.pi/boards/<board-id>/`（含原子写入的 `members.json`、追加日志 `posts.jsonl` 与各成员独立会话 `sessions/<agent-id>.jsonl`）。
- **子进程隔离参数**：插件按游标增量摘要唤醒被 `@mention` 成员；对于 `verifier`，通过 `--tools` 白名单仅开放只读工具与板帖工具并叠加 `--exclude-tools edit,write` 双重只读隔离；支持通过 `modelOverride` 为 `verifier` 指定异构验证模型。
- **离线/实机验证**：`node --test test/pi-extension-board.test.ts` 验证双后端路由与完整异步闭环；`cross-verify` 实机验收流程见 [0.9.x 设计文档 P3 阶段](../../docs/concepts/v0.9-portable-pi-collaboration-design.md#4-分阶段演进里程碑)。

---

## 在 Personal Agent（PA）中使用

- **装配入口**：[pa-extensions/board/server/index.ts](../../pa-extensions/board/server/index.ts)（`kind: "builtin-pi"`）与 [build-support.ts](../../packages/server/src/build-support.ts) 直接挂载本目录的 `index.ts`。
- **运行路径**：当用户选择或升级到 `collaboration_mode = "board"` 时，PA [board-runner.ts](../../packages/server/src/orchestrator/execution/board-runner.ts) 为 Coordinator 与动态成员注入 `PA_TEAM_BRIDGE_URL` 及 `PA_BOARD_ROLE`。扩展检测到该变量后自动切到 PA Bridge 分支，仅暴露 `spawn_board_agent`（Coordinator）/ `post_to_board` / `read_board_post`，完全接入 PA 的 SQLite 三表持久化、`/api/events` SSE 推送、Web 3 层看板、`@monitor` 巡检与 `team-health` CoE RSI 闭环。
- **`solo` 模式边界**：PA 工作台的 `solo`（`Pi Default`）轨道默认不注入本扩展，避免无关协作工具增加上下文负担。
