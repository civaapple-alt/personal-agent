# 工作台帮助

[catalog.ts](catalog.ts) 定义岗位可查的主题，并按主题读取随版本发布的[工作台功能速查](../../../docs/guides/agent-workbench.md)。扩展向岗位提供简短的主题索引。

团队扩展通过当轮桥接提供 `read_pa_help`。需要查实时状态时，[编排模块](../../orchestrator/workbench-context.ts)使用当前事项和工作区的记录。工具参数只接收主题和答复语言。

发送流程识别出工作台问题时，[岗位运行器](../../orchestrator/worker-runner.ts)将匹配主题放入当前轮参考资料，由岗位结合对话回答。
