# Web Access 的 PA 集成

PA 通过 Pi 安装 npm 包 `pi-web-access`。安装完成后，所有事项岗位执行均可用；历史岗位停用名单不再生效。 [安装与配置](../../../../../docs/guides/web-search.md) [管理路由](../../server/routes/web-access.ts)

| 文件 | 维护职责 |
| --- | --- |
| [package.ts](package.ts) | 通过 `pi list --no-approve` 查找服务账号的用户包，解析包清单并校验入口位于实际安装目录内 |
| [runtime.ts](runtime.ts) | 为所有事项岗位执行装配 `web_search`、`get_search_content` 与 `fetch_content` |

GitHub 抓取证据由团队扩展和岗位运行器共同处理。只有工具结果明确报告临时克隆或 API 视图时才使用对应标签；其他结果标记为方式未知。事项事件记录去除查询参数的仓库来源、方式与已知截断状态，不记录临时路径或全文。续接提示不保证历史工具结果在会话压缩后仍存在。

岗位运行器将已安装的工具加入本轮清单，通过启动握手核查实际可用性。Pi 侧将搜索调用设为直接返回结果，并关闭后台抓取全文与按次指定代理。 [岗位运行器](../../orchestrator/worker-runner.ts) [Pi 侧调用限制](../../../../../pi-extensions/team-extension/index.ts)

## 验证

在仓库根运行下列离线测试，核对用户包发现、入口范围和搜索参数限制。

```sh
node --test test/runtime-settings.test.ts test/team-tool-bridge.test.ts
```
