# 扩展 SDK（`@pa/extension-api`）

本包为 [pa-extensions/](../../pa-extensions/README.md) 提供严格分离的宿主侧与浏览器侧声明接口，不提供混合导出的根入口：

- `@pa/extension-api/server`（[src/server.ts](src/server.ts)）：`defineServerExtension`，声明面向 **Pi RPC 子进程** 装配的扩展元数据、工具清单、内置 Pi 入口或原生第三方 Pi 包名。
- `@pa/extension-api/web`（[src/web.ts](src/web.ts)）：`defineWebExtension`，声明浏览器侧工具展示标签、分类与成功状态文案（零 Node / 宿主依赖）。
