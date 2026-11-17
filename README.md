# Personal Agent

当前版本：**0.5.0**。本地标签为 `v0.5.0`；源码包、预构建包及升级边界见 [发布说明](docs/releases/v0.5.0.md)。

面向跨项目工作的 **AI 角色团队**：成员拥有稳定的岗位身份，按需要组建团队，跨多个产品与仓库工作。初始提供市场与营销、产品、研发、测试四个示例角色；已具备基础 RSI 经验提案、复盘与人工核验链路；长期自主成长与公开人才市场仍是后续目标。

- 当前已基于 **Pi (`pi --mode rpc`)** 实现工作台、持久会话接续、模型可调用的内部委托与显式成果归档。
- 模块关系、当前范围和后续计划见[当前架构与后续计划](docs/architecture-and-plan.md)，协议、迁移与验证细节见[运行与协作机制](docs/runtime-collaboration.md)。

## 为什么做 Personal Agent

- **解决单项目会话割裂**：常规 Coding Agent 以单个项目会话为中心，切换项目时用户必须自己充当产品、研发、测试、市场来拼接上下文。
- **补齐“人本视角”的沉淀与复用**：项目内的 `.md`、`README` 和 `ADR notes` 只记录单个项目的推进轨迹；Personal Agent 将通用岗位能力（可分享给同事或市场）与公司/项目私有记忆拆开，让 AI 成员的能力可以积累并跨团队复用。
- **平时静默、关键找人、交付优先**：过程日志默认折叠，仅在需要人工确认或审批时弹出交互卡片；主视图聚焦可查看、可反馈的交付成果（支持文档、原型与独立服务链接）。

## 技术栈与版本基线（对齐 Pi 仓库规范）

参考本地 Pi Monorepo（`pi-source`）的工程规范与依赖基线：

| 层面 | 选型与版本基线 | 说明 |
| --- | --- | --- |
| **Node.js** | `>= 22.19.0`（当前实测 `v26.10.0`） | 与 Pi CLI 及 Monorepo 要求保持一致 |
| **Pi CLI / 执行底座** | `pi` `1.5.2`（`pi --mode rpc`） | 按项目 `cwd` 子进程隔离执行，默认验证模型 `kimi-coding / kimi-for-coding` |
| **TypeScript** | 严格模式（`strict: true`、`erasableSyntaxOnly: true`、`verbatimModuleSyntax: true`） | 支持 Node 原生 TS 运行及 `dist/` 编译输出 |
| **Linter / Formatter** | `@biomejs/biome` `2.3.5` | 对齐 Pi 的 `biome.json`（Tab 缩进、120 列宽、`useConst`） |
| **测试框架** | `node:test` + `node:assert/strict` | 零额外依赖，与 Pi 脚本及单元测试风格一致 |
| **前端工作台（阶段三已实现）** | `React 19.3.0` + `esbuild` + 原生 CSS（Grok Bot 风格双栏布局） | 内置 `hashRouter.ts`、`MarkdownView.tsx` 与 SSE 实时流渲染 |

## 按需阅读导航

开发代理先读 [AGENTS.md](AGENTS.md)，然后进入最相关目录；每层 README 只展开本层职责，再链接源码和更深说明。

| 要做的事 | 入口 |
| --- | --- |
| 修改后端行为 | [src/README.md](src/README.md)，再进入编排、RPC、存储或服务模块 |
| 修改网页 | [web/README.md](web/README.md) → [前端源码](web/src/README.md) |
| 调整可分享岗位定义 | [roles/README.md](roles/README.md)；解析代码另见 [src/roles](src/roles/README.md) |
| 编辑具体工作方法 | [skills/README.md](skills/README.md)，按需打开对应 `SKILL.md` |
| 查阅环境变量、超时与运行参数 | [docs/configuration.md](docs/configuration.md) |
| 了解当前产品、架构或历史 | [docs/README.md](docs/README.md) |
| 选择离线或真实模型验证 | [test/README.md](test/README.md)、[demo](src/demo/README.md) |
| 构建、启动或检查文档 | [scripts/README.md](scripts/README.md)、[package.json](package.json) |

## 快速开始

命令均从仓库根运行，Node 与本机 Pi 的要求见上表。

```bash
npm install
npm run check
npm run build
npm test

# 启动工作台，默认 http://127.0.0.1:4310，使用已有用户数据库
npm run start:web
```

- 只改文档可运行 `npm run check:docs`；隔离启动检查使用 `npm run check:startup`（需要先构建，不调用模型）。
- 完整说明和针对性验证选择见 [scripts](scripts/README.md) 与 [test](test/README.md)。

`demo:rpc`、`demo:team`、`demo:rsi`、`demo:inner`、`demo:review`、`demo:observer`、`demo:architect`、`demo:roles` 和 `demo:decision` 会调用真实模型，不属于默认检查；使用 `npm run <命令>` 显式执行，范围、临时数据与证据约定见 [demo](src/demo/README.md)。

## 阶段进展

- [x] 产品方向确认、V1–V4 概念原型演进及 Grok Bot 调研（见 [docs/product-direction.md](docs/product-direction.md)）
- [x] 当前架构与后续计划已按源码同步（见 [docs/architecture-and-plan.md](docs/architecture-and-plan.md)）
- [x] **阶段一**：`PiRpcWorker` 闭环实现、Biome + TS 严格基线、单元测试与实机 `kimi-for-coding` 冒烟验证
- [x] **阶段二**：四角色 Markdown 模板、SQLite 双轨存储（Matter / Deliverable / 私有记忆）与按事找人编排路由
- [x] **阶段三**：Grok-Bot 风格双栏工作台（React 19 + HashRouter + MarkdownView）、HTTP/SSE 实时流与任务中断、团队成员与能力包导入/导出、空闲时工作区切换及独立服务预览链接
- [x] **运行闭环补齐**：按事项、成员、工作区恢复 Pi 会话，内部委托工具、运行能力核查与显式成果归档
- [ ] **阶段四**：已完成基础 RSI 经验提炼、核验与验收评估闭环（`propose_experience`、`distillExperiences`、候选/验证/替代生命周期与 UI 审核回写）；夜间后台自主复盘调度与公开人才市场角色分享仍在后续计划中

## 连续工作与正式成果

同事项后续交流默认保留负责人和工作区，恢复确切 Pi 会话。成员可通过真实工具咨询同事并整合结果，内部过程按需查看。普通回复、澄清和细小讨论调整只保留对话；可审阅阶段成果、明确版本或实质变化才正式发布并记录变化依据，不要求用户逐次批准归档。

经验提案随成功主执行统一提交；复盘按工作区证据隔离，验收只评价成果版本关联的经验。注入和正负计数是追踪线索，尚不能证明经验被采用或提升了长期质量。

会话隔离、私有经验、能力装配和失败边界见 [运行说明](docs/runtime-collaboration.md)；变更这些行为先从 [后端地图](src/README.md) 找到拥有规则的模块。角色与 Skill 的存在不代表长期成长或完整岗位能力已经验证。

## 内置演示入口

启动工作台后，在“新建事项”点击“体验内置演示”，即可用“小团队反馈收集盒”体验需求讨论、专业协作、阶段交付与反馈修订。默认工作区为 `.data/inner-matter`，打开时只准备资料，发送提问后才运行模型。详见[演示说明](docs/inner-matter-demo.md)。
