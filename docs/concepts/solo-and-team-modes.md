# 单兵模式（Pi Default + pi-subagents）与 PA 团队协作模式

Personal Agent（PA）开箱即用的核心目标是**跨项目的 AI 岗位协作、经验沉淀（Git Space / Skills）与持续自省演进（RSI）**；同时，PA 也内置了 `Pi Default`（`roles/pi-default.md`，`roleKind: "solo"`），为希望保留原汁原味 Pi 终端直连体验的场景提供一条干净、零摩擦的单兵轨道。

这篇说明澄清两种模式的定位差异、如何与原生 Pi 多子代理扩展（如 [pi-subagents](https://github.com/nicobailon/pi-subagents)）配合，以及在实际工作中的选型与演进路径。

## 1. 两种模式的本质对比

两者并非「谁替代谁」，而是两个不同层级的协作范式：**单操作员的工程算力杠杆** vs **人与 AI 岗位共事的轻量组织**。

| 维度 | 单兵模式：`Pi Default`（可选搭配 `pi-subagents`） | 团队模式：PA 多角色协作（`roleKind: business`） |
| --- | --- | --- |
| **核心隐喻** | **One parent, many focused children**（单操作员的高效终端杠杆） | **人与 AI 岗位共事的轻量组织**（跨事项持久协作与交付） |
| **子代理 / 岗位形态** | 单会话直做；若装 `pi-subagents`，可按任务临时派生短生命周期子会话（`scout` / `worker` / `reviewer` / `oracle` / 并行 worktree） | 持久岗位身份（PM / EM / QA 及自定义角色），有明确职责、`antiJobs`、组织/个人作用域与跨事项能力证据 |
| **上下文与 Prompt Cache** | 极轻：不注入团队名册、能力索引与发布复核话术（实机 `npm run demo:solo` 约 `4.7k` 字符）；`pi-subagents` 采用首调返回 guide 的渐进式披露 | 默认注入极简、缓存稳定的同事能力索引（实机 `npm run demo:solo` 约 `9.2k` 字符，较全量能力卡减少 70% 回合上下文），需要详情时按需调用 `read_team_roles({ includeCapabilities: true })` |
| **PA 扩展能力** | 完整保留：`read_space` / `save_space_page`、`propose_skill`、`visualize`、`request_clarification`、`suggest_next_steps`、`read_team_roles` / `propose_role` | 完整保留上述能力，并额外开启 `delegate_to_member`（真实内部委托）、旁听席（Observer）与独立验收流 |
| **擅长场景** | 需求尚未定型的探索期、单人端到端编码与排查；配合 `pi-subagents` 跑 `clarify → scout → worker → 并行 fresh reviewers`、`review-loop` 或 worktree 并行试错 | 跨职能对齐（需求/架构/实现/验收）、多人类同事共同参与讨论与拍板、高风险变更旁听把关、正式成果归档 |
| **组织治理与 RSI** | 不参与自动业务路由与团队协作体检（RSI），保持单兵轨道纯净 | 核心强项：组织 RBAC 与可见性隔离、人机决策留痕、Skill 四步信任沉淀、Role Architect 与 RSI 团队体检 |

## 2. 系统边界：单兵模式如何做到零摩擦共存

为了避免单兵模式干扰 PA 默认的团队协作与 RSI 主线，`roleKind: "solo"` 在系统层与 `business`、`architect` 并列隔离：

- **不截胡自动分派**：自动路由（`routeMemberForRequest`）仅在 `business` 岗位池中匹配关键词，不会把普通业务请求意外分派给 `pi-default`；仅在用户显式点选 `Pi Default` 时激活。
- **不挂载多余委托与旁听**：`pi-default` 运行时关闭 `delegate_to_member`，建单与前端选人时自动收敛为单人阵型（`aiMemberIds = ["pi-default"]`、`observersEnabled = false`），不显示多角色请教/旁听配置栏，也不会混入其他业务事项的「可请教/旁听」候选列表。
- **不污染 RSI 与团队体检**：`Role Architect` 与团队健康体检（`team-health.ts`）仅审视 `business` 岗位，不会误报 `Pi Default`「职责过宽」或「违反 One Job」。
- **保留自然升级通道**：在单兵事项里仍可直接用 `propose_skill` 沉淀 SOP/脚本，用 `propose_role` 拆出专职角色；当任务需要多岗分工时，新建团队事项或切换至对应业务主责即可。

## 3. 在 `Pi Default` 下搭配 `pi-subagents` 的用法与边界

如果本机 Pi 已安装 `pi-subagents`（`pi install npm:pi-subagents`）：

- **零委托工具冲突**：因为 `Pi Default` 关闭了 PA 的 `delegate_to_member`，装上 `pi-subagents` 后不会出现两套委托工具互相打架的问题。你可以在 `Pi Default` 会话里直接用自然语言调用 `scout` / `reviewer` / `oracle` 或并行 review，同时用 PA 的 `save_space_page`、`propose_skill`、`visualize`、`request_clarification` 完成成果沉淀与展示。
- **需要注意的 3 项工程边界**：
  1. **可观测性与停止联动断层**：`pi-subagents` 的实时舰队视图依赖 Pi TUI 的 `FleetView`（`/subagents-fleet`），而 PA 通过 Pi RPC 驱动（无 TUI）。PA 能记录父会话调用 `subagent` 工具的起止日志，但子代理内部的多步进度不会展开到 PA 的协作过程图（`DelegationGraph`）；若触发了脱离父进程的 detached 后台 runner，在 PA 网页端点击「停止」也无法联动终止该后台进程。
  2. **TUI 斜杠交互不可用**：`/subagents-fleet`、`/subagents-doctor` 等依赖 TUI 交互面板的命令在 Web 端无法直接打开（自然语言触发 `subagent` 工具及提示词工作流可用）。
  3. **团队版多租户隔离边界**：`pi-subagents` 派生的子会话与后台进程不经过 PA 的组织 ACL、事项租约或角色作用域隔离。按 `PA_LOCAL_PI_RESOURCES` 三态策略（见[配置参考](../reference/configuration.md)），本机个人版默认继承宿主机 `~/.pi` 生态，多租户团队版默认关闭继承，仅建议在个人本机或管理员显式信任（`PA_LOCAL_PI_RESOURCES=always`）的宿主机环境中使用。

## 4. 选型与演进建议

1. **开箱默认：需要协同、验收、多人类参与或沉淀团队资产 → 直接用 PA 团队模式**
   默认主联系人 `Product Manager` 接单，按需委托 `Engineering Manager` / `QA Manager` / `Marketing & Growth Lead` 或自定义业务角色，配合旁听把关、Git Space 归档与定期 RSI 团队体检。
2. **探索期 / 原生 Pi 终端手感 → 选 `Pi Default` 单兵直连**
   零多角色 handoff 开销，需要细粒度编码并发（如并行审 diff、worktree 试错）时，可在本机 Pi 生态安装 `pi-subagents` 增强单兵算力。
3. **跑通后沉淀 → `propose_skill` + `propose_role` 演进为团队能力**
   当某类单兵任务反复出现稳定流程时，用 `propose_skill` 沉淀为标准 Skill（含确定性脚本）供全团队复用；当需要独立职责边界、验收把关或跨人协作时，再通过 `Role Architect` 或 `propose_role` 拆出固定业务岗位。

## 5. 实机核验入口

- 对照 `pi-default`（solo）与 `product-manager`（business）的真实 Pi 上下文大小、工具清单与提示差异：运行 `npm run demo:solo`（详见[demo 说明](../../packages/server/src/demo/README.md)）。
- 核验业务主责从极简索引按需调用 `read_team_roles({ includeCapabilities: true })` 获取完整能力证据：运行 `npm run demo:team:capabilities`。

相关阅读：[在工作台安排事项与验收成果](../guides/user-guide.md)、[内置角色与能力参考](../reference/role-design.md)、[运行与协作参考](../reference/runtime-collaboration.md)。
