# PA 宿主扩展（`pa-extensions/`）

本目录存放 Personal Agent 的宿主侧扩展包（`@pa/ext-*`），借鉴 ThinkRail 的双半边模式，每个扩展严格拆分为互不导入的两半：

- `./server`（`server/index.ts`）：使用 `@pa/extension-api/server` 的 `defineServerExtension`，声明该扩展在 **Pi RPC 子进程** 启动时组合的内置 [pi-extensions/](../pi-extensions/README.md) 入口或原生第三方 Pi 生态包（如 `pi-web-access`），由 [packages/server/src/extensions/registry.ts](../packages/server/src/extensions/registry.ts) 静态汇总。
- `./web`（`web/index.ts`）：使用 `@pa/extension-api/web` 的 `defineWebExtension`，声明前端执行记录与交互展示元数据，由 [apps/web/src/extensions/registry.ts](../apps/web/src/extensions/registry.ts) 静态汇总。

| 扩展 | 组合的 Pi 能力 | 职责 |
| --- | --- | --- |
| `worker-runtime` | [pa-extensions/worker-runtime/pi/index.ts](worker-runtime/pi/index.ts) | PA 宿主运行时护栏：目标工作区 `AGENTS.md` 隔离、`<pa_docs>` 双文档指针、成员/轮次上下文注入、能力握手、`session_compact` Skill 与事项锚点延续、外部检索证据标注 |
| `space` | [pa-extensions/space/pi/index.ts](space/pi/index.ts) | `read_space` / `save_space_page` Git 资料空间读写（按运行模式挂载，Web 侧展示文档类型与标题摘要） |
| `delegation` | [pa-extensions/delegation/pi/index.ts](delegation/pi/index.ts) | `delegate_to_member` 团队跨岗委托与独立验收（按权限挂载，Web 侧突出标注 `[独立验收]` 与目标同事） |
| `skill-capture` | [pa-extensions/skill-capture/pi/index.ts](skill-capture/pi/index.ts) | 统一 `propose_skill` 沉淀入口（步骤 2）与 Pi 原生 `tool_call` 脚本信任门禁（步骤 3 `confirm` 经 `DialogBroker` 确认 / 步骤 4 `autonomous` 自主执行） |
| `human-question` | [pi-extensions/human-question](../pi-extensions/human-question/README.md) | `request_clarification` 人工澄清与决策提问 |
| `skill-catalog` | [pi-extensions/skill-catalog](../pi-extensions/skill-catalog/README.md) + [pi-extensions/role-skills](../pi-extensions/role-skills/README.md) | 可用方法检索、按需读取与内置岗位方法包 |
| `visualize` | [pi-extensions/visualize](../pi-extensions/visualize/README.md) | Mermaid 图表、方案对比与文件预览卡片（注册 `toolRenderers`） |
| `next-steps` | [pi-extensions/next-steps](../pi-extensions/next-steps/README.md) | 主责回复结束时生成 2–4 个一键可点下一步建议（输入框上方快捷按钮，Shift+点击可编辑） |
| `web-access` | 原生第三方 Pi 包 `pi-web-access` | 复用原生 Pi 社区搜索包，由 PA 治理供应商优先级与 `.env` 凭据 |
| `workflow` | [pa-extensions/workflow/pi/index.ts](workflow/pi/index.ts) + 宿主专有 `skills/` | `before_agent_start` 薄路由 Hook + 按需加载协作（[pa-team-collaboration](workflow/skills/pa-team-collaboration/SKILL.md)）、空间交付（[pa-space-deliverables](workflow/skills/pa-space-deliverables/SKILL.md)）、信任技能沉淀（[pa-trust-capture](workflow/skills/pa-trust-capture/SKILL.md)）与外部仓库证据（[pa-external-repo-evidence](workflow/skills/pa-external-repo-evidence/SKILL.md)）SOP |
| `self-inspect` | 宿主专有自检 `skills/` + 零依赖只读脚本 | 渐进式自检技能（[pa-self-inspection](self-inspect/skills/pa-self-inspection/SKILL.md)）、架构导航（[architecture-map.md](self-inspect/skills/pa-self-inspection/reference/architecture-map.md)）、运行排障（[runtime-troubleshooting.md](self-inspect/skills/pa-self-inspection/reference/runtime-troubleshooting.md)）与离线会话洞察 CLI（`scripts/session-insights.mjs`） |

边界约束：`server/**` 与 `web/**` 严禁互相 import，由 `npm run check:boundaries` 强制门禁校验。
