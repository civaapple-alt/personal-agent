# PA 扩展集成

此目录维护随 PA 编译的扩展集成模块。管理路由保存配置，岗位运行器按当前岗位和运行模式组装扩展入口、工具清单和子进程环境。Pi 进程内的扩展入口见 [Pi 扩展](../../pi-extensions/README.md)。

## pstack 方法包

发现和校验已安装的方法包，并为岗位装配方法工具和提示。 [pstack-methods 维护入口](pstack-methods/README.md)

## 团队扩展

按岗位权限选择团队工具，并向 Pi 提供桥接地址、所需工具和运行上下文。 [team-extension 维护入口](team-extension/README.md)

## Web Access

发现和安装 `pi-web-access`，为获授权的岗位装配网页检索工具。 [web-access 维护入口](web-access/README.md)

## Human Question

为正式执行的岗位装配澄清工具，保留委托来源并把问题交给直接委托者或人类。 [human-question 维护入口](human-question/README.md)

## 共用入口

- 源码启动和预构建入口共用内置 Pi 扩展路径解析。 [builtin-paths.ts](builtin-paths.ts)
- 扩展安装和检测复用 Pi 命令。团队工具经每次执行专用的本机桥接传输。 [Pi 包命令](../rpc/pi-packages.ts) [团队桥接](../rpc/team-tool-bridge.ts)
- 岗位运行器合并工具清单，启动 Pi 后通过桥接核对实际可用工具。设置页从运行概览读取扩展状态。 [岗位运行器](../orchestrator/worker-runner.ts) [运行概览](../orchestrator/runtime-info.ts)
