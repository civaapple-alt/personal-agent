# 开发指南

克隆仓库并启动工作台，找到要修改的模块，再为改动选择验证方式。准备提交补丁时，请按[贡献指南](../../CONTRIBUTING.md)创建分支和 Pull Request。

## 准备本地环境

安装 Git、Node.js 22.19.0 或更新版本，以及 npm。用 Git 检出开发分支，从仓库根安装依赖并启动合成数据工作台。

```bash
git clone https://github.com/civaapple-alt/personal-agent.git
cd personal-agent
npm ci
npm run start:team:sandbox
```

打开 `http://127.0.0.1:4399/#/deliverables`，用 `owner@alpha.local` 和默认测试密码 `Sandbox123!` 登录。资料空间应显示合成文档及 Git 版本。按 `Ctrl+C` 停止服务。这个流程启动临时团队数据，查看页面与切换账号无需安装 Pi 或配置模型。

要查看一个从空白状态开始的个人工作台，请在全新检出目录运行 `npm run start:web`，打开 `http://127.0.0.1:4310`。这个命令会使用检出目录的 `.data/`。开发账号权限、迁移和写入行为时请使用隔离数据。

### 团队版一键验证沙盒

该命令构建网页，在系统临时目录创建团队账号、仓库和成果，并启用 `PA_REQUIRE_AUTH=1`。按默认方式退出时，脚本清理临时目录。

- **默认入口**：`http://127.0.0.1:4399/#/deliverables`（超管后台 `http://127.0.0.1:4399/#/admin`，启动日志另打印一条可用的 `Alpha Studio` `?invite=orginv_...` 邀请链接）。
- **常用参数**：`--port=<端口>`、`--host=<地址>`、`--dir=<目录>`（保留目录并在二次启动时幂等跳过重复灌库）、`--keep`、`--password=<密码>`（默认 `Sandbox123!`，可通过 `PA_SANDBOX_PASSWORD` 覆盖，至少 8 位）、`--seed-only`、`--help`。
- **预置成果样本（共 6 条交付版本）**：
  - `Alpha Studio / Alpha Platform`（`org`）：《Q4 发布计划与灰度架构》`V1 → V2` 版本演进、V1 正向验收评价，以及对应组织空间/仓库空间的 Git 版本文档与信任策略样本。
  - `Alpha Studio / Alpha Platform`（`private`）：《高风险灰度应急预案》（仅发起人、`Alpha 成员` 与 `Alpha Studio` 管理员可见）。
  - `Alpha Studio / Alpha Secret`（`restricted`）：《核心密钥轮换与审计清单》（仅受限仓库授权成员可见）。
  - `Beta Labs / Beta App`（`org`）：《Beta 开放平台接口规范》`V1 → V2` 版本演进。

| 预设账号 | 统一密码（默认） | 角色与成员关系 | 典型验证范围 |
| --- | --- | --- | --- |
| `admin@sandbox.local` | `Sandbox123!` | `super_admin` | `#/admin` 平台配置、全局可见范围及待审核账号 `pending@sandbox.local`（`pending_review`）审批 |
| `owner@alpha.local` | `Sandbox123!` | `Alpha Studio` `org_owner` + `Beta Labs` `org_member` | 全量 6 条跨组织成果、组织/范围筛选、切换 `成果访问范围`、V1→V2 与提交反馈 |
| `admin@alpha.local` | `Sandbox123!` | `Alpha Studio` `org_admin` | Alpha 内共享/私密/受限成果管理与版本审阅 |
| `member@alpha.local` | `Sandbox123!` | `Alpha Studio` `org_member`（受邀私密/受限） | 可见 Alpha 全部 3 组交付物（含受邀私密与受限仓库） |
| `peer@alpha.local` | `Sandbox123!` | `Alpha Studio` `org_member` | 仅见 Alpha 公开共享成果，屏蔽私密、受限与 Beta |
| `viewer@alpha.local` | `Sandbox123!` | `Alpha Studio` `org_viewer` | 只读视图：无「继续修改」「记录验收」及范围修改入口 |
| `owner@beta.local` | `Sandbox123!` | `Beta Labs` `org_owner` | 仅见 `Beta Labs` 成果，不可访问 `Alpha Studio` |

## 找到行为所属模块

