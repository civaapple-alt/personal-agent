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

[CI 配置](../.github/workflows/ci.yml) 在 `pull_request`、`v*` 版本标签推送及手动 `workflow_dispatch` 时触发（常规推送 `main` 分支不自动消耗 CI 配额），在 Linux/macOS 声明 Node 22.19 与 26 的检查、构建、离线测试、启动、文档、开源审查和预览包验证；Windows 声明构建、启动及预览验证。工作流文件存在不等于远端检查已执行，Windows 不运行完整测试套件。当前本机已验证 macOS 的 Node 22.19.0 与 26.10.0，不能据此宣称其他系统验证通过。

开发真实 AI 执行与运行 `demo:*` 任务必须另装本地 Pi CLI；它是当前唯一执行底座，不由 `npm ci` 安装。多平台安装与产品说明以 [pi.dev](https://pi.dev/) 为入口，模型匹配及本项目验证基线见[首次运行](getting-started.md)。离线测试的受控 Worker 不构成替代执行底座。

需要实际操作工作台时运行 `npm run start:web`。它会使用默认 `.data/`，已有用户数据的检出目录适合做不写改数据的只读排查，不要直接拿来做破坏性实验。若要快速验证团队版多组织权限、审核后台与多版本成果库交互而不影响 `.data/`，运行 `npm run start:team:sandbox`（详见下方[团队版一键验证沙盒](#团队版一键验证沙盒)）。`check:startup` 自动使用临时库、模板目录和端口，适合验证启动；它不会证明模型协作可用。

### 团队版一键验证沙盒

运行以下命令可在系统临时目录启动完整的团队版隔离沙盒（自动构建网页并启用 `PA_REQUIRE_AUTH=1`，退出后自动清理临时目录，不调用真实模型、不触碰 `.data/`）：

```bash
npm run start:team:sandbox
```

- **默认入口**：`http://127.0.0.1:4399/#/deliverables`（超管后台 `http://127.0.0.1:4399/#/admin`，启动日志另打印一条可用的 `Alpha Studio` `?invite=orginv_...` 邀请链接）。
- **常用参数**：`--port=<端口>`、`--host=<地址>`、`--dir=<目录>`（保留目录并在二次启动时幂等跳过重复灌库）、`--keep`、`--password=<密码>`（默认 `Sandbox123!`，可通过 `PA_SANDBOX_PASSWORD` 覆盖，至少 8 位）、`--seed-only`、`--help`。
- **预置成果样本（共 6 条交付版本）**：
  - `Alpha Studio / Alpha Platform`（`org`）：《Q4 发布计划与架构方案》`V1 → V2` 版本演进、V1 正向验收评价、已注入并关联的 `company_private` 组织经验与 1 条待核验 `candidate` 经验。
  - `Alpha Studio / Alpha Platform`（`private`）：《高风险灰度应急预案》（仅发起人、`Alpha 成员` 与 `Alpha Studio` 管理员可见）。
  - `Alpha Studio / Alpha Secret`（`restricted`）：《核心密钥轮换与审计清单》及仓库级 `project_private` 经验。
  - `Beta Labs / Beta App`（`org`）：《Beta 开放平台接口规范》`V1 → V2` 版本演进。

| 预设账号 | 统一密码（默认） | 角色与成员关系 | 典型验证范围 |
| --- | --- | --- | --- |
| `admin@sandbox.local` | `Sandbox123!` | `super_admin` | `#/admin` 平台配置、全局可见范围及待审核账号 `pending@sandbox.local`（`pending_review`）审批 |
| `owner@alpha.local` | `Sandbox123!` | `Alpha Studio` `org_owner` + `Beta Labs` `org_member` | 全量 6 条跨组织成果、组织/范围筛选、切换 `成果访问范围`、V1→V2 与候选经验核验 |
| `admin@alpha.local` | `Sandbox123!` | `Alpha Studio` `org_admin` | Alpha 内共享/私密/受限成果管理与组织经验复盘 |
| `member@alpha.local` | `Sandbox123!` | `Alpha Studio` `org_member`（受邀私密/受限） | 可见 Alpha 全部 3 组交付物（含受邀私密与受限仓库） |
| `peer@alpha.local` | `Sandbox123!` | `Alpha Studio` `org_member` | 仅见 Alpha 公开共享成果，屏蔽私密、受限与 Beta |
| `viewer@alpha.local` | `Sandbox123!` | `Alpha Studio` `org_viewer` | 只读视图：无「继续修改」「记录验收」及范围修改入口 |
| `owner@beta.local` | `Sandbox123!` | `Beta Labs` `org_owner` | 仅见 `Beta Labs` 成果，不可访问 `Alpha Studio` |

## 找到行为所属模块

| 要修改的行为 | 首先阅读 |
| --- | --- |
| 事项主责、委托、上下文、取消与成果收尾 | [编排核](../src/orchestrator/README.md) |
| Pi RPC、事件、扩展桥接与工具能力 | [RPC](../src/rpc/README.md) |
| 数据模式、历史记录、版本和经验范围 | [存储](../src/storage/README.md) |
| HTTP、SSE、邀请、文件/图片与预览 | [服务](../src/server/README.md) |
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

当前版本的范围和下载见 [0.6.2 发布说明](releases/v0.6.2.md)。首次公开时的历史和许可处理见 [0.6.0 发布说明](releases/v0.6.0.md)。正式目录中的旧产物保留原样。`export-ignore` 只作用于归档，公开推送前还需核对可达的 Git 历史。
