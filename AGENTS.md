# Personal Agent 开发导航

本项目是跨项目工作的轻量 AI 岗位团队，采用**三环硬边界多包架构**（`packages/contracts`、`packages/server`、`apps/web` + 薄入口 `apps/cli`）与**双半边扩展体系**（`pi-extensions/*` + `pa-extensions/*`），坚持通过**本机 Pi RPC 子进程**驱动、“喂养而不自造（Influence by feeding, never by assembling）”并直接复用原生 Pi 生态包。当前能力及后续计划见[文档入口](docs/README.md)，不要把长期自主运行、完整 RSI 或人才市场写成已完成。

人类贡献者从[贡献指南](CONTRIBUTING.md)和[开发指南](docs/guides/development.md)开始；执行环境、私有数据及网络边界见[安全说明](SECURITY.md)。

## 按任务阅读

先读最近相关目录的 README，再按其中链接进入源码或运行说明，无须每次通读产品讨论和全部 Skills。

| 任务 | 从这里开始 |
| --- | --- |
| 后端引擎与跨模块改动 | [packages/server/src/README.md](packages/server/src/README.md)、[packages/pi-rpc/README.md](packages/pi-rpc/README.md) |
| 共享 Wire 契约与扩展 SDK | [packages/contracts/README.md](packages/contracts/README.md)、[packages/extension-api/README.md](packages/extension-api/README.md)、[packages/extension-sdk/README.md](packages/extension-sdk/README.md) |
| 网页工作台交互与展示 | [apps/web/README.md](apps/web/README.md) → [前端源码](apps/web/src/README.md) |
| CLI 薄启动器 | [apps/cli/README.md](apps/cli/README.md) |
| 宿主扩展与便携 Pi 扩展 | [pa-extensions/README.md](pa-extensions/README.md)、[pi-extensions/README.md](pi-extensions/README.md) |
| 角色定义或 Skill | [roles/README.md](roles/README.md)、[pi-extensions/role-skills/README.md](pi-extensions/role-skills/README.md)；解析代码在 [packages/server/src/roles/](packages/server/src/roles/README.md) |
| 测试、脚本或实机验证 | [test/README.md](test/README.md)、[scripts/README.md](scripts/README.md)、[demo](packages/server/src/demo/README.md) |
| 产品、架构或历史依据 | [docs/README.md](docs/README.md)，按问题进入当前说明或历史记录 |
| 复盘事项、角色执行与 PA 架构 | [事项与架构复盘 Skill](.agents/skills/pa-matter-retrospective/SKILL.md) |

## 开发与验证

命令均在仓库根运行，脚本定义以 [package.json](package.json) 为准。

- `npm install` 安装依赖并链接工作区包；`npm run start:web` 启动本地工作台，默认使用 `.data/` 中的用户数据；`npm run start:team:sandbox` 在临时目录启动预置多组织、全角色（`org_owner`/`org_admin`/`org_member`/`org_viewer`/`super_admin`）与带 Git 版本的资料空间文档的团队版隔离沙盒（`PA_REQUIRE_AUTH=1`，默认端口 `4399`，账号表见 [开发指南](docs/guides/development.md#团队版一键验证沙盒)）。
- 代码改动选择相关离线测试，再运行 `npm run check`（含 `lint`、`typecheck` 与三环边界门禁 `check:boundaries`）、`npm run build`、`npm test`；首次运行涉及网页的测试前要构建网页资源；涉及团队页面、多组织或成果库交互且不污染 `.data/` 时，可直接启动 `npm run start:team:sandbox` 主动完成页面验证。
- `npm run check:startup` 需要已有构建，使用临时数据库检查源码入口（`apps/cli/src/main.ts`）和预构建入口（`apps/cli/dist/main.js`），不调用真实模型。
- 文档改动使用 `npm run check:docs`；无需因此重跑整套应用测试或真实模型。
- `demo:rpc`、`demo:team`、`demo:team:capabilities`、`demo:space`、`demo:rsi`（`demo:trust`）、`demo:pi-native`、`demo:review`、`demo:observer`、`demo:architect`、`demo:roles`、`demo:decision`、`demo:pstack`、`demo:pstack:selection` 会调用本机 Pi 与真实模型，按 [demo 说明](packages/server/src/demo/README.md)选择，不能把离线 fixture 通过当作真实岗位能力证明。

## 顺着 Pi 纹理生长

设计、实现与审查新功能时，优先复用 Pi 原生机制而非在宿主另造平行抽象：

- **优先用 Pi 原语**：持久上下文走 `--session` 与 `session_compact`（不靠宿主手工拼 `transcript`）；可复用流程/脚本走磁盘标准 `SKILL.md` + `scripts/*` + `--skill` 发现（不另建数据库经验表）；运行时门禁与人机确认走 `tool_call` hook 与 `ctx.ui` / `DialogBroker`（不靠提示词声明替代实际约束）。
- **静态边界靠 CLI flags，不粗暴阉割宿主机生态**：通过 `--offline` / `--no-extensions` / `--no-approve` / `--skill` / `--tools` 控制边界；区分“宿主机管理员维护的 `~/.pi`”（可由 `PA_LOCAL_PI_RESOURCES` 三态按需继承）与“外部托管克隆仓”（保持隔离），避免多租户策略一刀切切断 Pi 生态。
- **辅助通道宁紧勿松、避免双轨**：无 `DialogBroker` 审批通道的一次性辅助调用（如 `architect-aux`）仅开放只读工具（`read,grep,find,ls`），长期演进应收敛回标准持久会话而非维护平行管道。
- **展示与真实运行参数对齐**：`runtime-info`、文档和 Web 面板必须直接反映实际传给 Pi 的 flags、hooks 与作用域边界，删除旧能力时同步清理残留展示与类型，不留幽灵抽象。
- **真机纹理用真实 Pi 验证**：涉及 Skill 发现、`tool_call` 拦截、会话压缩续接或扩展装配的改动，除离线测试外还应按需跑 `demo:pi-native` / `demo:trust` 等真实 Pi 冒烟验证，不能只凭 mock 断定闭环成立。

## 改动边界

先查看 Git 状态，保留用户和其他工具的改动。用户授权范围内的实现与必要优化直接推进，常规取舍不用另设审批流程；没有明确授权不推送远端或发送外部消息。

验证读写变更、多账号切换或权限边界时使用临时工作区、数据库、会话或 `npm run start:team:sandbox`，保护 `.data/`、已登记业务仓库及本地未入库的 `.notes/`（早期 V1–V4 原型与参考研究）；仅做不改写数据的只读展示排查时，可直接复用 `.data/` 已有工作台。源码和可分享定义中不加入私有工作背景、会话内容或密钥。Pi 本机权限不构成沙箱。

会话范围、真实委托、内部成员不能发布、正式成果才归档等规则分别由编排与运行模块维护；修改前沿 README 找到拥有该规则的源码，避免用提示词声明替代实际能力。同步受影响的局部说明与 CHANGELOG，报告验证范围和保留限制。
