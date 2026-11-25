# 显式选择的真实 Pi 验证

这些脚本会使用本机 Pi 配置发出真实模型请求，不属于离线 `npm test`。不要为纯文档修改或常规检查自动运行，也不要把一次成功扩大为长期岗位能力已验证。

| 入口 | 实际范围 |
| --- | --- |
| [rpc-smoke.ts](rpc-smoke.ts)，根命令 `npm run demo:rpc` | 在仓库根 cwd 运行，无持久 session，读取架构文档并输出 RPC 状态；属于早期 transport 冒烟，不覆盖团队协作 |
| [team-smoke.ts](team-smoke.ts)，根命令 `npm run demo:team` | 创建临时工作区、数据库和会话；主成员真实委托同事，继续澄清不归档，再跨宿主进程接续并发布一个明确测试版本 |
| [team-capabilities-smoke.ts](team-capabilities-smoke.ts)，根命令 `npm run demo:team:capabilities` | 使用合成的历史内部启动清单，询问真实主责对职责、边界与工具证据的判断；保留原文和事件，需独立审阅，脚本结束不代表语义质量通过 |
| [space-smoke.ts](space-smoke.ts)，根命令 `npm run demo:space` | 在临时数据库、Git 资料空间与工作区中，通过账号登录和 HTTP 派发真实模型，检查同组织读取、跨组织拒绝、版本差异、旧版本反馈、编辑冲突及私密目录预览权限；保留 `evidence.json` |
| [rsi-smoke.ts](rsi-smoke.ts)，根命令 `npm run demo:rsi`（别名 `npm run demo:trust`） | 临时工作区/数据库/会话中端到端验证「信任四步」：Turn 1 真实调用 `propose_skill`（含 `SKILL.md` + 可执行 `scripts/check.mjs`）与 `save_space_page` → 人工确认落盘 → Turn 2 触发步骤 3 `tool_call` 确认弹窗并升级步骤 4 `autonomous` → Turn 3 无弹窗自主执行 + `session-insights` 解析；保留 `evidence.json`，`--help` 不调用模型 |
| [pi-native-smoke.ts](pi-native-smoke.ts)，根命令 `npm run demo:pi-native` | 隔离临时工作区中验证 0.8.0/0.8.1 Pi 原生能力（支持 `--case all\|docs\|ux`，`--help` 不调用模型）：`docs` 验证模型经 `<pa_docs>` 用原生 `read` 真实读取 PA 的 `examples/README.md` 并准确回答；`ux` 验证 `visualize` + `suggest_next_steps`（`metadata.nextSteps` 持久化）与 `session-insights` 真实会话解析；保留 `pi-native-report.json` |
| [solo-vs-business-smoke.ts](solo-vs-business-smoke.ts)，根命令 `npm run demo:solo` | 隔离临时工作区中实机对照 `pi-default`（`roleKind: solo`）与 `product-manager`（`roleKind: business`）的真实 Pi 上下文与工具握手差异：核验 `pi-default` 关闭 `delegate_to_member` 与多角色名册/能力卡/复核话术，同时保留 `space` / `propose_skill` / `visualize` / `request_clarification` / `suggest_next_steps` / `read_team_roles` / `propose_role`；输出 `solo-vs-business-report.json`，`--help` 不调用模型 |
| [publication-review-smoke.ts](publication-review-smoke.ts)，根命令 `npm run demo:review` | 默认一次自主场景配对，支持 `--scenario required/solo/all`、`--repeat N`；分开报告发布、场景协作与正文质量，独立审阅后用 `--summarize <目录>` 离线汇总。未审阅返回 2，不算通过。详见[评估说明](../../../../docs/validation/publication-review.md) |
| [observer-smoke.ts](observer-smoke.ts)，根命令 `npm run demo:observer` | 五轮真实任务覆盖点名旁听、后加入前情、风险提醒、意见回到负责人、独立事项静默与关闭；保留原始旁听回复及阶段成果，未审阅返回 2。`--summarize <目录>` 离线刷新，详见[旁听演示](../../../../docs/validation/observer-demo.md) |
| [role-design-smoke.ts](role-design-smoke.ts)，`npm run demo:architect` | 两轮真实任务：架构师设计角色、沿已有提案 API 创建，再由新角色实际只读核查矛盾；保留验证计划、能力声明与实际文件/工具证据，独立语义审阅前返回 2 |
| [role-design-smoke.ts](role-design-smoke.ts)，`npm run demo:roles` | 四轮分别验证产品、研发、测试与市场判断；合成数据中的计数缺陷应被测试岗位报告为失败，运行通过不等于质量通过。两命令的 `--help`/`--summarize` 不调用模型，见[角色真实任务验证](../../../../docs/validation/role-design-demo.md) |
| [decision-smoke.ts](decision-smoke.ts)，`npm run demo:decision` | 在隔离临时工作区调用真实 Pi 模型跑通 3 场景立项阵型决策（纯讨论、否定条款下的法务缺口、带只读查仓的研发+旁听决策）与 1 场景 AI 角色设计，并留存 `decision-report.json`；`--help` 不调用模型 |
| [pstack-smoke.ts](pstack-smoke.ts)，`npm run demo:pstack -- --source <目录>` | 在临时方法副本、项目、数据库与会话中验证产品岗位实际读取模式，以及研发读取模式和原则、修复真实合成缺陷并通过固定测试；保留 `report.json`，未满足实际读取条件也判失败。`--help` 不调用模型，见[pstack 运行说明](../../../../docs/guides/pstack-runtime.md) |
| [pstack-selection-smoke.ts](pstack-selection-smoke.ts)，`npm run demo:pstack:selection -- --source <目录>` | 五类不点名方法的自然任务，独立保留方法观察、执行完整性和哈希/行号绑定的回答审阅；不把未选目标方法等同回答错误。完整一轮六次主负责人调用，`--case` 可单选，`--help`/`--summarize` 不调用模型，见[选择验证](../../../../docs/validation/pstack-selection.md) |


`demo:decision` 的查仓场景明确要求读取合成工作区的 `README.md` 与 `package.json`，两份文件均有成功完成的真实工具读取记录才通过；仅开放 `read` 工具不算读取成功。`decision-report.json` 保留实际路径及阵型输出，但脚本通过不代表阵型语义质量或长期角色能力已通过独立评估。

`publication-review` 的场景与标准在 [case](publication-review-case.ts)，工具时序与场景行为在 [evidence](publication-review-evidence.ts)，参数及重复顺序在 [options](publication-review-options.ts)，独立审阅校验在 [quality](publication-review-quality.ts)，离线三层汇总在 [report](publication-review-report.ts)。重复轮次使用独立目录、数据库和会话；不因咨询次数更多而自动判定质量改善。

`team-smoke` 保留临时证据目录，输出 `first.json`、`restart.json` 与数据库、空间仓库、会话的位置；样例是假设，不是业务需求确认，不访问已登记业务项目。模型和超时以脚本为准，不展示或索取密钥。

- 隔离启动但不调用模型的方式见 [scripts](../../../../scripts/README.md)，离线验证选择见 [test](../../../../test/README.md)。
- 已有有限实机证据见[运行说明](../../../../docs/reference/runtime-collaboration.md)。
