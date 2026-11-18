# 开发指南

本文用于准备开发环境、找到规则拥有者并完成验证。产品使用见[使用指南](user-guide.md)，贡献范围和提交材料见[贡献指南](../CONTRIBUTING.md)。

## 准备本地环境

在项目根目录运行：

```bash
npm ci
npm run check
npm run build
npm test
npm run check:startup
```

使用 Node.js ≥ 22.19；当前验证环境见[首次运行](getting-started.md)。离线检查不要求 Pi 认证，不发起真实模型请求。网页测试需要构建资源，以上顺序已包含构建。

[CI 配置](../.github/workflows/ci.yml) 在 Linux/macOS 声明 Node 22.19 与 26 的检查、构建、离线测试、启动、文档、开源审查和预览包验证；Windows 声明构建、启动及预览验证。工作流文件存在不等于远端检查已执行，Windows 不运行完整测试套件。当前本机已验证 macOS 的 Node 22.19.0 与 26.10.0，不能据此宣称其他系统验证通过。

开发真实 AI 执行与运行 `demo:*` 任务必须另装本地 Pi CLI；它是当前唯一执行底座，不由 `npm ci` 安装。多平台安装与产品说明以 [pi.dev](https://pi.dev/) 为入口，模型匹配及本项目验证基线见[首次运行](getting-started.md)。离线测试的受控 Worker 不构成替代执行底座。

需要实际操作工作台时运行 `npm run start:web`。它会使用默认 `.data/`，已有用户数据的检出目录不要直接拿来做破坏性开发实验。`check:startup` 自动使用临时库、模板目录和端口，适合验证启动；它不会证明模型协作可用。

## 找到行为所属模块

| 要修改的行为 | 首先阅读 |
| --- | --- |
| 事项主责、委托、上下文、取消与成果收尾 | [编排核](../src/orchestrator/README.md) |
| Pi RPC、事件、扩展桥接与工具能力 | [RPC](../src/rpc/README.md) |
| 数据模式、历史记录、版本和经验范围 | [存储](../src/storage/README.md) |
| HTTP、SSE、邀请、图片与预览 | [服务](../src/server/README.md) |
| 页面与 API 消费 | [网页](../web/README.md) → [源码](../web/src/README.md) |
| 岗位及方法资产 | [roles](../roles/README.md)、[skills](../skills/README.md) |
| 定义解析、序列化与能力目录 | [角色解析](../src/roles/README.md) |

技术基线为严格 TypeScript、Node 原生 TS 与编译输出、`node:sqlite`、React、esbuild、Biome 和 `node:test`。依赖版本、脚本和约束以 [package.json](../package.json)、lockfile 与 [AGENTS.md](../AGENTS.md) 为准。不要编辑 `dist/` 或 `web/dist/`。

先在拥有规则的模块修复，再核对调用方、持久数据与网页契约。接口形状改变时同时检查服务 DTO 和前端消费者；新增存储字段采用幂等迁移，保留旧记录，不猜测历史组织或会话归属。架构关系见[架构说明](architecture-and-plan.md)。

## 选择验证范围

先复现问题，再选[行为测试](../test/README.md)。例如，会话接续与真实委托结构的离线回归为：

```bash
node --test test/continuity-collaboration.test.ts
```

代码修改完成后运行 `npm run check`、`npm run build` 和 `npm test`。入口或打包变化另跑 `npm run check:startup`；网页交互变化还需实际查看相应页面。纯文档修改运行 `npm run check:docs`，不用因此重跑真实模型或整套应用测试。

离线测试使用临时工作区、数据库、会话和端口，在失败和取消后清理。`PA_DB_PATH` 并不迁移全部运行路径，不能只改这个变量就宣称与用户数据完全隔离，参见[配置参考](configuration.md)。

## 按需运行真实模型验证

只有需要证明真实模型与工具路径时才选择 [demo](../src/demo/README.md)，例如：

```bash
npm run demo:team
```

此命令使用本机 Pi 和模型额度，验证真实委托、宿主重启后的会话回忆及显式发布，证据保留在系统临时目录。它不访问已登记业务仓库，不代替正文质量验收。

需要验证新行为时，优先给 smoke 一个有固定问题和可观察结果的合成任务，保留原始输出、工具时序、文件及版本事实。结果分清执行、场景约束与语义质量；要求独立审阅的演示中，退出码 `2` 表示待审阅，不能写成通过。不要修改问题或只增加咨询次数后宣称修复质量提高。

## 同步文档与变更记录

改行为时更新对应目录 README，参数变化更新[配置参考](configuration.md)，跨模块边界变化更新[架构](architecture-and-plan.md)或[运行说明](runtime-collaboration.md)。在 [CHANGELOG.md](../CHANGELOG.md) 的 Unreleased 记录用户可观察到的改变及重要限制。

文档命令从仓库根执行，示例使用占位路径和合成数据。不要将本机绝对路径、真实公司资料、密钥或会话原文写入共享岗位与公开文档。保留失败证据的含义，原型按版本追加，不覆盖旧图。

## 准备本地分发

在干净、已提交的快照上运行：

```bash
npm run check:opensource -- --history
npm run package:release -- --preview
```

第一个命令是有限模式的只读检查，不是完整秘密或权利审计。第二个在隔离快照中构建，再解压验证源码与编译入口，生成提交级预览及校验清单；不会创建版本标签或推送。

正式发布的范围、许可、素材历史及待办见 [0.6.0 准备说明](releases/v0.6.0.md)。贡献代码不自动授权发布；正式目录中的旧产物不覆盖，Git 推送也不受 `export-ignore` 素材排除规则保护。
