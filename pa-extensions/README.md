# PA 宿主扩展（`pa-extensions/`）

本目录存放 Personal Agent 的宿主侧扩展包（`@pa/ext-*`），借鉴 ThinkRail 的双半边模式，每个扩展严格拆分为互不导入的两半：

- `./server`（`server/index.ts`）：使用 `@pa/extension-api/server` 的 `defineServerExtension`，声明该扩展在 **Pi RPC 子进程** 启动时组合的内置 [pi-extensions/](../pi-extensions/README.md) 入口或原生第三方 Pi 生态包（如 `pi-web-access`），由 [packages/server/src/extensions/registry.ts](../packages/server/src/extensions/registry.ts) 静态汇总。
- `./web`（`web/index.ts`）：使用 `@pa/extension-api/web` 的 `defineWebExtension`，声明前端执行记录与交互展示元数据，由 [apps/web/src/extensions/registry.ts](../apps/web/src/extensions/registry.ts) 静态汇总。

| 扩展 | 组合的 Pi 能力 | 职责 |
| --- | --- | --- |
| `team-extension` | [pi-extensions/team-extension](../pi-extensions/team-extension/README.md) | 团队委托、资料空间读写、经验/技能提案（`propose_skill`）与工作台速查 |
| `human-question` | [pi-extensions/human-question](../pi-extensions/human-question/README.md) | `request_clarification` 人工澄清与决策提问 |
| `skill-catalog` | [pi-extensions/skill-catalog](../pi-extensions/skill-catalog/README.md) + [pi-extensions/role-skills](../pi-extensions/role-skills/README.md) | 可用方法检索、按需读取与内置岗位方法包 |
| `visualize` | [pi-extensions/visualize](../pi-extensions/visualize/README.md) | Mermaid 图表、方案对比与文件预览卡片（注册 `toolRenderers`） |
| `web-access` | 原生第三方 Pi 包 `pi-web-access` | 复用原生 Pi 社区搜索包，由 PA 治理供应商优先级与 `.env` 凭据 |
| `workflow` | PA 宿主专有 `skills/`（不发布为通用 Pi 包） | 薄路由规则 + 按需加载的协作（[pa-team-collaboration](workflow/skills/pa-team-collaboration/SKILL.md)）、空间交付（[pa-space-deliverables](workflow/skills/pa-space-deliverables/SKILL.md)）与外部仓库证据（[pa-external-repo-evidence](workflow/skills/pa-external-repo-evidence/SKILL.md)）SOP |

边界约束：`server/**` 与 `web/**` 严禁互相 import，由 `npm run check:boundaries` 强制门禁校验。
