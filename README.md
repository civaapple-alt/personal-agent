# Personal Agent

面向跨项目工作的 **AI 角色团队**：成员按固定岗位组织（市场与营销负责人、产品经理、研发经理、测试经理），跨多个产品与仓库协作履职，并在日常工作中持续成长（RSI）及沉淀可分享的能力模板。

当前阶段正在基于 **Pi (`pi --mode rpc`)** 推进阶段一至阶段四落地。

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
| **前端工作台（阶段三目标）** | `React 19.3.x` + `@earendil-works/elanor-react` / `design-tokens`（对齐 Pi `apps/p2`） | 配合 `marked` / `lowlight` / `grok-mermaid` 渲染交付预览与 V4 界面 |

## 目录结构

```text
personal-agent/
├── docs/
│   ├── product-direction.md        # 产品方向确认稿
│   ├── product-discussion.md       # 完整产品讨论演进记录
│   ├── team-roles.md               # 跨项目角色职责草案
│   ├── team-interaction.md         # 集中入口与团队协作设计
│   ├── architecture-and-plan.md    # 基于 Pi RPC 的架构设计与四阶段规划
│   ├── prototypes/                 # V1–V4 交互原型图与演进反馈
│   └── references/                 # Grok Bot 与人才市场调研
├── roles/                          # 可分享的四角色 Markdown 能力模板
│   ├── marketing-lead.md           # 市场与营销负责人
│   ├── product-manager.md          # 产品经理（默认主要联系人）
│   ├── engineering-manager.md      # 研发经理
│   └── qa-manager.md               # 测试经理
├── src/
│   ├── index.ts                    # 公开导出入口
│   ├── roles/                      # 角色模板解析与序列化
│   ├── storage/                    # 基于 node:sqlite 的双轨状态存储
│   ├── orchestrator/               # TeamOrchestrator（按事找人、内部委托、交付归拢）
│   ├── rpc/
│   │   ├── jsonl.ts                # 严格按 LF (\n) 分帧的 JSONL 读写
│   │   ├── types.ts                # Pi RPC 命令、事件与 Extension UI 协议类型
│   │   └── pi-rpc-worker.ts        # PiRpcWorker（并发关联、agent_settled、双向 UI 确认）
│   └── demo/
│       └── rpc-smoke.ts            # 阶段一实机 RPC 冒烟脚本
├── test/
│   ├── pi-rpc-worker.test.ts       # JSONL 拆帧与 PiRpcWorker 协议单元测试
│   └── phase2-orchestrator.test.ts # 阶段二角色模板、记忆隔离与编排测试
├── biome.json                      # Biome 2.3.5 Lint & Format 配置
├── tsconfig.json                   # TypeScript 类型检查配置
└── tsconfig.build.json             # dist/ 构建配置
```

## 快速开始

```bash
# 安装开发依赖
npm install

# 运行代码规范检查（Biome）与 TypeScript 严格类型检查
npm run check

# 自动格式化代码
npm run format

# 运行单元测试
npm test

# 构建 dist/
npm run build

# 运行阶段一实机冒烟测试（调用本机 pi --mode rpc 与 kimi-for-coding）
npm run demo:rpc
```

## 阶段进展

- [x] 产品方向确认、V1–V4 概念原型演进及 Grok Bot 调研（见 [docs/product-direction.md](docs/product-direction.md)）
- [x] 技术架构与四阶段规划落盘（见 [docs/architecture-and-plan.md](docs/architecture-and-plan.md)）
- [x] **阶段一**：`PiRpcWorker` 闭环实现、Biome + TS 严格基线、单元测试与实机 `kimi-for-coding` 冒烟验证
- [x] **阶段二**：四角色 Markdown 模板、SQLite 双轨存储（Matter / Deliverable / 私有记忆）与按事找人编排路由
- [ ] **阶段三**：V4 工作台前端（React 19）、折叠内部协作与独立服务预览链接
- [ ] **阶段四**：RSI 经验提炼流水线与人才市场角色能力包分享
