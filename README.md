# Personal Agent

面向跨项目工作的 **AI 角色团队**：成员拥有稳定的岗位身份，按需要组建团队，跨多个产品与仓库工作。初始提供市场与营销、产品、研发、测试四个示例角色；持续成长（RSI）与公开人才市场仍是后续目标。

当前已基于 **Pi (`pi --mode rpc`)** 实现工作台、持久会话接续、模型可调用的内部委托与显式成果归档。实现边界与协议说明见 [运行与协作机制](docs/runtime-collaboration.md)。

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
├── skills/                         # 初始角色声明对应的可加载 Pi Skills
├── roles/                          # 可分享的角色 Markdown 定义
│   ├── marketing-lead.md           # 市场与营销负责人
│   ├── product-manager.md          # 产品经理（默认主要联系人）
│   ├── engineering-manager.md      # 研发经理
│   └── qa-manager.md               # 测试经理
├── src/
│   ├── index.ts                    # 公开导出入口
│   ├── roles/                      # 角色模板解析与序列化
│   ├── storage/                    # 基于 node:sqlite 的双轨状态存储
│   ├── orchestrator/               # TeamOrchestrator（按事找人、内部委托、交付归拢）
│   ├── server/                     # HTTP/SSE 服务、DialogBroker 与独立预览管理器
│   ├── rpc/
│   │   ├── jsonl.ts                # 严格按 LF (\n) 分帧的 JSONL 读写
│   │   ├── types.ts                # Pi RPC 命令、事件与 Extension UI 协议类型
│   │   └── pi-rpc-worker.ts        # PiRpcWorker（并发关联、agent_settled、双向 UI 确认）
│   └── demo/
│       └── rpc-smoke.ts            # 阶段一实机 RPC 冒烟脚本
├── web/                            # 阶段三 React 19.3 Grok-Bot 风格双栏工作台前端（HashRouter + MarkdownView）
├── scripts/
│   └── build-web.mjs               # 基于 esbuild 的前端构建脚本
├── test/
│   ├── pi-rpc-worker.test.ts       # JSONL 拆帧与 PiRpcWorker 协议单元测试
│   ├── phase2-orchestrator.test.ts # 阶段二角色模板、记忆隔离与编排测试
│   └── phase3-server.test.ts       # 阶段三 HTTP/SSE、阻塞审批与独立预览服务测试
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

# 构建后端 dist/ 与前端 web/dist/
npm run build

# 使用隔离数据库核对源码和构建后的服务入口
npm run check:startup

# 启动阶段三 V4 工作台服务（默认 http://127.0.0.1:4310）
npm run start:web

# 运行阶段一实机冒烟测试（调用本机 pi --mode rpc 与 kimi-for-coding）
npm run demo:rpc

# 真实模型协作与跨进程接续验证，使用临时目录、独立数据库与会话
npm run demo:team
```

## 阶段进展

- [x] 产品方向确认、V1–V4 概念原型演进及 Grok Bot 调研（见 [docs/product-direction.md](docs/product-direction.md)）
- [x] 技术架构与四阶段规划落盘（见 [docs/architecture-and-plan.md](docs/architecture-and-plan.md)）
- [x] **阶段一**：`PiRpcWorker` 闭环实现、Biome + TS 严格基线、单元测试与实机 `kimi-for-coding` 冒烟验证
- [x] **阶段二**：四角色 Markdown 模板、SQLite 双轨存储（Matter / Deliverable / 私有记忆）与按事找人编排路由
- [x] **阶段三**：Grok-Bot 风格双栏工作台（React 19 + HashRouter + MarkdownView）、HTTP/SSE 实时流与任务中断、团队成员与能力包导入/导出、空闲时工作区切换及独立服务预览链接
- [x] **运行闭环补齐**：按事项、成员、工作区恢复 Pi 会话，内部委托工具、运行能力核查与显式成果归档
- [ ] **阶段四**：RSI 经验提炼流水线与人才市场角色能力包分享

## 连续工作与内部协作

同一事项的后续消息默认保留负责人和工作区，并打开确切的 Pi session 文件。正常退出或进程重启后都可由下一条用户消息接续。不同事项、工作区及成员各自保存会话；切回原工作区接回原现场。正在执行时请先停止，再补充要求或切换工作区，服务会以 HTTP 409 拒绝重叠执行。

成员通过 `delegate_to_member` 请求其他已存在成员完成专业工作，并把其结果整合给用户。内部请求、结果与错误进入折叠的协作过程。主成员在形成可审阅的阶段成果、明确版本或实质变化时，才用 `publish_deliverable` 归档正式文档、实际文件或服务链接，并记录变化依据。普通聊天、需求澄清和细小调整只保存对话；内部同事把结果返回主成员，由主成员整合。停止或失败的本轮不会归档暂存草稿。

角色 `skills` 现在指向实际的 `SKILL.md` 文件，缺失时明确报错。初始工具按 `tools` 声明装配，必要的团队工具自动加入。自定义工具由运维者通过 `PA_PI_EXTENSIONS` 指定本地 Pi 扩展，多个路径按系统路径分隔符连接；`mcpDependencies` 使用现有 Pi 配置中的服务器名。工具和依赖均须通过实际运行清单核查，导入角色定义不会自动安装依赖。

公司与项目私有记忆需要绑定工作区才自动注入。历史上没有工作区的私有记忆仍可在团队页查看，但不会作为全局背景加入执行；目前尚无组织身份模型。完整边界、迁移规则和实机证据见 [运行与协作机制](docs/runtime-collaboration.md)。
