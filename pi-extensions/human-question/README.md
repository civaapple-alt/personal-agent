# Human Question

这个 Pi 扩展注册 `request_clarification`。提供选项时显示单选列表，省略选项时接收文字答复。

## 在终端 Pi 中使用

从 PA 仓库根目录加载扩展，随后让 Pi 使用工具向你澄清一个问题。

```sh
pi -e ./pi-extensions/human-question/index.ts
```

工具把答复或取消结果交回当前 Pi 会话。RPC 宿主也可以接收 Pi 原生对话事件。 [Pi 对话接口](https://docs.pi.dev/latest/extensions#dialogs)

## 在 PA 中使用

PA 为正式执行的主责与内部委托显式加载此入口。扩展将问题通过现有团队桥接交回 PA。主责可生成「待你决定」卡片，协作者的问题回到直接委托者。 [PA 集成](../../packages/server/src/extensions/README.md#human-question)
