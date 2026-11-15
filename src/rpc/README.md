# Pi RPC 与团队工具桥接

此目录同时包含宿主侧 transport 和在 Pi 内加载的扩展；不要混淆两端的职责。

| 文件 | 改动入口与约束 |
| --- | --- |
| [pi-rpc-worker.ts](pi-rpc-worker.ts) | 启动/停止 Pi，关联命令 ID，转发事件、处理对话和等待收尾；支持 `suspendIdleTimeout()` 在宿主桥接耗时期间暂停空闲看门狗。`sessionFile` 必须是编排核选定的文件 |
| [jsonl.ts](jsonl.ts) | 严格按 LF 分帧，保留 JSON 字符串里的 Unicode 分隔符 |
| [types.ts](types.ts) | 本项目消费的 Pi 命令、事件与对话协议；先核实 Pi 实际语义再改 |
| [team-extension.ts](team-extension.ts) | 在 Pi 内注册委托/成果工具，核查动态工具装配并加入当前岗位系统上下文；内部模式不注册发布工具 |
| [team-tool-bridge.ts](team-tool-bridge.ts) | 每执行专属的 loopback HTTP、bearer token、参数校验、调用 ID 去重和取消。宿主再次拒绝内部成员发布 |

`agent_settled` 表示执行收尾，不能据此自动生成交付；`disposition: handled` 不等待 settled。RPC 的 `steer` 等方法也不代表网页已有运行中插话。模型错误不能伪装为空正文成功。

工具调用者的事项、成员与工作区由 [编排核](../orchestrator/README.md)绑定，模型参数不能改写身份。声明的 Skill/扩展/MCP 不是装载成功证据，实际工具清单必须通过核查。构建后扩展从 `dist/` 的对应文件加载，保持源代码与编译入口均可用。

从仓库根运行 `node --test test/pi-rpc-worker.test.ts test/team-tool-bridge.test.ts`。它们使用本地受控进程/扩展，不消耗真实模型；整条生产委托路径还需 [continuity 测试](../../test/README.md)，有限真实 Pi 验证见 [demo](../demo/README.md)。
