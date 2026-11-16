# 按行为选择验证

本目录使用 `node:test`。受控 Worker、模型回复 fixture、本地子进程与 HTTP 都是离线验证；它们不调用真实模型，也不能证明岗位长期能力。所有命令在仓库根运行。

| 你改了什么 | 主要覆盖 |
| --- | --- |
| Pi RPC、JSONL、超时或退出 | [pi-rpc-worker.test.ts](pi-rpc-worker.test.ts) |
| 扩展/bridge 鉴权、重试与能力清单 | [team-tool-bridge.test.ts](team-tool-bridge.test.ts) |
| 会话接续、委托、取消与成果语义 | [continuity-collaboration.test.ts](continuity-collaboration.test.ts) |
| 文档文件来源、精确正文、越界/编码/大小、变更拒绝及重复登记 | [document-publication.test.ts](document-publication.test.ts) |
| 角色 Markdown、私有记忆与基本编排 | [phase2-orchestrator.test.ts](phase2-orchestrator.test.ts) |
| Phase 4 RSI 经验提案、提炼、替代与评估 | [rsi-lifecycle.test.ts](rsi-lifecycle.test.ts) |
| RSI 工作区证据、失败分支、替代关系、版本评价与退出清理 | [rsi-boundaries.test.ts](rsi-boundaries.test.ts) |
| HTTP/SSE、用户对话、工作区、预览与路由 | [phase3-server.test.ts](phase3-server.test.ts) |
| 旁听广播、Phase 4 RSI 与图片上传接口 | [server-rsi-and-uploads.test.ts](server-rsi-and-uploads.test.ts) |
| 组织/身份、受限协同门禁与花名册边界 | [server-collaboration.test.ts](server-collaboration.test.ts) |
| 组织会话切换、旁听背景、复盘失效与旧范围保留 | [organization-context.test.ts](organization-context.test.ts) |
| 提请状态、并发批准、附件缺失与并发图片派发 | [ai-request-lifecycle.test.ts](ai-request-lifecycle.test.ts) |
| 内置演示准备、文件保留、四步进度与正常归档 | [inner-matter.test.ts](inner-matter.test.ts) |
| 复核对照的工具证据判定，排除失败、未完成及发布后的咨询 | [publication-review.test.ts](publication-review.test.ts) |
| 场景要求、重复顺序、独立审阅来源/行号/缺项校验、三层汇总与离线模式 | [publication-review-evaluation.test.ts](publication-review-evaluation.test.ts) |
| 旁听演示的后加入前情、受限桥接、反馈接续、会话、静默与失败区分 | [observer-demo.test.ts](observer-demo.test.ts) |
| 前端纯函数（委托气泡、进度、摘要与附件） | [web-utils.test.ts](web-utils.test.ts) |
| 测试 Worker 的能力握手/工具请求 | [worker-helpers.ts](worker-helpers.ts)，供上述测试复用 |

例如只验证连续上下文：

```bash
node --test test/continuity-collaboration.test.ts
```

- 完整离线验证先运行 `npm run build:web` 生成服务测试所需静态资源，再运行 `npm test`。
- 代码交付还需相应的 `npm run check` 与 `npm run build`。
- 验证源码和构建入口使用 `npm run check:startup`，前提是后端和网页均已构建。

数据与会话使用内存或临时目录；服务绑定临时端口，并在结束/失败时清理。新增取消、失败或恢复用例时验证实际状态与成果记录，不能只检查“方法被调用”。不要缩短调度余量来制造不稳定的空闲超时测试。

真实模型只在需要验证集成时显式选用 [demo](../src/demo/README.md)；纯文档改动使用 [check:docs](../scripts/README.md)，不重跑整套应用测试。
