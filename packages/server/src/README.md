# 后端源码地图

本层连接角色资产、SQLite 与 Pi 执行，不包含网页实现。公共导出集中在 [index.ts](index.ts)，服务入口是 [server/main.ts](../../../apps/cli/src/main.ts)。

```text
src/
├── index.ts          # 后端公共导出入口
├── orchestrator/     # 事项派发、会话范围、跨岗位委托、旁听评审、人类澄清与经验复盘
├── rpc/              # Pi CLI 子进程管理、JSONL 协议分帧、工具桥接与包安装
├── pa-extensions/    # 宿主侧扩展装配（team-extension、web-access、.env 密钥治理）
├── storage/          # SQLite 数据库/领域仓储与独立 Git 资料空间引擎（SpaceGitStore）
├── server/           # 同源 HTTP/SSE 服务、多租户鉴权、ACL、业务路由与预览管理
├── roles/            # 角色 Markdown 与 Skill 包解析、能力报告与角色架构师规则
└── demo/             # 调用真实模型的冒烟与对照验证脚本（与离线 test/ 区分）
```

按要改变的行为进入对应模块：

| 行为 | 阅读入口 | 相邻模块 |
| --- | --- | --- |
| 负责人、会话范围、内部协作、成果收尾 | [orchestrator](orchestrator/README.md) 和 [单轮派发](orchestrator/matter-dispatch.ts) | 调用 storage 与 rpc，接受 server 派发 |
| Pi 子进程、协议或模型工具 | [rpc](rpc/README.md) | 向编排核交回事件和工具调用 |
| PA 扩展的安装、岗位授权和运行装配 | [pa-extensions](pa-extensions/README.md) | 由编排核和管理路由调用 |
| 数据、记忆筛选、版本或执行占用 | [storage](storage/README.md) | 编排核与 HTTP API 共用同一 store |
| HTTP/SSE、对话卡片、预览服务 | [server](server/README.md) 和 [业务路由](server/README.md#业务路由) | 对接编排核与 [网页](../../../apps/web/README.md) |
| 角色文件解析和序列化 | [roles](roles/README.md) | 读取顶层 [roles 资产](../../../roles/README.md) |
| 手工真实模型验证 | [demo](demo/README.md) | 与离线 test 区分 |

先在拥有行为的模块修改，再沿调用关系核对契约；例如委托策略在编排核，网络参数校验在 bridge，JSONL 分帧在 RPC。不要通过修改本机 Pi 上游绕过本项目的问题。

- 离线覆盖按 [test 导航](../../../test/README.md)选择；跨模块改动按根 [开发约定](../../../AGENTS.md)运行检查和构建。
- 整体关系见[当前架构](../../../docs/concepts/architecture-and-plan.md)，精确协议和数据边界再查[运行说明](../../../docs/reference/runtime-collaboration.md)。
