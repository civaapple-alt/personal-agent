# 按行为选择验证

本目录使用 `node:test`。受控 Worker、模型回复 fixture、本地子进程与 HTTP 都是离线验证；它们不调用真实模型，也不能证明岗位长期能力。所有命令在仓库根运行。

| 你改了什么 | 主要覆盖 |
| --- | --- |
| Pi RPC、JSONL、超时或退出 | [pi-rpc-worker.test.ts](pi-rpc-worker.test.ts) |
| GitHub 抓取来源、临时克隆失效、事件脱敏与展示 | [web-fetch-evidence.test.ts](web-fetch-evidence.test.ts) 和 [continuity-collaboration.test.ts](continuity-collaboration.test.ts) |
| 扩展/bridge 鉴权、重试与能力清单 | [team-tool-bridge.test.ts](team-tool-bridge.test.ts) |
| 会话接续、委托、取消与成果语义 | [continuity-collaboration.test.ts](continuity-collaboration.test.ts) |
| 运行巡检、等待豁免与恢复 | [turn-monitor.test.ts](turn-monitor.test.ts) |
| 文档文件来源、精确正文、越界/编码/大小、变更拒绝及重复登记 | [document-publication.test.ts](document-publication.test.ts) |
| 角色 Markdown、私有记忆与基本编排 | [phase2-orchestrator.test.ts](phase2-orchestrator.test.ts) |
| 立项适配诊断、单兵/定向旁听边界与引导式角色设计（Role Architect） | [matter-initiation-and-architect.test.ts](matter-initiation-and-architect.test.ts) |
| 类型化 Pi 决策引擎、模型态立项接口、Schema/Roster 强校验与取消 | [pi-decision.test.ts](pi-decision.test.ts) |
| 模型草案保留用户要求、缺失依赖可见、真实读取证据及抛异常校验器 | [decision-contracts.test.ts](decision-contracts.test.ts) |
| 角色路径与 ID 冲突、批量提案校验、并发应用、符号链接和删除后重新打开数据库 | [member-management.test.ts](member-management.test.ts) |
| 多租户作用域角色/Skill 目录、角色包落盘、确认后生成新 Skill 草案、个人配额与严格用户隔离 | [scoped-roles-and-skills.test.ts](scoped-roles-and-skills.test.ts) |
| 五个角色方法装载、能力组合、体检来源、设计到导出一致性与缺失依赖提前失败 | [role-capabilities.test.ts](role-capabilities.test.ts) |
| Pi Skill 目录、仅手动调用的 Skill 和重名处理 | [skill-catalog.test.ts](skill-catalog.test.ts) |
| pstack 演示的隔离方法资源读取、路径与大小边界 | [pstack-runtime.test.ts](pstack-runtime.test.ts) |
| 自然任务不泄露方法名称、临时读取范围、完整正文证据、质量分层及无模型汇总 | [pstack-selection.test.ts](pstack-selection.test.ts) |
| 开源元数据、私有路径、历史凭据脱敏、素材归档排除与原型保留 | [open-source.test.ts](open-source.test.ts) |
| 角色真实演示的待审阅/失败区分、输入哈希、原文引用、离线帮助和目录保护 | [role-design-demo.test.ts](role-design-demo.test.ts) |
| Phase 4 RSI 经验提案、提炼、替代与评估 | [rsi-lifecycle.test.ts](rsi-lifecycle.test.ts) |
| RSI 工作区证据、失败分支、替代关系、版本评价与退出清理 | [rsi-boundaries.test.ts](rsi-boundaries.test.ts) |
| HTTP/SSE、用户对话、工作区、预览与路由 | [phase3-server.test.ts](phase3-server.test.ts) |
| 设置子页运行底座、Pi 探测与扩展清单接口 | [runtime-settings.test.ts](runtime-settings.test.ts) |
| 旁听广播、Phase 4 RSI 与文件/图片上传接口 | [server-rsi-and-uploads.test.ts](server-rsi-and-uploads.test.ts) |
| 组织/身份、受限协同门禁与花名册边界 | [server-collaboration.test.ts](server-collaboration.test.ts) |
| 多用户注册/审核/超管配额、组织成员与 AI 角色隔离、Git 克隆主目录边界、成员直接派发、交付成果库按组织筛选/私密/受限/只读、RSI 权限边界与团队版一键沙盒脚本（[start-team-sandbox.mjs](../scripts/start-team-sandbox.mjs)） | [multi-tenant-auth-admin.test.ts](multi-tenant-auth-admin.test.ts) |
| 组织会话切换、旁听背景、复盘失效与旧范围保留 | [organization-context.test.ts](organization-context.test.ts) |
| 提请状态、并发批准、附件缺失与并发图片派发 | [ai-request-lifecycle.test.ts](ai-request-lifecycle.test.ts) |
| 复核对照的工具证据判定，排除失败、未完成及发布后的咨询 | [publication-review.test.ts](publication-review.test.ts) |
| 场景要求、重复顺序、独立审阅来源/行号/缺项校验、三层汇总与离线模式 | [publication-review-evaluation.test.ts](publication-review-evaluation.test.ts) |
| 旁听演示的后加入前情、受限桥接、反馈接续、会话、静默与失败区分 | [observer-demo.test.ts](observer-demo.test.ts) |
| 前端纯函数（委托气泡、进度、摘要与附件） | [web-utils.test.ts](web-utils.test.ts) |
| 测试 Worker 的能力握手/工具请求 | [worker-helpers.ts](worker-helpers.ts)，供上述测试复用 |

例如只验证连续上下文：

```bash
node --test test/continuity-collaboration.test.ts
```

- 完整离线验证先运行 `npm run build:web` 生成服务测试所需静态资源，再运行 `npm test`。测试脚本使用临时 Pi 配置目录，不读取本机安装的 Pi 软件包。
- 代码交付还需相应的 `npm run check` 与 `npm run build`。
- 验证源码和构建入口使用 `npm run check:startup`，前提是后端和网页均已构建。

数据与会话使用内存或临时目录；服务绑定临时端口，并在结束/失败时清理。新增取消、失败或恢复用例时验证实际状态与成果记录，不能只检查“方法被调用”。不要缩短调度余量来制造不稳定的空闲超时测试。

真实模型只在需要验证集成时显式选用 [demo](../packages/server/src/demo/README.md)；纯文档改动使用 [check:docs](../scripts/README.md)，不重跑整套应用测试。
