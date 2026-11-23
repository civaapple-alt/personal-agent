# 安装与首次运行

在自己的电脑上启动工作台，再用虚构资料发起第一次需求讨论。要让同事登录一台共享服务器，请按[团队部署指南](../guides/team-administration.md)操作。要修改源码，请从[开发指南](../guides/development.md)开始。

## 1. 准备环境

安装 Node.js 22.19.0 或更新版本及 Git。从源码安装还需要 npm。

```bash
node --version
git --version
```

## 2. 安装本地 Pi CLI 并配置模型

如果只想查看界面，可先[启动工作台](#3-启动工作台)。发送第一条 AI 消息前，请完成以下设置。

1. 按 [Pi 官网](https://pi.dev/)的说明安装 Pi CLI。
2. 在准备启动工作台的终端执行 `pi --version`。确认终端能找到 `pi`，再运行 `pi` 打开交互界面。
3. 在 Pi 中用 `/login` 配置模型访问，用 `/model` 确认有哪些模型可用。
4. 工作台默认沿用运行服务的系统账号下 Pi 实际选用的模型和思考等级。要为事项单独选择模型，可在输入区的「主责模型」里设置。

使用模型会消耗配置的提供商额度。项目的验证范围见[发布说明](../releases/v0.7.1.md)。

## 3. 启动工作台

### 从预构建包启动

打开 [0.7.1 发布页](https://github.com/civaapple-alt/personal-agent/releases/tag/v0.7.1)，下载 Assets 中的 `personal-agent-0.7.1-prebuilt.tar.gz`。在下载目录解压，再进入包含 `dist/` 和 `roles/` 的目录。预构建包可以直接用 Node.js 启动。

```bash
tar -xzf personal-agent-0.7.1-prebuilt.tar.gz
cd personal-agent-0.7.1
node dist/server/main.js
```

### 从源码启动

用 Git 克隆发布标签，然后在仓库根安装依赖并启动。

```bash
git clone --branch v0.7.1 https://github.com/civaapple-alt/personal-agent.git
cd personal-agent
npm ci
npm run start:web
```

也可以从发布页下载 `personal-agent-0.7.1-source.tar.gz`。解压后进入包含 `package.json` 的目录，执行 `npm ci` 和 `npm run start:web`。

终端显示监听地址后，打开 `http://127.0.0.1:4310`。首次启动默认监听本机回环地址，浏览器直接以本机所有者身份进入工作台。运行数据默认写入启动目录的 `.data/`。按 `Ctrl+C` 停止服务。

## 4. 发起第一次需求讨论

1. 在「新建事项」选择产品经理，输入一项需求，例如“帮我梳理小团队反馈收集工具的首版范围”，然后发送。这一步会调用模型。
2. 等待产品经理整理需求并提出待确认的问题。按需回复，或邀请其他岗位参与。
3. 需要生成工作文件时，可先登记并选择工作区。Pi 和它调用的工具具备当前系统用户的权限。更多操作见[工作台使用指南](../guides/user-guide.md)。

## 5. 处理常见启动问题

| 现象 | 处理方式 |
| --- | --- |
| 提示缺少 `dist/server/main.js` | 先确认已进入预构建包根目录。使用源码包时，安装依赖后执行 `npm run start:web` |
| Node 报告不支持 `node:sqlite` 或 TypeScript | 执行 `node --version`，确认当前终端使用 Node.js 22.19.0 或更新版本 |
| 端口 4310 已被占用 | 停止旧实例，或设置 `PORT` 后重启并打开对应端口。环境变量写法见[启动共享服务](../guides/team-administration.md#启动共享服务) |
| 页面可打开，发送消息时报找不到 Pi | 在启动工作台的终端执行 `pi --version`。修正终端的 `PATH` 后重启工作台 |
| 提供商、模型或认证报错 | 核对 Pi 中的认证及工作台中该岗位的模型配置。改配置后再发送 |

查找其他启动参数请看[配置参考](../reference/configuration.md)。更换版本或恢复数据前先按[备份步骤](../guides/team-administration.md#保存与备份运行资料)保存运行资料。
