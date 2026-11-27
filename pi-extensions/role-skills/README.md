# Pi 岗位方法包（`role-skills` / `pa-role-skills`）

## 能力概览

标准 Pi Package（[package.json](package.json) 声明 `"pi": { "skills": ["./skills"] }`），封装 17 个岗位通用与专职方法论 `SKILL.md`，供 **Personal Agent** 与 **原生终端 Pi** 原生发现与按需阅读。每个叶目录的 `SKILL.md` 即方法正文，不另复制同义 README。

| 岗位方向 | 具体方法 |
| --- | --- |
| 通用 | [技术与成果写作规范](skills/deliverable-writing/SKILL.md)、[Skill 设计与编写原则](skills/skill-design/SKILL.md)、[团队协作验收闭环](skills/team-review-loop/SKILL.md) |
| 角色架构师 | [职责、能力组合与验证设计](skills/role-design/SKILL.md) |
| 产品 | [澄清需求](skills/requirement-clarification/SKILL.md)、[范围与优先级](skills/scope-prioritization/SKILL.md)、[验收条件](skills/acceptance-criteria/SKILL.md) |
| 研发 | [仓库核查](skills/repo-analysis/SKILL.md)、[技术设计](skills/architecture-design/SKILL.md)、[工作拆解](skills/task-breakdown/SKILL.md)、[编码执行](skills/coding-execution/SKILL.md) |
| 测试 | [测试计划](skills/test-planning/SKILL.md)、[回归影响](skills/regression-impact-analysis/SKILL.md)、[验收验证](skills/acceptance-verification/SKILL.md) |
| 市场与营销 | [市场研究](skills/market-research/SKILL.md)、[竞品分析](skills/competitor-analysis/SKILL.md)、[发布内容](skills/launch-copy/SKILL.md) |

---

## 插件依赖与推荐搭配

- **代码与外部依赖**：**零代码依赖**，纯标准 Pi Skills 资源包。
- **上游归属**：其中 `deliverable-writing` 适配自 pstack 写作方法（独立命名以免与全局 `pstack` 的 `technical-writing` 冲突遮蔽），许可证声明见 [第三方说明](../../THIRD_PARTY_NOTICES.md#pstack-derived-writing-method)。
- **推荐搭配扩展**：
  - [../skill-catalog/README.md](../skill-catalog/README.md)：提供紧凑分页目录与 `load_available_skill` 按需阅读，尤其配合禁用自动触发的 Skill 时效果最佳；
  - [../roles/README.md](../roles/README.md) + [../delegation/README.md](../delegation/README.md) / [../board/README.md](../board/README.md)：角色卡片中的 `skills` 字段与这里的方法名称一一对应。

---

## 在原生终端 `pi`（Pi Console）中使用

```bash
# 永久安装到当前用户的 Pi 配置（全终端全局可用）
pi install ./pi-extensions/role-skills

# 或单次试用（可与其他便携扩展叠加）
pi -e ./pi-extensions/role-skills \
   -e ./pi-extensions/skill-catalog/index.ts
```

### 在控制台里怎么触发和调用？

- **方式一：模型按需自动读取（推荐）**：直接用自然语言提出对应领域的任务（如「按验收验证方法核查这份改动」或「先澄清需求再拆解范围」），Pi 会根据各 Skill 的 `name` 与 `description` 自动读取对应 `SKILL.md` 正文。
- **方式二：用户显式斜杠触发**：也可以在控制台直接输入 `/skill:<name>`（例如 `/skill:acceptance-verification` 或 `/skill:repo-analysis`）强制指定本回合先按该方法执行。
- 内置 Skill 的 `description` 与正文采用英文（减少提示词语种切换损耗），终端交付与交流语言仍跟随你的实际提问。

---

## 在 Personal Agent（PA）中使用

- **装配入口**：PA 启动岗位与架构师子进程时由 `worker-runner.ts` 自动附加 `--extension pi-extensions/role-skills`（对应 [pa-extensions/skill-catalog](../../pa-extensions/README.md) 组合装配）。
- **多租户叠加原则**：运行期自定义与组织隔离的 Skill（`.data/skills/{global,orgs/<orgId>,users/<userId>}/` 及工作区 `.agents/skills`）由 [capabilities.ts](../../packages/server/src/roles/capabilities.ts) 与 [execution-context.ts](../../packages/server/src/orchestrator/execution/execution-context.ts) 按 ACL 校验后经 `--skill` 额外注入，不会污染本通用基线包。
- **验证**：`npm run check:docs` 检查文档链接；`node --test test/continuity-collaboration.test.ts` 与 `node --test test/role-capabilities.test.ts` 验证方法装载。
