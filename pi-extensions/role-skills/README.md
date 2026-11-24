# Pi 岗位方法包（`role-skills`）

本目录是符合 Pi 包规范的内置岗位方法 Skills 包（`pa-role-skills`），同时供 Personal Agent 运行时与原生终端 Pi 加载。每个叶目录的 `SKILL.md` 是方法正文；按任务需要阅读，不为叶目录另复制同义 README。

## 在原生终端 Pi 中直接使用

```bash
# 永久安装到当前用户的 Pi 配置
pi install ./pi-extensions/role-skills

# 或单次试用
pi -e ./pi-extensions/role-skills
```

## 内置方法一览

本地 `deliverable-writing` 是 pstack 写作方法的项目适配版（采用独立名称以避免与全局 `pstack` 的 `technical-writing` 撞名遮蔽），额外约定成果字段与阅读结构；上游 MIT 归属见[第三方说明](../../THIRD_PARTY_NOTICES.md#pstack-derived-writing-method)。可选完整 pstack 方法包由运维者另行通过 `pi install` 配置，不随本仓库复制或自动安装。

| 岗位方向 | 具体方法 |
| --- | --- |
| 通用 | [技术与成果写作规范](skills/deliverable-writing/SKILL.md) |
| 角色架构师 | [职责、能力组合与验证设计](skills/role-design/SKILL.md) |
| 产品 | [澄清需求](skills/requirement-clarification/SKILL.md)、[范围与优先级](skills/scope-prioritization/SKILL.md)、[验收条件](skills/acceptance-criteria/SKILL.md) |
| 研发 | [仓库核查](skills/repo-analysis/SKILL.md)、[技术设计](skills/architecture-design/SKILL.md)、[工作拆解](skills/task-breakdown/SKILL.md)、[编码执行](skills/coding-execution/SKILL.md) |
| 测试 | [测试计划](skills/test-planning/SKILL.md)、[回归影响](skills/regression-impact-analysis/SKILL.md)、[验收验证](skills/acceptance-verification/SKILL.md) |
| 市场与营销 | [市场研究](skills/market-research/SKILL.md)、[竞品分析](skills/competitor-analysis/SKILL.md)、[发布内容](skills/launch-copy/SKILL.md) |

## 与 PA 角色及多租户 Skill 的关系

- PA 启动岗位时会原生挂载 `pi-extensions/role-skills` 包，使内置岗位方法统一进入 Pi 的资源发现体系；同时[角色资产](../../roles/README.md)的 `skills` 字段继续支持方法名称或角色包内的相对引用 `skills/<name>/SKILL.md`。
- 运行期自定义的多租户 Skill（`.data/skills/{global,orgs/<orgId>,users/<userId>}/` 与角色包私有 `skills/`）仍由宿主按用户与组织 ACL 校验后经 `--skill` 显式传入，不会混入全局包。见[名称解析](../../packages/server/src/roles/capabilities.ts)与[执行装配](../../packages/server/src/orchestrator/execution-context.ts)。
- 模型根据可用 Skill 的 `name` 和 `description` 判断是否需要读取正文，内置 Skill 与 [Pi Skill 目录](../skill-catalog/README.md)沿用这两个发现字段。
- 内置 Skill 的 `description` 和正文使用英文；用户交流与交付语言由本轮请求决定。

## 验证

- 文档链接检查在仓库根运行 `npm run check:docs`；加载路径或声明变化可用 `node --test test/continuity-collaboration.test.ts` 验证。
- 真实模型验证的选择与成本边界见 [demo](../../packages/server/src/demo/README.md)。
