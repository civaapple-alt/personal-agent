# 0.9.1 Board 多切片实机复杂验证报告

本文档记录 `0.9.1`「Board 治理硬化 + 复杂实机验证」小闭环在真实 Pi CLI 与异构双模型下的实机运行结果、收敛指标与诚实边界。

## 1. 验证命令与测试夹具

- **执行命令**：`npm run e2e:live -- --scenario board-complex --profile cross-verify`（运行脚本：[board-complex-smoke.ts](../../packages/server/src/demo/board-complex-smoke.ts)）
- **模型配置**：
  - Coordinator & Builders：`kimi-coding/kimi-for-coding`（`thinkingLevel: "high"`）
  - Independent Read-only Verifier：`opencode-go/deepseek-v4.1-flash`（via `spawn_board_agent` `modelOverride`）
- **隔离工作区夹具**：
  - `SPEC.md`：定义 `parseMetricLines`（CRLF/注释/负数浮点/非法行号与标签校验）与 `formatMetricSummary`（字典序排序、2 位小数四舍五入、消除 `-0`、严格 `>` 阈值告警与空输入格式）。
  - Slice A：`src/parser.mjs`（由 `parser-builder` 独占 `ownedScope: ["src/parser.mjs"]` 实现）。
  - Slice B：`src/formatter.mjs`（由 `formatter-builder` 独占 `ownedScope: ["src/formatter.mjs"]` 实现）。
  - 集成胶水与独立测试：`src/pipeline.mjs` 与临时隔离工作区中的 `test/pipeline.test.mjs`（禁止改动；交付后由宿主在隔离目录独立执行 `node --test` 复核）。

## 2. 实机运行指标（Run `008-live-board-complex-20261127-230219`）

| 指标 | 实测结果 |
| --- | --- |
| 账本记录 | `.data-e2e/runs/008-live-board-complex-20261127-230219`（`verdict: PASS`） |
| 总耗时 | `152,271 ms`（约 152.3 秒） |
| 动态成员 | `coordinator` + 2 Builders（`parser-builder`、`formatter-builder`）+ 1 Verifier（`verifier-pipeline`） |
| 同仓并发写保护 | `maxConcurrentBuilders = 1`（`parser-builder` 与 `formatter-builder` 按序串行执行写轮次；只读 `verifier-pipeline` 与第二个 Builder 并行拉起） |
| 总执行轮次 | `11` 次 Worker 启动（`coordinator` 3 次、`parser-builder` 2 次、`formatter-builder` 3 次、`verifier-pipeline` 3 次） |
| 板帖分布 | 共 `8` 条：`assign=1`、`handoff=2`、`progress=3`、`verify_pass=1`、`summary=1`（`verify_rework=0`） |
| 事件总量（`matter_events`） | 共 `133` 条：`capability_ready=11`、`tool_start=50`、`tool_end=50`、`turn_summary=22`（`monitor_alert=0`） |
| 宿主独立复核 | 隔离工作区 `pipeline.test.mjs` → `3/3 PASS` |

## 3. 关键协作过程观察

1. **同仓 Builder 串行化与只读 Verifier 并行**：`coordinator` 在 `#1 assign` 同时 `@parser-builder` 和 `@formatter-builder` 后，宿主先调度 `parser-builder`（`21.5s`）；其完成后立即拉起只读 `verifier-pipeline`（预检 `#2`）与第二个写成员 `formatter-builder`（`22.7s`），全程 `maxConcurrentBuilders === 1`，未发生同仓写踩踏。
2. **异构 Verifier 拒绝过早签收**：`verifier-pipeline`（`deepseek-v4.1-flash`）首次运行虽然本地 `3/3` 测试已全部通过，但核对板帖时发现当时仅收到 `parser-builder` 的 `#2 handoff`、尚未收到 `formatter-builder` 的 `#3 handoff`，于是主动发 `#4 progress` 拒绝过早签发 `verify_pass`；待 Coordinator 澄清且 `formatter-builder` 回复确认指纹后，才正式签发 `#7 verify_pass`。
3. **非理想收敛与改进观察（诚实记录）**：
   - 本次实机中 Builder 一次写对规格，`reworkCount` 为 `0`；`verify_rework` 连续返工熔断、故障重试和越界拦截目前主要由离线单测 [board-governance-hardening.test.ts](../../test/board-governance-hardening.test.ts) 验证。
   - `coordinator` 在最后 `#8 summary` 帖中同时 `@parser-builder`、`@formatter-builder`、`@verifier-pipeline`、`@user`，导致 3 个已完成的子成员被各多唤醒 1 轮做短确认（`4.2s`–`12.0s`），后续可在 `summary` 规则中进一步提示收口帖仅 `@user` 或留空 `mentions` 以减少尾部唤醒开销。

## 4. 配套离线治理门禁验证

除上述实机运行外，同轮通过以下离线验证：
- [board-governance-hardening.test.ts](../../test/board-governance-hardening.test.ts)（5/5）：覆盖 PA/HTTP/便携三端拦截 `@all`、`ownedScope` Pi `tool_call` 写拦截、同仓 Builder 串行调度、`verify_rework` 连续返工熔断及 Builder/Coordinator 故障升级与失败显式回报。
- 全量离线门禁：`npm run check`、`npm run build`、`npm test`（`279/279`）、`npm run check:startup`、`npm run check:docs`、`npm run e2e`（`3/3`）。
