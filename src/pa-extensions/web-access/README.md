# Web Access 的 PA 集成

PA 通过 Pi 安装 npm 包 `pi-web-access`。安装完成后，业务岗位默认可用，平台管理员可逐个停用。 [安装与配置](../../../docs/guides/web-search.md) [管理路由](../../server/routes/web-access.ts)

| 文件 | 维护职责 |
| --- | --- |
| [package.ts](package.ts) | 通过 `pi list --no-approve` 查找服务账号的用户包，解析包清单并校验入口位于实际安装目录内 |
| [runtime.ts](runtime.ts) | 按岗位 ID 和创建时间匹配停用名单，为可用的主责与内部协作者装配 `web_search`、`get_search_content` 与 `fetch_content` |

岗位运行器将获授权的工具加入本轮清单，通过启动握手核查实际可用性。Pi 侧将搜索调用设为直接返回结果，并关闭后台抓取全文与按次指定代理。 [岗位运行器](../../orchestrator/worker-runner.ts) [Pi 侧调用限制](../../../pi-extensions/team-extension/index.ts)

## 验证

在仓库根运行下列离线测试，核对用户包发现、入口范围和搜索参数限制。

```sh
node --test test/runtime-settings.test.ts test/team-tool-bridge.test.ts
```
