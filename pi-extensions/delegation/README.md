# 便携跨岗委托扩展（`pa-delegation`）

## 能力概览

将 Personal Agent 的 **Lead 同步跨岗委托原语（`delegate_to_member`）** 独立打包为可移植扩展，支持双后端自动路由：

- **独立终端 Pi**：根据 `memberId` 拉起独立 `pi --mode rpc --session .pi/delegations/sessions/<memberId>.jsonl` 子进程完成专职任务并带回结果；支持携带 `verification` 触发只读独立验收（`--exclude-tools edit,write`）与 `modelOverride` 异构模型指定。
- **PA 宿主**：无缝桥接 PA 团队编排器，复用组织花名册 ACL、Git 资料空间文档预检（`handoffDocumentIds`）与轮次交接板（`assignmentNumber`）。

---

## 插件依赖与推荐搭配

- **内部代码依赖**：
  - [../shared/team-bridge-client.ts](../shared/team-bridge-client.ts)：PA 宿主下经 HTTP Bridge 转交编排器执行；
  - [../shared/local-rpc-worker.ts](../shared/local-rpc-worker.ts)：独立终端下负责派生、隔离与回收委托子进程（子 Worker 会注入 `PA_LOCAL_DELEGATE_SUBWORKER=1` 阻止无限嵌套递归委托）；
  - [../roles/loader.ts](../roles/loader.ts)：按优先级查找 `memberId` 对应的角色 Markdown，将职责与 `antiJobs` 边界直接喂给受托子进程。
- **运行时降级机制**：在没有找到对应角色 Markdown 时**不报错**，自动退化为基于 `memberId` 的临时专职提示词继续执行。
- **推荐搭配扩展**：[../roles/README.md](../roles/README.md)（提供 4 个默认业务岗位定义）、[../role-skills/README.md](../role-skills/README.md)（提供对应方法论）；如需多 Agent 异步看板协同，请另行挂载 [../board/README.md](../board/README.md)。

---

## 在原生终端 `pi`（Pi Console）中使用

### 1. 启动扩展

```bash
# 推荐组合：跨岗委托 + 默认岗位资产 + 内置岗位 Skills + 人工澄清
pi -e ./pi-extensions/delegation/index.ts \
   -e ./pi-extensions/roles/index.ts \
   -e ./pi-extensions/role-skills \
   -e ./pi-extensions/human-question/index.ts
```

### 2. 在控制台里怎么触发和调用？

用户**不需要记硬性参数、不需要手写 `--verify`，也不用点名角色精确 ID**——扩展把本地可用角色清单通过 `promptGuidelines` 喂给主模型，由模型自主判断找谁以及哪一步必须走只读独立验收：

- **方式 A：斜杠命令 `/delegate <自然语言任务>`（推荐，一眼知道怎么用）**：
  - `/delegate 排查并修复 src/auth.ts 的空指针问题，然后安排负责质量的同事独立验证是否全部通过`
  - `/delegate 帮我对比两个数据库方案，并找熟悉基础设施的专家评估迁移风险`
  - 扩展会把你的请求连同当前可用角色目录交给主模型，由模型自行决策调用哪个（或哪几个）角色，并在需要验证/复核的环节自动带上 `verification`（触发 `--exclude-tools edit,write`）；不传参输入 `/delegate` 会打印用法提示。
- **方式 B：普通自然语言对话（模型自主判断是否委托）**：
  - **常规实现**：直接说「这个问题交给研发同学先排查实现一下。」
  - **独立验收**：直接说「改动完成了，帮我找 QA 或另一个模型做一次独立复核，不能自己改代码。」
- **单元测试**：`node --test test/pi-extension-delegation-and-roles.test.ts` 覆盖角色清单注入、`/delegate` 自然语言路由、只读验收门禁、未知/临时角色降级及 PA Bridge 路由。

---

## 在 Personal Agent（PA）中使用

- **装配入口**：[pa-extensions/delegation/server/index.ts](../../pa-extensions/delegation/server/index.ts)（`kind: "builtin-pi"`）与 [build-support.ts](../../packages/server/src/build-support.ts) 直接加载本入口。
- **运行路径**：PA 对处于 `lead` 模式且允许委托（`aiMemberIds.length > 1` 或本轮显式 `@AI成员` 授权）的主责进程注入 `PA_TEAM_BRIDGE_URL`。扩展识别后注册完整的 PA 契约参数（含 `handoffDocumentIds` 资料空间预检与 `verification.assignmentNumber`），所有委托请求经 [delegation-runner.ts](../../packages/server/src/orchestrator/execution/delegation-runner.ts) 受多租户成员权限、同工作区上下文与防自审校验监管；Web 端通过 `pa-extensions/delegation` 的 Web 半边展示 `[独立验收]` 与受托同事气泡。
- **模式隔离约束**：PA 处于 `solo`（`Pi Default`）或 `board` 协同模式下**不挂载**本扩展。
