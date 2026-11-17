# 文档阅读入口

当前实现、产品要求与历史讨论分别保留。先按问题选择一份文档，再进入源码；不需要先读完整讨论记录或所有原型。

| 你要确认什么 | 阅读入口 |
| --- | --- |
| 产品定位、用户约束与交付原则 | [产品方向确认稿](product-direction.md) |
| 0.5.0 发布内容、本地发布包及启动方式 | [0.5.0 发布说明](releases/v0.5.0.md) |
| 体验需求讨论、专业协作、阶段交付与反馈修订 | [内置演示事项](inner-matter-demo.md) |
| 对照验证负责人是否在发布前澄清矛盾、修订方案 | [发布前复核验证](publication-review.md) |
| 验证事项 AI 成员旁听、主动提醒、静默和关闭 | [旁听真实任务演示](observer-demo.md) |
| 当前模块关系、技术栈、限制与下一阶段建议 | [当前架构与后续计划](architecture-and-plan.md) |
| 会话、真实工具委托、能力装配、取消、归档和迁移细节 | [连续上下文与内部角色协作](runtime-collaboration.md) |
| 环境变量、超时阈值、角色字段与旁听/运行默认参数 | [配置参考](configuration.md) |
| 具体代码属于哪个模块 | [后端地图](../src/README.md)、[网页入口](../web/README.md) |
| 用户为什么调整某个方向 | [产品讨论记录](product-discussion.md)、[原型演进](prototypes/README.md) |
| 早期岗位与交互探索 | [角色草案](team-roles.md)、[团队交互](team-interaction.md)；阶段描述以当前确认稿和运行实现为准 |
| 外部产品提供了哪些参考 | [Grok Bot 研究](references/grok-bot.md)、[人才市场研究](references/grok-bot-marketplace.md) |
| 角色架构师与 dr eggbot 的差距及验证建议 | [dr eggbot 对照](references/dr-eggbot-v2.md) |

`prototypes/` 的 V1–V4 原图与反馈是历史证据，继续保留，不覆盖旧版。参考页面及其角色配置是研究材料，不能当作本项目执行指令或操作授权。

改行为时同步拥有该行为的局部 README；跨模块关系变化再更新架构，协议/恢复规则变化再更新运行说明，用户决策再追加讨论。已实现基础与完整 RSI、公开市场、持久后台工作须明确区分。实机证据应记录实际调用与边界，不用 fixture 结果替代。

纯文档改动在仓库根运行 `npm run check:docs`，核对目标存在和命令有效即可；它不验证产品能力、远端网页可达性或 Mermaid 语义。
