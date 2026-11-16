# 显式选择的真实 Pi 验证

这些脚本会使用本机 Pi 配置发出真实模型请求，不属于离线 `npm test`。不要为纯文档修改或常规检查自动运行，也不要把一次成功扩大为长期岗位能力已验证。

| 入口 | 实际范围 |
| --- | --- |
| [rpc-smoke.ts](rpc-smoke.ts)，根命令 `npm run demo:rpc` | 在仓库根 cwd 运行，无持久 session，读取架构文档并输出 RPC 状态；属于早期 transport 冒烟，不覆盖团队协作 |
| [team-smoke.ts](team-smoke.ts)，根命令 `npm run demo:team` | 创建临时工作区、数据库和会话；主成员真实委托同事，继续澄清不归档，再跨宿主进程接续并发布一个明确测试版本 |
| [rsi-smoke.ts](rsi-smoke.ts)，根命令 `npm run demo:rsi` | 临时工作区/数据库/会话中验证真实经验提案、成功收尾提交、正式文件、版本改评和无工具复盘，保留 `evidence.json` |
| [inner-matter-smoke.ts](inner-matter-smoke.ts)，根命令 `npm run demo:inner` | 在临时 Git 工作区跑完内置四步场景，核对真实委托、前两轮零交付、反馈后的 V1/V2 与文件来源发布的精确正文一致性，保留 `turns.json` 和数据库 |
| [publication-review-smoke.ts](publication-review-smoke.ts)，根命令 `npm run demo:review` | 同一合成 V1/V2 的隔离基线/当前方法对照，记录发布前专业咨询、历史保留、真实 `sourcePath` 调用与精确正文一致性；内容质量按[审阅标准](../../docs/publication-review.md)独立复核，不自动打分 |

[inner-matter-definition.ts](inner-matter-definition.ts) 是网页内置演示的纯定义，不是会自动运行的 CLI。四步体验及按需初始化规则见[内置演示事项](../../docs/inner-matter-demo.md)。

`team-smoke` 保留临时证据目录，输出 `first.json`、`restart.json` 与数据库/会话的位置；样例是假设，不是业务需求确认，不访问书架。模型和超时以脚本为准，不展示或索取密钥。

- 构建后可在仓库根用 `node dist/demo/team-smoke.js` 验证编译后的扩展路径（先运行 `npm run build`）。
- 隔离启动但不调用模型的方式见 [scripts](../../scripts/README.md)，离线验证选择见 [test](../../test/README.md)。
- 已有有限实机证据见[运行说明](../../docs/runtime-collaboration.md)。
