# 共享契约包（`@pa/contracts`）

本包是三环架构中的 **Wire 契约环**，存放前后端共享的纯 TypeScript DTO 类型与无宿主依赖的纯运行时校验/解析函数：

- [human-decision.ts](src/human-decision.ts)：人工决策卡状态与解析
- [role-proposal-state.ts](src/role-proposal-state.ts)：角色架构师提案动作判定
- [team-verification.ts](src/team-verification.ts)：独立验收结论与类型守卫
- [model-selection.ts](src/model-selection.ts)、[thinking-levels.ts](src/thinking-levels.ts)：模型与推理等级契约
- [extensions.ts](src/extensions.ts)：已注册 PA 扩展的 Wire 摘要与契约版本
- [matter.ts](src/matter.ts)、[board.ts](src/board.ts)：事项核心 DTO、`0.9.0` 协作模式与公告板/事件拆表契约
- [organization.ts](src/organization.ts)、[workspace.ts](src/workspace.ts)：平台账号、组织、RBAC、审计与工作区目录定制 DTO
- [team.ts](src/team.ts)、[space.ts](src/space.ts)、[runtime.ts](src/runtime.ts)：团队成员/角色设计、资料空间、运行时概览与启动装配 DTO
- [sse-events.ts](src/sse-events.ts)：HTTP SSE 事件名与载荷契约（含 `0.9.0` 公告板增量事件）
- [schemas/](src/schemas/index.ts)（导出子路径 `@pa/contracts/schemas`）：基于 `valibot` 的运行时入参 Schema（`common`、`board`、`matter`、`space`、`organization`、`admin`、`skill-trust`）与 `InferSchemaOutput`

约束：本包禁止引入 `node:*`、React 或任何宿主内部模块，由 `npm run check:boundaries` 强制校验。
