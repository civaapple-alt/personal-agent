# Pi 岗位 Skills

这里是供本项目执行器加载的 Pi Skills，不是自动学习结果。每个叶目录的 `SKILL.md` 是方法正文；按本次任务需要阅读，不为叶目录另复制同义 README。

| 岗位方向 | 具体方法 |
| --- | --- |
| 产品 | [澄清需求](requirement-clarification/SKILL.md)、[范围与优先级](scope-prioritization/SKILL.md)、[验收条件](acceptance-criteria/SKILL.md) |
| 研发 | [仓库核查](repo-analysis/SKILL.md)、[技术设计](architecture-design/SKILL.md)、[工作拆解](task-breakdown/SKILL.md)、[编码执行](coding-execution/SKILL.md) |
| 测试 | [测试计划](test-planning/SKILL.md)、[回归影响](regression-impact-analysis/SKILL.md)、[验收验证](acceptance-verification/SKILL.md) |
| 市场与营销 | [市场研究](market-research/SKILL.md)、[竞品分析](competitor-analysis/SKILL.md)、[发布内容](launch-copy/SKILL.md) |

[角色资产](../roles/README.md)的 `skills` 名称解析到本层对应的 `SKILL.md`；绝对路径、相对角色文件的路径等解析细节由 [execution-context.ts](../src/orchestrator/execution-context.ts)维护。Worker 用显式 `--skill` 装载，文件缺失会报错，不依赖目录 README 被模型自动发现。

编辑时让方法可执行且职责明确，避免在多个文件重复运行规则或写入公司/项目事实。新增方法须同时检查引用角色和真实依赖；一个 Skill 文件不能创造尚未提供的工具，也不能证明岗位能力或完整 RSI 已实现。

文档链接检查在仓库根运行 `npm run check:docs`；加载路径或声明变化可用 `node --test test/continuity-collaboration.test.ts` 验证。真实模型验证的选择与成本边界见 [demo](../src/demo/README.md)。
