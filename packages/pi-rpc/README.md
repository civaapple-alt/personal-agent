# Pi RPC 会话原语底座（`@pa/pi-rpc`）

本包是 Personal Agent 的底层 **Pi RPC 子进程会话原语层**（对应 ThinkRail `pi-delegation` 的底座定位），只负责与本机 `pi --mode rpc` 通信的通用机制，不包含任何岗位、组织、SQLite 或业务编排逻辑：

- [pi-rpc-worker.ts](src/pi-rpc-worker.ts)：拉起/停止 Pi RPC 子进程、命令关联、事件流转发、空闲超时挂起与动态对话拦截器
- [jsonl.ts](src/jsonl.ts)：严格按 LF 分帧的 JSONL 编解码
- [types.ts](src/types.ts)：Pi RPC 命令、事件、会话状态与对话协议类型
- [prompt-usage.ts](src/prompt-usage.ts)：汇总 Pi 原生上报的 Token 与缓存用量
- [model-catalog.ts](src/model-catalog.ts)、[pi-packages.ts](src/pi-packages.ts)：通过原生 Pi 查询可用模型目录与已安装包

约束：本包除 `node:*` 外仅允许依赖 `@pa/contracts`，由 `npm run check:boundaries` 强制门禁校验。
