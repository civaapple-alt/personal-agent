# Human Question 的 PA 集成

[runtime.ts](runtime.ts) 为主责与内部协作者装配 `request_clarification`（旁听、独立验收和角色架构师不加载）。它为每次执行暂存一个问题，并校验引用的委托编号属于当前岗位收到的澄清。 [Pi 提问扩展](../../../../../pi-extensions/human-question/README.md)

| 来源 | 处理方式 |
| --- | --- |
| 主责调用澄清工具 | 问题进入事项的「待你决定」卡片，并保留来源委托 |
| 内部协作者调用工具或打开 Pi 原生弹窗 | 将问题和本轮已有发现交回直接委托者 |

事项编排在本轮收尾时保存卡片。答复接口校验参与权限、答复人、版本与工作区，记录答复人身份，并按派发权限接续。 [事项编排](../../orchestrator/execution/matter-dispatch.ts) [答复接口](../../server/routes/human-decisions.ts) [等待人类决定](../../../../../docs/reference/runtime-collaboration.md#等待人类决定)

## 验证

在仓库根运行下列离线测试，核对提问转交、答复权限、并发提交与重启后接续。

```sh
node --test test/human-question-extension.test.ts test/human-decisions.test.ts
```
