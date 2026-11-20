# 安装与首次运行

按本文启动本地工作台，再用虚构的反馈收集场景完成一次需求讨论。所有项目命令都在源码或解压包的根目录运行。

## 1. 准备环境

先检查已有工具。

```bash
node --version
npm --version
git --version
```

项目要求 Node.js 22.19 或更高版本。各平台的验证结果见[发布说明](../releases/v0.6.2.md)。

从 [0.6.2 发布页](https://github.com/civaapple-alt/personal-agent/releases/tag/v0.6.2)下载源码包或预构建包。也可以克隆该版本的源码。

```bash
git clone --branch v0.6.2 https://github.com/civaapple-alt/personal-agent.git
cd personal-agent
```

## 2. 安装本地 Pi CLI 并配置模型

AI 岗位通过本机 Pi CLI 调用模型和工具。请先安装 Pi，再配置模型访问权限。安装命令见 [Pi 官网](https://pi.dev/)。

按系统和包管理方式选择安装入口。

| 环境 | 官方安装入口 |
| --- | --- |
| macOS、Linux | 官网的 curl 安装方式 |
| Windows | 官网的 PowerShell 安装方式 |
| 使用 Node 包管理器 | 官网的 npm、pnpm 或 bun 安装方式 |

在准备启动工作台的终端确认 `pi` 已加入 `PATH`。

```bash
pi --version
```

打开 Pi 的交互界面。

```bash
pi
```

复现已验证的 Pi 1.5.2 环境时，可安装 `@earendil-works/pi-coding-agent@1.5.2`。日常安装和更新见 [Pi 官方文档](https://docs.pi.dev/latest)。

在 Pi 中用 `/login` 配置模型访问，再用 `/model` 确认可用模型。把认证信息保存在 Pi 的配置中。

内置岗位默认使用 `kimi-coding / kimi-for-coding`。每个岗位按自己的 provider 和 model 设置运行。使用其他提供商时，先[修改参与岗位的模型](../guides/user-guide.md#调整岗位模型)，再派发任务。调用费用和额度以所用提供商为准。

如果服务先于 Pi 启动，退出服务，再从能执行 `pi --version` 的终端重新启动。

## 3. 安装项目依赖并启动工作台

从源码运行时，先在仓库根目录安装依赖。

```bash
npm ci
```

### 从源码启动

```bash
npm run start:web
```

终端显示监听地址后，打开 `http://127.0.0.1:4310`。本机默认以「本机所有者」身份免密进入。点击左下角的「切换账号」可打开登录或注册页。

### 从预构建包启动

在解压目录直接启动。

```bash
node dist/server/main.js
```

预构建包也不包含 Pi，执行 AI 任务仍需要上一步的本地安装与模型配置。

源码和预构建包默认都使用启动目录下的 `.data/`。打开工作台即可检查页面是否可用。发送演示提问时才调用模型。按 `Ctrl+C` 停止前台服务。

需要为其他成员提供访问时，按[团队部署指南](../guides/team-administration.md)启用账号认证。

## 4. 发起第一次需求讨论

1. 以本机所有者身份进入新建事项，点击**体验内置演示**。
2. 确认出现“小团队反馈收集盒”和四步引导。此时只准备了虚构资料，尚无 AI 产出。
3. 在“需求讨论”中填入提问，阅读输入内容，再发送给产品经理。这一步开始使用模型。
4. 等待产品经理概括用户问题并提出关键问题。第一轮只讨论需求，成果库不应因此新增正式版本。

首次发送前确认当前关联的是内置演示工作区。它默认位于 `.data/inner-matter`，是独立 Git 仓库，但不是沙箱。继续专业协作、V1 和 V2 的步骤见[四步演示说明](inner-matter-demo.md)。

要验证本地服务启动，在源码目录运行以下命令。

```bash
npm run build
npm run check:startup
```

启动检查用临时数据和端口验证两个服务入口。使用真实模型的演示命令见 [demo 导航](../../src/demo/README.md)。

## 5. 处理常见启动问题

| 现象 | 处理方式 |
| --- | --- |
| Node 不支持 TS 或 `node:sqlite` | 确认当前终端运行的 Node 版本。换用满足要求的版本，再安装依赖 |
| 端口 4310 已被占用 | 退出旧实例，或用 `PORT=4311 npm run start:web` 指定新端口，再访问该端口 |
| 网页可打开，派发时报找不到 Pi | 在启动服务的同一个终端确认 `pi --version`，再重启服务 |
| 提供商、模型或认证报错 | 对照岗位 provider/model 与 Pi 的认证；不要仅在 Pi 中切换模型后重试 |
| 缺少 Skill、扩展或 MCP 工具 | 核对角色能力报告与实际配置；导入模板不会自动安装依赖 |
| 保存的会话文件损坏或丢失 | 停止该事项，保留报错并按备份恢复对应文件；当前没有一键重置入口 |

查找启动参数请看[配置参考](../reference/configuration.md)。要迁移或恢复运行数据，请先阅读[备份步骤](../guides/team-administration.md#保存与备份运行资料)。
