# 显式选择的真实 Pi 验证

这两个脚本会使用本机 Pi 配置发出真实模型请求，不属于离线 `npm test`。不要为纯文档修改或常规检查自动运行，也不要把一次成功扩大为长期岗位能力已验证。

| 入口 | 实际范围 |
| --- | --- |
| [rpc-smoke.ts](rpc-smoke.ts)，根命令 `npm run demo:rpc` | 在仓库根 cwd 运行，无持久 session，读取架构文档并输出 RPC 状态；属于早期 transport 冒烟，不覆盖团队协作 |
| [team-smoke.ts](team-smoke.ts)，根命令 `npm run demo:team` | 创建临时工作区、数据库和会话；主成员真实委托同事，继续澄清不归档，再跨宿主进程接续并发布一个明确测试版本 |

`team-smoke` 保留临时证据目录，输出 `first.json`、`restart.json` 与数据库/会话的位置；样例是假设，不是业务需求确认，不访问书架。模型和超时以脚本为准，不展示或索取密钥。

构建后可在仓库根用 `node dist/demo/team-smoke.js` 验证编译后的扩展路径；先运行 `npm run build`。隔离启动但不调用模型的方式见 [scripts](../../scripts/README.md)，离线验证选择见 [test](../../test/README.md)，已有有限实机证据见[运行说明](../../docs/runtime-collaboration.md)。
