# Personal Agent 文档

## 安装与使用

| 你要完成什么 | 阅读入口 |
| --- | --- |
| 从预构建包启动个人工作台并发送第一条提问 | [安装与首次运行](tutorials/getting-started.md) |
| 加入组织、安排事项、审阅成果或调整岗位模型 | [在工作台安排事项与验收成果](guides/user-guide.md) |
| 查阅随版本发布的工作台功能说明 | [工作台功能速查](guides/agent-workbench.md) · [English](guides/agent-workbench.en.md) |
| 下载已发布版本；了解升级要求与 0.8.x LTS 基线 | [0.9.0 发布说明](releases/v0.9.0.md) · [0.8.x LTS 候选基线](releases/v0.8-lts-baseline.md) · [0.8.3 发布说明](releases/v0.8.3.md) · [0.8.2 发布说明](releases/v0.8.2.md) · [0.8.1 发布说明](releases/v0.8.1.md) · [0.8.0 发布说明](releases/v0.8.0.md) · [0.7.1 发布说明](releases/v0.7.1.md) · [0.7.0 发布说明](releases/v0.7.0.md) |

## 部署与管理团队

| 你负责什么 | 阅读入口 |
| --- | --- |
| 启动共享服务、迁移本机数据、备份 | [部署与管理团队工作台](guides/team-administration.md) |
| 审核账号、邀请同事、设置仓库和事项权限 | [团队账号、超级管理员与组织协作](guides/team-administration.md#团队账号超级管理员与组织协作) |
| 核对本机执行权限、数据流和网络边界 | [安全说明](../SECURITY.md) |
| 查环境变量、存储路径、Pi CLI 参数（`--offline` 等）、资源发现或超时 | [配置参考](reference/configuration.md) |
| 使用 Pi 管理 pstack 等 Skill 包 | [启用 pstack 方法包](guides/pstack-runtime.md) |
| 安装 pi-web-access、授权岗位或使用 Kimi 搜索 | [为 AI 岗位启用网页检索](guides/web-search.md) |

## 开发与贡献

按[开发指南](guides/development.md)启动工作台并选择检查。提交补丁、报告问题和贡献岗位的流程见[贡献指南](../CONTRIBUTING.md)。

| 你要查什么 | 阅读入口 |
| --- | --- |
| 开发环境、隔离团队沙盒、测试与分发 | [开发指南](guides/development.md)、[端到端测试（E2E）](../e2e/README.md) |
| 模块所有权、数据流和后续计划 | [当前架构与后续计划](concepts/architecture-and-plan.md)、[后端入口](../packages/server/src/README.md)、[前端入口](../apps/web/README.md)、[可运行示例](../examples/README.md) |
| Git 资料空间、五类默认空间与仓库文件关联 | [资料空间设计](concepts/space-design.md) |
| SQLite 23 张表结构、索引、约束与存储边界 | [SQLite 库表设计参考](reference/database-schema.md) |
| 会话范围、委托、取消、成果归档与经验生命周期 | [运行与协作参考](reference/runtime-collaboration.md) |
| 内置岗位的职责、能力报告与角色作用域 | [内置角色与能力参考](reference/role-design.md)、[单兵模式与团队协作模式](concepts/solo-and-team-modes.md)、[0.9.x 便携 Pi 协作扩展设计](concepts/v0.9-portable-pi-collaboration-design.md)、[角色定义](../roles/README.md)、[内置岗位 Skills 包](../pi-extensions/role-skills/README.md) |
| Pi Skill 目录工具的参数与使用范围 | [pstack 方法工具参考](reference/pstack-tools.md) |

## 复核实现与证据

这些页面供维护者和评审者复跑模型演示或查阅已有记录。每篇说明运行成本、观察结果和验证范围。

| 要核对的行为 | 阅读入口 |
| --- | --- |
| 会话接续、真实委托与经验 | [协作链路验证](validation/runtime-checks.md) |
| 旁听何时补充、保持静默或停止 | [旁听验证](validation/observer-demo.md) |
| 发布前协作、文件一致性和独立正文质量 | [发布前复核验证](validation/publication-review.md) |
| 角色创建后履职、模型决策与英文 Skill 对照 | [角色真实任务验证](validation/role-design-demo.md) |
| pstack 是否读取指定方法，或能否从自然任务主动选方法 | [方法装载验证](validation/pstack-checks.md)、[自然任务选择验证](validation/pstack-selection.md) |

## 理解设计与沿革

- [设计思路](concepts/design-principles.md)解释岗位、事项、交付和经验设计。[产品方向](concepts/product-direction.md)记录长期目标。[未来版本提案（0.9.x+）](concepts/future-proposals.md)汇总 `0.8.x LTS` 与后续版本的分流准则及待办提案。
- [产品讨论](history/product-discussion.md)、[角色草案](history/team-roles.md)、[团队交互探索](history/team-interaction.md)和[架构演进](history/architecture-history.md)记录当时的判断与验证。
- [0.6.3](releases/v0.6.3.md)、[0.6.2](releases/v0.6.2.md)、[0.6.1](releases/v0.6.1.md)、[0.6.0](releases/v0.6.0.md)和[0.5.0](releases/v0.5.0.md)记录各版的安装、升级与验证范围。[变更日志](../CHANGELOG.md)列出逐版改动。

## 维护文档

| 目录 | 放什么 |
| --- | --- |
| `tutorials/` | 带读者走完一个可观察结果的首次体验 |
| `guides/` | 特定读者完成工作时可直接照做的步骤 |
| `reference/` | 可按字段或行为查找的配置、工具与运行契约 |
| `concepts/` | 产品和架构的设计取舍、实现范围及后续方向 |
| `validation/` | 可复跑的验证步骤、验收标准和有日期的结果 |
| `history/` | 已存档的讨论、方案和实现记录 |
| `releases/` | 对应版本的变化、下载、升级与验证说明 |

依据当前实现维护操作和参考文档。文档放到一个主目录，其他读者从这里或相关章节链接过去。更新与检查步骤见[开发指南](guides/development.md#同步文档与变更记录)。
