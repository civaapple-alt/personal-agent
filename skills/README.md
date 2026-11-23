# Pi 岗位 Skills

这里是供本项目执行器加载的 Pi Skills，不是自动学习结果。每个叶目录的 `SKILL.md` 是方法正文；按本次任务需要阅读，不为叶目录另复制同义 README。

本地 `technical-writing` 是 pstack 写作方法的项目适配版，额外约定成果字段与阅读结构；上游 MIT 归属见[第三方说明](../THIRD_PARTY_NOTICES.md#pstack-derived-writing-method)。可选完整 pstack 方法包由运维者另行配置，不随本仓库复制或自动安装。

| 岗位方向 | 具体方法 |
| --- | --- |
| 通用 | [技术与成果写作规范](technical-writing/SKILL.md) |
| 角色架构师 | [职责、能力组合与验证设计](role-design/SKILL.md) |
| 产品 | [澄清需求](requirement-clarification/SKILL.md)、[范围与优先级](scope-prioritization/SKILL.md)、[验收条件](acceptance-criteria/SKILL.md) |
| 研发 | [仓库核查](repo-analysis/SKILL.md)、[技术设计](architecture-design/SKILL.md)、[工作拆解](task-breakdown/SKILL.md)、[编码执行](coding-execution/SKILL.md) |
| 测试 | [测试计划](test-planning/SKILL.md)、[回归影响](regression-impact-analysis/SKILL.md)、[验收验证](acceptance-verification/SKILL.md) |
| 市场与营销 | [市场研究](market-research/SKILL.md)、[竞品分析](competitor-analysis/SKILL.md)、[发布内容](launch-copy/SKILL.md) |

- [角色资产](../roles/README.md)的 `skills` 可用方法名称或角色包内的相对引用 `skills/<name>/SKILL.md`。名称按角色作用域查找，依次回退到平台通用与内置目录。宿主校验实际文件路径位于允许的目录，再用 `--skill` 装载。引用绝对路径、越界或文件缺失时返回错误。见[名称解析](../src/roles/capabilities.ts)与[执行装配](../src/orchestrator/execution-context.ts)。

模型根据可用 Skill 的 `name` 和 `description` 判断是否需要读取正文。内置 Skill 和 [Pi Skill 目录](../pi-extensions/skill-catalog/README.md)沿用这两个发现字段。Role 的 `keywords` 用于[事项派单和立项](../roles/README.md)。

内置 Skill 的 `description` 和正文使用英文。描述写明适用的任务情境，正文写明动作和完成标准。用户交流与交付语言由本轮请求决定。编辑时避免重复运行规则或写入公司、项目事实。新增方法须同时检查引用角色和真实依赖。

- 文档链接检查在仓库根运行 `npm run check:docs`；加载路径或声明变化可用 `node --test test/continuity-collaboration.test.ts` 验证。
- 真实模型验证的选择与成本边界见 [demo](../src/demo/README.md)。