| 要修改的行为 | 首先阅读 |
| --- | --- |
| 事项主责、委托、上下文、取消与成果收尾 | [编排核](../../packages/server/src/orchestrator/README.md) |
| Pi RPC、事件、扩展桥接与工具能力 | [RPC](../../packages/server/src/rpc/README.md) |
| 数据模式、历史记录、资料空间与信任策略 | [存储](../../packages/server/src/storage/README.md) |
| HTTP、SSE、邀请、文件/图片与预览 | [服务](../../packages/server/src/server/README.md) |
| 页面与 API 消费 | [网页](../../apps/web/README.md) → [源码](../../apps/web/src/README.md) |
| 岗位及方法资产 | [roles](../../roles/README.md)、[role-skills](../../pi-extensions/role-skills/README.md) |
| 定义解析、序列化与能力目录 | [角色解析](../../packages/server/src/roles/README.md) |

后端使用 TypeScript 和 Node.js 自带的 SQLite，前端用 React 和 esbuild 构建。修改源码后重新构建。`apps/cli/dist/main.js` 和 `apps/web/dist/` 会由构建生成。命令和依赖见 [package.json](../../package.json)。

从维护该行为的模块开始。修改 HTTP 接口时，同时检查服务端返回值和前端调用。调整数据库结构时，验证已有数据可以升级。跨模块的数据流见[架构说明](../concepts/architecture-and-plan.md)。

## 选择验证范围

先用[相关测试](../../test/README.md)或本地页面复现问题。按改动选择检查。

| 改动 | 运行或核对 |
| --- | --- |
| 仅修改文档 | `npm run check:docs`，核对本地链接、章节锚点、命令名和导航可达性 |
| 修改代码 | 依次运行 `npm run check`、`npm run build` 和 `npm test`。先构建网页资源，再运行依赖网页资源的测试 |
| 修改服务入口或打包 | 构建后运行 `npm run check:startup`，用临时数据检查源码和编译后的入口 |
| 修改工作台交互 | 启动上面的团队沙盒，实际走一遍受影响的页面和角色权限 |
| 修改 Pi、工具调用或协作行为 | 先运行相关离线测试。需要验证真实模型调用时，再按下一节选择演示 |

例如，要复跑会话接续与委托的离线测试，请在仓库根运行以下命令。

```bash
node --test test/continuity-collaboration.test.ts
```

离线测试使用受控模型响应。CI 的触发条件、平台和命令见[工作流](../../.github/workflows/ci.yml)，各次执行结果见 [GitHub Actions](https://github.com/civaapple-alt/personal-agent/actions/workflows/ci.yml)。

## 按需运行真实模型验证

安装本机 Pi CLI 并配置任务所用岗位的模型后，从[演示命令](../../packages/server/src/demo/README.md)中选择与改动对应的场景。以下命令验证真实委托、服务重启后接续会话及成果发布。

```bash
npm run demo:team
```

命令使用本机 Pi 和模型额度，在系统临时目录保留合成仓库、会话与观察结果。需要核对成果正文时，请独立检查产物。

需要验证新行为时，优先给 smoke 一个有固定问题和可观察结果的合成任务，保留原始输出、工具时序、文件及版本事实。结果分清执行、场景约束与语义质量；要求独立审阅的演示中，退出码 `2` 表示待审阅，不能写成通过。不要修改问题或只增加咨询次数后宣称修复质量提高。

## 同步文档与变更记录

先确定读者及其要完成的任务，再按[文档索引](../README.md#维护文档)选择目录。从索引或已有指南链接到新增文档。

改行为时更新对应模块 README，参数变化更新[配置参考](../reference/configuration.md)，跨模块边界变化更新[架构](../concepts/architecture-and-plan.md)或[运行与协作参考](../reference/runtime-collaboration.md)。在 [CHANGELOG.md](../../CHANGELOG.md) 的 Unreleased 记录用户可观察到的改变及重要限制。

文档命令从仓库根执行，示例使用占位路径和合成数据。不要将本机绝对路径、真实公司资料、密钥或会话原文写入共享岗位与公开文档。保留失败证据的含义，原型按版本追加，不覆盖旧图。

## 准备本地分发

在干净、已提交的快照上运行：

```bash
npm run check:opensource -- --history
npm run package:release -- --preview
```

第一个命令是有限模式的只读检查，不是完整秘密或权利审计。第二个在隔离快照中构建，再解压验证源码与编译入口，生成提交级预览及校验清单；不会创建版本标签或推送。

已发布版本的范围和下载见 [0.8.3 发布说明](../releases/v0.8.3.md)、[0.8.2 发布说明](../releases/v0.8.2.md)、[0.8.1 发布说明](../releases/v0.8.1.md) 与 [0.8.0 发布说明](../releases/v0.8.0.md)（0.7.0 数据基线说明见 [0.7.0 发布说明](../releases/v0.7.0.md)）。首次公开时的历史和许可处理见 [0.6.0 发布说明](../releases/v0.6.0.md)。正式目录中的旧产物保留原样。`export-ignore` 只作用于归档，公开推送前还需核对可达的 Git 历史。
