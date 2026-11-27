# Pi 便携扩展体系（`pi-extensions/`）

本目录存放可直接在 **原生终端 `pi`（Pi Console）** 与 **Personal Agent（PA）宿主** 两套环境复用的便携扩展包与资源包。所有扩展严格保持零 `@pa/*`、零 `packages/*` 与零 `apps/*` 依赖（由 `npm run check:boundaries` 门禁守护），践行「**喂养而不自造，顺着 Pi 纹理生长**」。

安装与加载细节分别见：[原生终端推荐组合](#原生终端-pi-console-推荐组合)、[PA 宿主装配集成](../packages/server/src/extensions/README.md) 与 [运行参数参考](../docs/reference/configuration.md#cli-启动与能力装配)。

---

## 扩展总览与依赖关系矩阵

| 扩展（Pi 包名） | 核心能力与工具 | 内部代码依赖 | 运行时依赖与推荐搭配 | PA 宿主加载范围 | 原生 `pi` 独立用法 |
| --- | --- | --- | --- | --- | --- |
| [board](board/README.md)（`pa-board`） | Board 异步协作：`spawn_board_agent`、`post_to_board`、`read_board_post` 与 `/board` | [team-bridge-client.ts](shared/team-bridge-client.ts)、[local-rpc-worker.ts](shared/local-rpc-worker.ts)、可选 [roles/loader.ts](roles/loader.ts) | 独立模式需本机 `pi` CLI；推荐搭配 `roles` + `role-skills` + `human-question` | Board 模式显式挂载（双后端路由 PA Bridge） | `pi -e ./pi-extensions/board/index.ts` |
| [delegation](delegation/README.md)（`pa-delegation`） | Lead 跨岗同步委托：`delegate_to_member`（支持只读独立验收）与 `/delegate` | [team-bridge-client.ts](shared/team-bridge-client.ts)、[local-rpc-worker.ts](shared/local-rpc-worker.ts)、可选 [roles/loader.ts](roles/loader.ts) | 独立模式需本机 `pi` CLI；推荐搭配 `roles` + `role-skills` + `human-question` | 具备委托权限的 Lead 岗位挂载（`PA_TEAM_BRIDGE_URL`） | `pi -e ./pi-extensions/delegation/index.ts` |
| [roles](roles/README.md)（`pa-roles`） | 4 个默认业务岗位定义（单一事实源）与 `list_roles` / `/roles` | 零外部依赖（仅 Node 标准库） | 常与 `delegation`、`board`、`role-skills` 搭配 | PA 宿主通过 [template-loader.ts](../packages/server/src/roles/template-loader.ts) 合并其资产，工具入口自动静默让位于组织花名册 | `pi -e ./pi-extensions/roles/index.ts` |
| [role-skills](role-skills/README.md)（`pa-role-skills`） | 内置 17 个岗位方法论 `SKILL.md` | 零代码与外部依赖（纯 Skills 包） | 配合 `skill-catalog` 索引检索，配合 `roles` 匹配岗位方法 | 所有岗位与建筑师进程原生挂载 | `pi install ./pi-extensions/role-skills` 或 `pi -e ./pi-extensions/role-skills` |
| [skill-catalog](skill-catalog/README.md) | 额外/手动 Skill 索引注入、`list_available_skills`、`load_available_skill` | 零外部依赖（仅 Node 标准库） | 依赖 Pi 运行时 `before_agent_start` 与 Skill 发现（如 `role-skills`、`pstack`） | 岗位主程与 `Role Architect` 挂载 | `pi -e ./pi-extensions/skill-catalog/index.ts` |
| [human-question](human-question/README.md) | `request_clarification`（单选/文本澄清） | [team-bridge-client.ts](shared/team-bridge-client.ts) | 独立模式依赖 `ctx.ui.select` / `ctx.ui.input`；PA 下需 Bridge 与 `PA_HUMAN_QUESTION_ENABLED=true` | 正式执行的 Lead 与受托协作者挂载（PA 内由桥接转成「待你决定」卡片） | `pi -e ./pi-extensions/human-question/index.ts` |
| [visualize](visualize/README.md)（`pa-visualize`） | `visualize` 工具（Mermaid 图表 / 方案对比 / 文件预览） | 零代码与外部依赖（纯 ESM） | 独立 Pi 文本化呈现；PA 网页端搭配 [pa-extensions/visualize](../pa-extensions/README.md) Web 半边渲染交互卡片 | 非 `Role Architect` 岗位显式挂载 | `pi -e ./pi-extensions/visualize/index.ts` |
| [next-steps](next-steps/README.md)（`pa-next-steps`） | `suggest_next_steps`（回复末尾 2–4 个下一步建议） | 零代码与外部依赖（纯 ESM） | 独立 Pi 返回文本建议；PA 网页端搭配 [pa-extensions/next-steps](../pa-extensions/README.md) 渲染输入框上方快捷筹码 | Lead 主责岗位显式挂载 | `pi -e ./pi-extensions/next-steps/index.ts` |

> 说明：[shared/](shared/team-bridge-client.ts)（[team-bridge-client.ts](shared/team-bridge-client.ts) 与 [local-rpc-worker.ts](shared/local-rpc-worker.ts)）为供 `pi-extensions/*` 与 `pa-extensions/*/pi` 复用的内部共享模块，不是可直接通过 `--extension` 加载的 Pi 扩展。PA 宿主专有的桥接扩展（`worker-runtime`、`space`、`skill-capture`、`workflow` 等）收敛在 [pa-extensions/](../pa-extensions/README.md)。

---

## 原生终端 Pi Console 推荐组合

在终端 `pi` 中使用这些扩展时，用户无需在对话里刻意点名内部工具名，扩展支持两种直观触发方式：

- **方式 A：斜杠命令直接触发（带参数即可启动任务或查状态）**：
  - `/board <目标>`（[board](board/README.md)）：把 `<目标>` 交给总控发起多 Agent 协作；不带参数或 `/board status` / `posts` / `new <id>` 为本地查板与切板（不调模型）；
  - `/delegate <自然语言任务>`（[delegation](delegation/README.md)）：自然语言发起跨岗委托（无需指定精确 `memberId` 或 `--verify` 参数，由模型根据喂养的角色清单自行决定委托人选与只读验收阶段）；
  - `/roles`（[roles](roles/README.md)）：本地打印可用岗位列表；
  - `/skill:<name>`（[role-skills](role-skills/README.md)）：显式加载某个方法。
- **方式 B：普通自然语言对话（模型通过扩展内置的 `promptGuidelines` 自主调用）**：
  - 例如直接说「把这个模块拆分实现，并安排独立测试角色复核」会触发 Board 团队协作；「让 QA 角色只读复核这份改动」会触发跨岗委托；「给我对比两个方案」「如果有歧义先让我选一下」「最后给下一步建议」会分别触发可视化、人工澄清与下一步建议。

按当前任务复杂度在任意项目根目录从仓库路径（或 `pi install` 永久安装后）按需组合，无需启动 PA Server：

```bash
# 1. 单兵增强（工具增强 + 岗位方法 + 按需检索 + 可视化卡片 + 下一步建议）
pi -e ./pi-extensions/role-skills \
   -e ./pi-extensions/skill-catalog/index.ts \
   -e ./pi-extensions/human-question/index.ts \
   -e ./pi-extensions/visualize/index.ts \
   -e ./pi-extensions/next-steps/index.ts

# 2. Lead 同步跨岗委托（单一主责 + 按角色定义临时请专家 / 独立只读验收）
pi -e ./pi-extensions/delegation/index.ts \
   -e ./pi-extensions/roles/index.ts \
   -e ./pi-extensions/role-skills \
   -e ./pi-extensions/human-question/index.ts

# 3. Board 多 Agent 异步协作（Coordinator + Builder / Verifier + 异构模型验证）
pi -e ./pi-extensions/board/index.ts \
   -e ./pi-extensions/roles/index.ts \
   -e ./pi-extensions/role-skills \
   -e ./pi-extensions/human-question/index.ts
```

---

## Personal Agent（PA）宿主内部机制

1. **宿主构建清单**：PA 通过 [build-support.ts](../packages/server/src/build-support.ts) 定位各便携扩展入口，并由 [packages/server/src/extensions/registry.ts](../packages/server/src/extensions/registry.ts) 与 `worker-runner.ts` 按岗位角色、协作模式（`solo` / `lead` / `board`）装配对应的 `--extension`、`--tools` 与环境变量。
2. **双后端无缝切换**：`board`、`delegation`、`human-question` 等扩展通过检测 `PA_TEAM_BRIDGE_URL` 自动识别宿主环境——在 PA 中切向环回 HTTP Bridge（受多租户 ACL、SQLite 拆表、SSE 推流、Trust Gate 与 CoE 审计监管）；离开 PA 则自动切换为本机原生模式。
3. **扩展间依赖约定**：
   - **代码依赖**：只能导入标准库或 `pi-extensions/` 内部模块，严禁逆向依赖 `@pa/*`、`packages/*`、`apps/*` 或 `pa-extensions/*`。
   - **运行时能力核查**：在 PA 宿主启动子进程时，由 [worker-runtime](../pa-extensions/worker-runtime/pi/index.ts) 核对 `PA_REQUIRED_TOOLS` 与实际注册工具清单；在原生终端使用时，缺失可选搭配扩展（如无 `roles` 时的 `delegation`）应优雅降级而非报错。
