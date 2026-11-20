# Pi RPC 与团队工具桥接

此目录同时包含宿主侧 transport 和在 Pi 内加载的扩展；不要混淆两端的职责。

| 文件 | 改动入口与约束 |
| --- | --- |
| [pi-rpc-worker.ts](pi-rpc-worker.ts) | 启动/停止 Pi，关联命令 ID，转发事件、处理对话和等待收尾；支持 `suspendIdleTimeout()` 在宿主桥接耗时期间暂停空闲看门狗，同一实例拒绝重叠 `runPromptAndWait` 并通过拦截器保持运行期 `setDialogHandler` 动态更新不被覆盖。`sessionFile` 必须是编排核选定的文件 |
| [jsonl.ts](jsonl.ts) | 严格按 LF 分帧，保留 JSON 字符串里的 Unicode 分隔符 |
| [types.ts](types.ts) | 本项目消费的 Pi 命令、事件与对话协议；先核实 Pi 实际语义再改 |
| [team-extension.ts](team-extension.ts) | 在 Pi 内注册委托、成果和经验提案工具并核查动态装配。按 `PA_TARGET_WORKSPACE_ROOT` 过滤祖先和宿主 `contextFiles`，通过结构化提示词选项追加岗位上下文，保留后续扩展的贡献。通过 `node:http` 调用桥接。内部模式关闭发布，旁听模式关闭经验提案 |
| [pstack-extension.ts](pstack-extension.ts) | 显式配置时注册只读 `load_pstack_skill`，从批准的方法包读取实际正文和哈希，提供路径指引与读取清单；不注册业务文件、终端或团队权限 |
| [team-tool-bridge.ts](team-tool-bridge.ts) | 每执行专属的 loopback HTTP、关闭服务端 300s `requestTimeout`、bearer token、参数校验（`delegate_to_member` / `publish_deliverable` / `propose_experience`）、调用 ID 去重和取消。宿主再次拒绝内部成员发布及旁听模式提案 |

`agent_settled` 表示执行收尾，不能据此自动生成交付；`disposition: handled` 不等待 settled。
RPC 的 `steer` 等方法也不代表网页已有运行中插话。模型错误不能伪装为空正文成功。

工具调用者的事项、成员与工作区由 [编排核](../orchestrator/README.md)绑定，模型参数不能改写身份。
文档发布参数为 `sourcePath` 或 `content` 二选一：文件来源只允许 `document`，校验后由宿主读取；桥接拒绝同时传两份正文来源，不自行猜测正文对应哪个文件。文件快照与提交校验属于编排模块。
声明的 Skill/扩展/MCP 不是装载成功证据，实际工具清单必须通过核查。构建后扩展从 `dist/` 的对应文件加载，保持源代码与编译入口均可用。

常规本机任务由 Pi 发现已启用的用户资源，以及可信工作区的项目资源。宿主通过 HTTP 调用者和监听范围选择资源策略，并让两种策略使用独立的 Pi 会话。 [资源装配策略](../../docs/configuration.md#cli-启动与能力装配)

从仓库根运行 `node --test test/pi-rpc-worker.test.ts test/team-tool-bridge.test.ts`。
它们使用本地受控进程/扩展，不消耗真实模型；整条生产委托路径还需 [continuity 测试](../../test/README.md)，有限真实 Pi 验证见 [demo](../demo/README.md)。
