# 使用 Pi 管理 Skill 包

PA 使用 Pi 当前已启用的 Skills，包括需要手动调用的 pstack 方法。安装、更新和停用由运行 PA 的服务账号通过 Pi 管理。

```bash
pi install git:github.com/backnotprop/pstack
pi list
pi config
```

`pi config` 中可调整已安装资源的启停。PA 的 AI 成员可用 `list_available_skills` 查看 Pi 发现的 Skill，并按需用 `load_available_skill` 读取正文。方法目录仅证明当前可发现，实际使用需查看工具调用记录。 [工具参考](../reference/pstack-tools.md)

## 从旧版迁移

旧版工作台的 pstack 安装、启用、停用入口以及 `PA_PSTACK_DIR` 和平台设置中的 `pstackDir` 不再参与运行。已经通过 Pi 安装并启用的包无需重新安装。之前只通过 PA 指向的本地目录，需要在服务账号中运行 `pi install /原有/方法包路径` 重新登记，再用 `pi list` 和 `pi config` 核对。此次改动不会删除本地包；旧路径设置不再生效，后续保存平台设置时该旧字段可能被移除。

岗位默认可发现服务账号已启用的用户级 Skills。工作区项目资源是否自动发现受 Pi 项目信任与 PA 运行模式影响；多用户部署时，这些用户级 Skills 对服务岗位共享。 [运行配置](../reference/configuration.md#cli-启动与能力装配)

真实任务演示需使用隔离工作区并显式提供方法包路径。 [方法装载验证](../validation/pstack-checks.md) · [自然任务选择验证](../validation/pstack-selection.md)
