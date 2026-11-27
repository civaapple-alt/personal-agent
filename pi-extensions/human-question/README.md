# Human Question（人工澄清与决策提问）

## 能力概览

注册 `request_clarification` 工具，让模型在信息缺口会改变方案边界、技术路线或业务取舍时向用户或上游委托方请求澄清：提供 `options`（2–4 个互斥选项）时呈现单选决策，省略 `options` 时接收自由文本答复。

---

## 插件依赖与推荐搭配

- **内部代码依赖**：[../shared/team-bridge-client.ts](../shared/team-bridge-client.ts)（仅在 PA 宿主环境下通过 HTTP Bridge 回传澄清请求）。
- **运行时环境依赖**：
  - **独立终端 Pi**：依赖 Pi 原生会话上下文 `ctx.hasUI` 与 `ctx.ui.select` / `ctx.ui.input`（无交互界面环境下优雅降级返回 `status: "unavailable"`，提示模型改为直接在对话中提问）。
  - **PA 宿主模式**：依赖 `PA_TEAM_BRIDGE_URL`、`PA_TEAM_BRIDGE_TOKEN` 以及 `PA_HUMAN_QUESTION_ENABLED=true` 门控开关（在 PA 内未显式启用时主动跳过工具注册）。
- **推荐搭配扩展**：常与 [../delegation/README.md](../delegation/README.md) 或 [../board/README.md](../board/README.md) 配合，在独立团队或单兵流中提供规范的人工决策节点。

---

## 在原生终端 `pi`（Pi Console）中使用

```bash
pi -e ./pi-extensions/human-question/index.ts
```

### 在控制台里怎么触发和调用？

本扩展**无斜杠命令**，用户无需点名工具名称，只要任务存在需要人类拍板的岔路口即会自动生效：

- **自然语言场景**：例如告诉助手「如果遇到两难的技术路线或需要我做取舍再继续，先让我做个选择」（或模型自身识别到高风险/多方案歧义时也会主动发起澄清）。
- 在终端交互模式下，Pi Console 会原地弹出单选列表（带 `options` 时走 `ctx.ui.select`）或文本输入框（无 `options` 时走 `ctx.ui.input`），你选好或回车答复后，结果立刻回到当前对话回合继续执行；非交互 `--print` 等环境则会明确返回 `status: "unavailable"` 并回退为普通文字提问。详见 [Pi 对话接口](https://docs.pi.dev/latest/extensions#dialogs)。

---

## 在 Personal Agent（PA）中使用

- **装配入口**：[pa-extensions/human-question/server/index.ts](../../pa-extensions/human-question/server/index.ts) 加载本文件并按运行模式设置 `PA_HUMAN_QUESTION_ENABLED`（讨论/受控静态场景按规则关闭，正式业务执行开启）。
- **双向路由**：
  - **主责（Lead）调用**：写入持久化的 `human_decision` 消息，Web 工作台在输入框上方弹出「待你决定」决策卡片（`FloatingClarificationDock`），用户拍板后将答复回写会话；
  - **受托协作者（Delegation 子进程）调用**：优先把澄清请求交回直接委托者（Lead）处理，避免底层专职绕过总负责人直接打扰用户。详情见 [PA 扩展集成](../../packages/server/src/extensions/README.md#human-question)。
- **注意事项**：`request_clarification` 仅用于收集信息或业务拍板，**不授予**超越静态权限或脚本信任策略的新增授权。
