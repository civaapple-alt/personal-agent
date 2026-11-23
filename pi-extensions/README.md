# Pi 扩展

此目录存放在 Pi 进程内运行的 PA 扩展。PA 通过 `--extension` 传入入口，再按岗位和运行模式确定模型可以调用的工具。 [运行配置](../docs/reference/configuration.md#cli-启动与能力装配)

安装发现、工具选择和启动环境见 [PA 扩展集成](../src/pa-extensions/README.md)。

| 扩展 | 用途 | 加载方式 |
| --- | --- | --- |
| [skill-catalog](skill-catalog/README.md) | 列出 Pi 已发现的 Skills 并按需读取完整方法 | PA 启动岗位和独立角色架构师时加载 |
| [team-extension](team-extension/README.md) | 将团队工具调用转交 PA，注入岗位与事项上下文，核查工具清单 | PA 启动岗位时显式加载 |
| [human-question](human-question/README.md) | 请求人工答复或向直接委托者提请澄清 | PA 按运行模式显式加载。终端 Pi 也可以单独加载 |
| [pstack-methods](pstack-methods/README.md) | 从指定的 pstack 方法包读取方法正文 | PA 启用 pstack 后显式加载。终端 Pi 也可以单独加载 |

[pi-web-access](../docs/guides/web-search.md) 由 Pi 从 npm 安装。[PA 扩展集成](../src/pa-extensions/README.md#web-access) 按岗位装配包入口，团队扩展通过现有握手核查搜索与结果读取工具。

## 扩展之间的依赖

扩展可以依赖另一个扩展提供的能力。依赖的安装和运行时加载是两个步骤。

- **代码依赖。** 如果 A 导入 B 提供的模块，在 A 的 `package.json` 的 `dependencies` 中声明 B。模块安装后可以导入。需要执行 B 的 Pi 扩展入口时，也要把该入口纳入 Pi 的资源清单或启动参数。 [Pi 包依赖](https://docs.pi.dev/latest/packages#declare-dependencies)
- **运行时依赖。** 如果 A 依赖 B 注册的工具或发布的事件，记录 B 的入口、所需工具名或事件，以及依赖缺失时的行为。启动时装配两个入口，等 B 注册能力后再使用。必需工具缺失时应报告错误。可选能力缺失时，A 可以继续提供其余功能。 [Pi 扩展接口](https://docs.pi.dev/latest/extensions)

PA 的岗位进程由 `worker-runner.ts` 选择扩展入口和允许的工具。`team-extension` 在会话启动时等待已声明的工具注册，并向 PA 报告实际可用的清单。例如，启用 pstack 后，常规岗位同时加载 `pstack-methods` 并要求 `load_pstack_skill` 就绪。关闭 pstack 后，团队工具仍可使用。 [岗位装配](../src/orchestrator/worker-runner.ts) [能力握手](team-extension/README.md#启动与能力握手)
