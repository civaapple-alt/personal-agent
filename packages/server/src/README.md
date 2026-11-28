# 后端源码地图

本层是可嵌入的引擎宿主库（`@pa/server`），连接角色资产、SQLite 与 `@pa/pi-rpc` 执行，不包含网页实现。公共导出集中在 [index.ts](index.ts)，启动函数在 [server/boot.ts](server/boot.ts)（由薄启动器 [apps/cli/src/main.ts](../../../apps/cli/src/main.ts) 调用），内部单向依赖由 `npm run check:boundaries` 强制门禁校验。

```text
packages/server/src/
├── index.ts          # 后端公共导出入口
├── build-support.ts  # 运行时资产清单单一真相源（@pa/server/build-support）
├── server/           # 唯一组合根：bootHost、Hono 路由（router.ts）/SSE、鉴权、ACL、@pa/contracts/schemas 校验与预览管理
├── orchestrator/     # 领域子模块：execution/、architect/、rsi/、runtime/ 与 team-orchestrator.ts
├── extensions/       # 统一扩展注册表（registry.ts）与宿主侧运行时装配、.env 凭据治理、速查目录
├── rpc/              # 团队工具桥接（team-tool-bridge.ts）与 @pa/pi-rpc 兼容转出
├── storage/          # SQLite 数据库/领域仓储与独立 Git 资料空间引擎（SpaceGitStore）
├── roles/            # 角色 Markdown 与 Skill 包解析、能力报告与角色架构师规则
├── subprocess/       # 统一受控子进程执行器（runBounded：超时、输出上限与进程组强杀）
├── log/              # 轻量分级结构化 JSONL 日志（轮转落盘至 <dataDir>/logs/server.jsonl）
└── demo/             # 调用真实模型的冒烟与对照验证脚本（与离线 test/ 区分，生产模块禁止引用）
```

按要改变的行为进入对应模块：

| 行为 | 阅读入口 | 相邻模块 |
| --- | --- | --- |
| 负责人、会话范围、内部协作、成果收尾 | [orchestrator](orchestrator/README.md) 和 [单轮派发](orchestrator/execution/matter-dispatch.ts) | 按 `execution/`、`architect/`、`rsi/`、`runtime/` 分领域组织 |
| Pi 子进程、协议或模型工具 | [rpc](rpc/README.md) 与 [@pa/pi-rpc](../../pi-rpc/README.md) | 向编排核交回事件和工具调用 |
| PA 扩展注册表与运行装配 | [extensions](extensions/README.md) | 对接顶层 [pa-extensions](../../../pa-extensions/README.md) |
| 数据、记忆筛选、版本或执行占用 | [storage](storage/README.md) | 严禁反向依赖 orchestrator/server |
| HTTP/SSE、Hono 路由与边界校验、对话卡片、预览服务 | [server](server/README.md)、[router.ts](server/router.ts) 与 [业务路由](server/README.md#业务路由) | 组合根，消费 [@pa/contracts/schemas](../../contracts/src/schemas/index.ts)，对接编排核与 [网页](../../../apps/web/README.md) |
| 角色文件解析和序列化 | [roles](roles/README.md) | 读取顶层 [roles 资产](../../../roles/README.md) |
| 手工真实模型验证 | [demo](demo/README.md) | 与离线 test 区分 |

先在拥有行为的模块修改，再沿调用关系核对契约；例如委托策略在编排核，HTTP 入参 Schema 与路由中间件在 [@pa/contracts/schemas](../../contracts/src/schemas/index.ts) 与 [router.ts](server/router.ts)，网络参数校验在 bridge，JSONL 分帧在 RPC。不要通过修改本机 Pi 上游绕过本项目的问题。

- 离线覆盖按 [test 导航](../../../test/README.md)选择；跨模块改动按根 [开发约定](../../../AGENTS.md)运行检查和构建。
- 整体关系见[当前架构](../../../docs/concepts/architecture-and-plan.md)，精确协议和数据边界再查[运行说明](../../../docs/reference/runtime-collaboration.md)。
