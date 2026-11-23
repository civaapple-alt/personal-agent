# pstack 方法包的 PA 集成

PA 通过 Pi 查找或安装 `git:github.com/backnotprop/pstack`，再由管理员选择要启用的方法包。启动时设置的 `PA_PSTACK_DIR` 优先于工作台保存的目录。 [安装与启用](../../../docs/guides/pstack-runtime.md) [服务启动](../../server/main.ts)

| 文件 | 维护职责 |
| --- | --- |
| [package.ts](package.ts) | 从 Pi 用户包清单查找 pstack、校验方法包结构并调用 Pi 安装 |
| [runtime.ts](runtime.ts) | 为配置了方法包的主责、内部委托、旁听和独立验收装配方法包、扩展入口、`load_pstack_skill` 与岗位提示 |

岗位启动时校验方法包，准备工具清单并在 `runtime_ready` 记录包版本、模式文件哈希和可用方法数量。Pi 中的工具读取方法 Markdown 并返回来源和哈希。 [岗位运行器](../../orchestrator/worker-runner.ts) [Pi 方法读取扩展](../../../pi-extensions/pstack-methods/README.md)

## 验证

在仓库根运行下列离线测试，核对包发现、管理员启用、方法读取与岗位工具范围。

```sh
node --test test/pstack-runtime.test.ts test/runtime-settings.test.ts
```
