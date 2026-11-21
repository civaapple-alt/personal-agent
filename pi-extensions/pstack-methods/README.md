# Pi pstack 方法读取扩展

这个 Pi 扩展提供 `load_pstack_skill`，读取完整 pstack 方法包中的 Markdown、来源路径和 SHA-256。pstack 的方法内容由上游分发。 [pstack 安装与启用](../../docs/guides/pstack-runtime.md)

## 在 Pi 中使用

从 PA 仓库根目录运行以下命令。用 `pi list` 查到的实际安装路径替换示例路径。

```bash
PA_PSTACK_DIR=/path/to/pstack pi -e ./pi-extensions/pstack-methods
```

要持久登记扩展，运行 `pi install ./pi-extensions/pstack-methods`。之后为需要此工具的 Pi 进程设置 `PA_PSTACK_DIR`。未配置时，扩展启动后跳过工具注册。

## 在 PA 中使用

PA 将选定的 pstack 方法包目录传给扩展，并在工具握手中核对 `load_pstack_skill`。岗位的文件、终端与协作工具由 PA 装配。 [编排入口](../../src/orchestrator/worker-runner.ts) · [方法工具参考](../../docs/reference/pstack-tools.md)
