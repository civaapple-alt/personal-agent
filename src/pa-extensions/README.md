# PA 扩展集成

此目录维护随 PA 编译的扩展集成代码。宿主调用这些模块做安装发现、授权和运行装配。Pi 进程内运行的入口见 [Pi 扩展](../../pi-extensions/README.md)。

## Web Access

- [package.ts](web-access/package.ts) 从 Pi 的用户包清单定位官方 npm 包，校验清单中的实际入口，并通过 Pi 安装。通用的 Pi 包命令见 [pi-packages.ts](../rpc/pi-packages.ts)。
- [runtime.ts](web-access/runtime.ts) 按岗位 ID 和创建时间核对网页检索授权。主责、内部委托和讨论回复可装配 `web_search` 与 `get_search_content`。岗位与执行模式决定是否访问包清单。
- 平台管理员通过[管理路由](../server/routes/web-access.ts) 保存授权。[团队扩展](../../pi-extensions/team-extension/README.md) 在 Pi 内核查工具清单和限制搜索调用参数。

部署与使用见[为 AI 岗位启用网页检索](../../docs/guides/web-search.md)。
