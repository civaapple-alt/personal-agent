# 团队扩展

`team-extension` 在 Pi 中注册 PA 的团队工具。工具调用通过当前执行专用的本机 HTTP 桥接转交 PA。事项与成员身份、权限校验和结果记录由 PA 处理。 [扩展入口](index.ts) [宿主桥接](../../packages/server/src/rpc/team-tool-bridge.ts)

| 工具 | 用途 |
| --- | --- |
| `read_pa_help` | 查阅指定的工作台帮助主题或本事项工作区的快照 |
| `delegate_to_member` | 请其他岗位提供协作结果，或委托独立验收 |
| `read_space` | 查看当前事项的资料清单或指定资料 |
| `save_space_page` | 主责立即保存资料；更新时提交当前修订号，冲突后重新读取；成功回合关联反馈记录 |
| `propose_experience` | 提交候选经验 |

[human-question](../human-question/README.md) 独立注册 `request_clarification`。两个扩展共用[桥接客户端](../shared/team-bridge-client.ts)。

## 启动与能力握手

从 PA 启动岗位即可加载扩展。PA 通过 `--extension` 指定 `index.ts`，同时为当前执行提供 `PA_TEAM_BRIDGE_URL`、`PA_TEAM_BRIDGE_TOKEN` 和 `PA_REQUIRED_TOOLS`。源码启动和预构建包使用同一入口。 [岗位装配](../../packages/server/src/orchestrator/worker-runner.ts)

Pi 触发 `session_start` 后，扩展等待 PA 所需的工具注册，最长等待 10 秒，启用已注册的运行工具并通过 `/ready` 回报结果。PA 检查必需工具，缺失时结束启动并报告工具名称。角色工具声明不再是权限清单；团队工具仍按事项协作规则装配和校验。 [扩展入口](index.ts) [扩展之间的依赖](../README.md#扩展之间的依赖)

扩展还在 `before_agent_start` 中按目标工作区筛选 Pi 自动发现的上下文文件，并补充岗位规则和当前事项上下文。 [Pi RPC 和桥接说明](../../packages/server/src/rpc/README.md)

安装网页检索扩展时，扩展在 `tool_call` 中让 `web_search` 直接返回结果，关闭后台全文抓取和按次指定代理。 [网页检索配置](../../docs/guides/web-search.md)

`fetch_content` 返回 GitHub 内容时，扩展根据工具结果中明确的克隆或 API 标记补充来源提示；临时克隆不代表已登记工作区，进程结束后可能失效。续接 Pi 会话时，从保留的工具结果识别临时路径；当 `read` 返回 `ENOENT` 时提示重新获取。未识别的返回格式保持获取方式未知，不修改其他工具结果。结构化输出继续原样保留。

## 验证

从仓库根目录运行桥接测试。它覆盖工具参数校验、异步工具注册、调用取消和上下文过滤。

```bash
node --test test/team-tool-bridge.test.ts
```
