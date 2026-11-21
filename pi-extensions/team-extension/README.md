# 团队扩展

`team-extension` 在 Pi 中注册 PA 的团队工具。工具调用通过当前执行专用的本机 HTTP 桥接转交 PA。事项与成员身份、权限校验和结果记录由 PA 处理。 [扩展入口](index.ts) [宿主桥接](../../src/rpc/team-tool-bridge.ts)

| 工具 | 用途 |
| --- | --- |
| `delegate_to_member` | 请其他岗位提供协作结果，或委托独立验收 |
| `request_clarification` | 主责可请求人类决定，受委托成员的问题先返回委托方 |
| `publish_deliverable` | 暂存交付成果，在本轮成功收尾后归档 |
| `propose_experience` | 提交候选经验 |

## 启动与能力握手

从 PA 启动岗位即可加载扩展。PA 通过 `--extension` 指定 `index.ts`，同时为当前执行提供 `PA_TEAM_BRIDGE_URL`、`PA_TEAM_BRIDGE_TOKEN` 和 `PA_REQUIRED_TOOLS`。源码启动和预构建包使用同一入口。 [岗位装配](../../src/orchestrator/worker-runner.ts)

Pi 触发 `session_start` 后，扩展等待岗位声明的工具注册，最长等待 10 秒。它根据工具清单设置可用工具，并通过 `/ready` 回报结果。PA 收到回报后检查必需工具，缺失时结束启动并报告工具名称。主责、受委托成员和旁听使用各自的工具清单。 [扩展入口](index.ts) [扩展之间的依赖](../README.md#扩展之间的依赖)

扩展还在 `before_agent_start` 中按目标工作区筛选 Pi 自动发现的上下文文件，并补充岗位规则和当前事项上下文。 [Pi RPC 和桥接说明](../../src/rpc/README.md)

获网页检索授权时，扩展在 `tool_call` 中让 `web_search` 直接返回结果，关闭后台全文抓取和按次指定代理。 [网页检索配置](../../docs/guides/web-search.md)

## 验证

从仓库根目录运行桥接测试。它覆盖工具参数校验、异步工具注册、调用取消和上下文过滤。

```bash
node --test test/team-tool-bridge.test.ts
```
