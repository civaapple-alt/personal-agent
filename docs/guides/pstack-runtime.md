# 启用 pstack 方法包

工作台管理员可将完整 pstack 方法包接入 Pi，让岗位按需读取模式、playbook 与原则。方法包来源为 [backnotprop/pstack](https://github.com/backnotprop/pstack)。

## 使用已有方法包

确认包根目录包含 `plugin.json` 和 `skills/poteto-mode/SKILL.md`，再从源码目录启动。

```bash
PA_PSTACK_DIR=/path/to/pstack npm run start:web
```

如果使用预构建包，在解压目录设置相同变量后执行 `node dist/server/main.js`。`PA_PSTACK_DIR` 优先于工作台保存的设置。

## 从工作台克隆并管理方法包

1. 启动时省略 `PA_PSTACK_DIR`。以超级管理员身份打开「设置 → 扩展插件」。本机免密试用时以本机所有者身份打开。
2. 在 pstack 扩展卡片确认 Git 仓库地址，点击「克隆并启用 pstack」。服务将仓库放在数据库同级的 `extensions/repo/`，校验后保存路径。
3. 在扩展卡片查看启用状态、方法包版本和实际路径。后续启动的 Pi Worker 会使用该包，重启后工作台也会读取保存的路径。

需要升级时，确保克隆目录没有未提交的改动，再点击「同步更新」。服务先校验上游版本，再快进本地分支。校验失败时保留当前版本。点击「停用」可清除启用状态并保留本地仓库目录。

## 核对装载状态

在「设置 → 运行配置」查看当前实例的 pstack 状态。若扩展异常，请确认包根目录和必需文件。未启用时，岗位使用自身配置的方法。

维护者可查看 [`runtime_ready` 与方法工具参考](../reference/pstack-tools.md)以及[真实任务装载记录](../validation/pstack-checks.md)。
