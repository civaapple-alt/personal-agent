# 启用 pstack 方法包

在工作台启用 [backnotprop/pstack](https://github.com/backnotprop/pstack) 后，岗位可按需读取模式、playbook 和原则。Pi 负责包的安装和更新。

## 安装并在工作台启用

1. 打开「设置 → 扩展插件」。团队版使用超级管理员账号，本机免密模式使用本机所有者。
2. 如果 PA 检测到服务账号已全局安装 pstack，目录会自动填入。缺少方法包时，点击「安装 pstack」，PA 会调用 Pi 安装并填入目录。也可在服务主机手动安装，随后刷新设置。

   ```bash
   pi install git:github.com/backnotprop/pstack
   ```

3. 点击「启用」，让之后启动的岗位使用该方法包。

要使用其他位置的已有方法包，可以填写绝对路径后启用。方法包根目录须包含 `plugin.json` 和 `skills/poteto-mode/SKILL.md`。工作台校验并保存路径，后续启动的岗位按各自的工具配置使用它。

## 用启动配置指定已有目录

如果已有完整方法包，可以在启动时直接传入其目录。

```bash
PA_PSTACK_DIR=/path/to/pstack npm run start:web
```

使用预构建包时，在解压目录设置相同变量后执行 `node dist/server/main.js`。`PA_PSTACK_DIR` 优先于工作台保存的设置。

## 更新或停用

- 用 `pi update git:github.com/backnotprop/pstack` 更新已安装的包。更新后在工作台刷新运行配置。安装路径改变时，在卡片中启用新路径。
- 点击「停用」清除 PA 的启用配置。已安装的包仍可在 Pi 中使用。由 `PA_PSTACK_DIR` 启用时，在启动配置中移除该变量后重启。
- 已由旧版 PA 克隆的方法包可按原路径继续使用。要改由 Pi 管理更新，先用 Pi 安装，再将新安装路径填入工作台。

## 核对装载状态

在「设置 → 运行配置」查看配置路径和版本。实际岗位启动时，`runtime_ready` 记录 Pi 装配成功的工具。安装的包可用 `pi list` 核对。 [Pi 包管理](https://docs.pi.dev/latest/packages#install-and-manage-packages) · [方法工具参考](../reference/pstack-tools.md) · [真实任务装载记录](../validation/pstack-checks.md)

要在独立的 Pi 会话使用 PA 提供的方法读取工具，参见 [pstack-methods 扩展包](../../pi-extensions/pstack-methods/README.md)。
