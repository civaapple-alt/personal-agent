# Personal Agent 开发导航

本项目是跨项目工作的轻量 AI 岗位团队，使用 TypeScript/Node、React 和本机 Pi RPC。当前能力及后续计划见[文档入口](docs/README.md)，不要把长期自主运行、完整 RSI 或人才市场写成已完成。

人类贡献者从[贡献指南](CONTRIBUTING.md)和[开发指南](docs/guides/development.md)开始；执行环境、私有数据及网络边界见[安全说明](SECURITY.md)。

## 按任务阅读

先读最近相关目录的 README，再按其中链接进入源码或运行说明，无须每次通读产品讨论和全部 Skills。

| 任务 | 从这里开始 |
| --- | --- |
| 后端及跨模块改动 | [src/README.md](src/README.md)，再选对应子模块 |
| 网页交互与展示 | [web/README.md](web/README.md) → [前端源码](web/src/README.md) |
| 角色定义或 Skill | [roles/README.md](roles/README.md)、[pi-extensions/role-skills/README.md](pi-extensions/role-skills/README.md)；解析代码在 [src/roles/](src/roles/README.md) |
| 测试、脚本或实机验证 | [test/README.md](test/README.md)、[scripts/README.md](scripts/README.md)、[demo](src/demo/README.md) |
| 产品、架构或历史依据 | [docs/README.md](docs/README.md)，按问题进入当前说明或历史记录 |
| 复盘事项、角色执行与 PA 架构 | [事项与架构复盘 Skill](.agents/skills/pa-matter-retrospective/SKILL.md) |

## 开发与验证

命令均在仓库根运行，脚本定义以 [package.json](package.json) 为准。

- `npm install` 安装依赖；`npm run start:web` 启动本地工作台，默认使用 `.data/` 中的用户数据；`npm run start:team:sandbox` 在临时目录启动预置多组织、全角色（`org_owner`/`org_admin`/`org_member`/`org_viewer`/`super_admin`）与带 Git 版本的资料空间文档的团队版隔离沙盒（`PA_REQUIRE_AUTH=1`，默认端口 `4399`，账号表见 [开发指南](docs/guides/development.md#团队版一键验证沙盒)）。
- 代码改动选择相关离线测试，再运行 `npm run check`、`npm run build`、`npm test`；首次运行涉及网页的测试前要构建网页资源；涉及团队页面、多组织或成果库交互且不污染 `.data/` 时，可直接启动 `npm run start:team:sandbox` 主动完成页面验证。
- `npm run check:startup` 需要已有构建，使用临时数据库检查源码和构建后的入口，不调用真实模型。
- 文档改动使用 `npm run check:docs`；无需因此重跑整套应用测试或真实模型。
- `demo:rpc`、`demo:team`、`demo:team:capabilities`、`demo:space`、`demo:rsi`、`demo:review`、`demo:observer`、`demo:architect`、`demo:roles`、`demo:decision`、`demo:pstack`、`demo:pstack:selection` 会调用本机 Pi 与真实模型，按 [demo 说明](src/demo/README.md)选择，不能把离线 fixture 通过当作真实岗位能力证明。

## 改动边界

先查看 Git 状态，保留用户和其他工具的改动。用户授权范围内的实现与必要优化直接推进，常规取舍不用另设审批流程；没有明确授权不推送远端或发送外部消息。

验证读写变更、多账号切换或权限边界时使用临时工作区、数据库、会话或 `npm run start:team:sandbox`，保护 `.data/`、已登记业务仓库及本地未入库的 `.notes/`（早期 V1–V4 原型与参考研究）；仅做不改写数据的只读展示排查时，可直接复用 `.data/` 已有工作台。源码和可分享定义中不加入私有工作背景、会话内容或密钥。Pi 本机权限不构成沙箱。

会话范围、真实委托、内部成员不能发布、正式成果才归档等规则分别由编排与运行模块维护；修改前沿 README 找到拥有该规则的源码，避免用提示词声明替代实际能力。同步受影响的局部说明与 CHANGELOG，报告验证范围和保留限制。
