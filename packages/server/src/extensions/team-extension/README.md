# 团队扩展的 PA 集成

PA 启动岗位时加载 `team-extension`。[runtime.ts](runtime.ts) 根据岗位的运行模式、角色类型和可请教成员计算团队工具权限。岗位运行器也使用这些权限校验桥接调用。

| 工具 | 装配条件 |
| --- | --- |
| `read_space` | 主责或内部协作者，读取当前事项资料 |
| `save_space_page` | 当前事项的主责，立即保存资料或按修订号更新 |
| `delegate_to_member` | 有可请教成员的主责，或内部协作者 |
| `propose_experience` | 正式执行的主责或内部协作者 |

角色架构师、旁听和独立验收使用各自的工具清单。人工提问由 Human Question 装配。 [工具选择](runtime.ts) [Human Question](../human-question/README.md)

运行模块把本轮桥接地址和令牌、工具清单、目标工作区与上下文传给 Pi，并按能力挂载 `pa-extensions/{worker-runtime,workbench-help,space,delegation,skill-capture}`。Pi 报告实际启用的工具。桥接传输管理请求校验、去重与取消，事项编排负责委托、确认与归档。 [PA 宿主扩展](../../../../../pa-extensions/README.md) [桥接传输](../../rpc/team-tool-bridge.ts) [事项编排](../../orchestrator/README.md)

## 验证

在仓库根运行下列离线测试，核对握手、调用取消与多岗位协作。

```sh
node --test test/team-tool-bridge.test.ts test/continuity-collaboration.test.ts
```
