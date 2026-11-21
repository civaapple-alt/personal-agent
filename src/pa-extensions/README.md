# PA 扩展集成

此目录维护随 PA 编译的扩展集成代码。宿主调用这些模块做安装发现、授权和运行装配。Pi 进程内运行的入口见 [Pi 扩展](../../pi-extensions/README.md)。

## pstack 方法包

- [package.ts](pstack-methods/package.ts) 通过 Pi 查找或安装方法包，并校验包结构。
- [runtime.ts](pstack-methods/runtime.ts) 为配置了方法包的岗位提供 `--skill`、`--extension`、`load_pstack_skill` 和岗位提示。独立验收沿用自己的工具清单。

部署与使用见[启用 pstack 方法包](../../docs/guides/pstack-runtime.md)。

## 团队扩展

- [builtin-paths.ts](builtin-paths.ts) 解析内置 Pi 扩展在源码和预构建包中的入口。
- [runtime.ts](team-extension/runtime.ts) 按运行模式、角色类型和可请教成员生成团队工具清单，并为 Pi 提供桥接地址、工具清单与岗位上下文。
- [桥接传输](../rpc/team-tool-bridge.ts) 校验、转发和取消工具调用。委托调度、人工确认与成果归档由[编排器](../orchestrator/README.md)负责。

## Web Access

- [package.ts](web-access/package.ts) 从 Pi 的用户包清单定位官方 npm 包，校验清单中的实际入口，并通过 Pi 安装。通用的 Pi 包命令见 [pi-packages.ts](../rpc/pi-packages.ts)。
- [runtime.ts](web-access/runtime.ts) 按岗位 ID 和创建时间核对网页检索授权。主责、内部委托和讨论回复可装配 `web_search` 与 `get_search_content`。岗位与执行模式决定是否访问包清单。
- 平台管理员通过[管理路由](../server/routes/web-access.ts) 保存授权。[团队扩展](../../pi-extensions/team-extension/README.md) 在 Pi 内核查工具清单和限制搜索调用参数。

部署与使用见[为 AI 岗位启用网页检索](../../docs/guides/web-search.md)。

## Human Question

[runtime.ts](human-question/runtime.ts) 为正式执行的主责和协作者装配 [Pi 提问扩展](../../pi-extensions/human-question/README.md)，校验来源委托，并为当前轮暂存一个问题。协作者通过 Pi 原生弹窗提问时也会进入这条澄清路径。

[事项编排](../orchestrator/matter-dispatch.ts)保存卡片状态。[答复接口](../server/routes/human-decisions.ts)核对答复人、问题版本和接续权限。
