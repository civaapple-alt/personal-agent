# Pi 默认业务岗位包（`pa-roles`）

## 能力概览

本包是 Personal Agent **4 个默认业务岗位 Markdown 定义的单一事实源**（[roles/](roles/)），供原生终端 `pi` 与 Personal Agent 宿主共同使用，不再在仓库多个目录维护副本：

- [product-manager.md](roles/product-manager.md) — 产品需求澄清、范围优先级与验收对齐（新工作台默认主要联系人）
- [engineering-manager.md](roles/engineering-manager.md) — 仓库事实核查、技术设计与编码执行
- [qa-manager.md](roles/qa-manager.md) — 测试计划、回归影响评估与独立验收
- [marketing-lead.md](roles/marketing-lead.md) — 市场调研、竞品对比与发布文案

[loader.ts](loader.ts) 按以下优先级解析角色定义（同名高优先级覆盖低优先级）：
`PA_ROLES_DIR` → `<cwd>/roles/` → `~/.pi/roles/` → 本包内置 [roles/](roles/)。

---

## 插件依赖与推荐搭配

- **代码依赖**：零第三方与内部包依赖，仅使用 Node 标准库（`node:fs`、`node:os`、`node:path`、`node:url`）。
- **下游消费方**：
  - [../delegation/README.md](../delegation/README.md)（独立模式下调用 `resolveRoleDefinition` 自动喂养受托角色人格与 `antiJobs`）；
  - [../board/README.md](../board/README.md)（独立模式下为指定 `sourceMemberId` 的动态成员继承岗位人格与边界）；
  - PA 服务端 [template-loader.ts](../../packages/server/src/roles/template-loader.ts) 与 [build-support.ts](../../packages/server/src/build-support.ts)（作为基线岗位单一事实源与仓库 `roles/` 中 PA 专有角色 `pi-default.md` / `role-architect.md` 自动合并）。
- **推荐搭配扩展**：[../role-skills/README.md](../role-skills/README.md)（角色定义中 `skills: [...]` 字段引用其中的标准方法名称）。

---

## 在原生终端 `pi`（Pi Console）中使用

```bash
# 查看可用角色 + 为 delegation / board 提供默认业务岗位人格
pi -e ./pi-extensions/roles/index.ts \
   -e ./pi-extensions/delegation/index.ts \
   -e ./pi-extensions/role-skills
```

### 在控制台里怎么触发和调用？

用户无需在对话里点名内部工具：

- **斜杠命令 `/roles`**（不耗模型 token）：立即打印当前解析到的全部岗位 ID、标题、关联 `skills`、边界条数及文件来源路径。
- **自然语言对话**（模型按需自查）：如「看看团队里有哪些现成岗位，挑最合适的人来审这份改动」，模型会自动调用 `list_roles`。
- **后台自动生效**：即使你不主动输入 `/roles`，只要挂载了 `roles` 包，`delegation` 和 `board` 都会自动把对应岗位说明书与 `antiJobs` 边界喂给子进程。
- 可随时在项目目录新建 `<cwd>/roles/<id>.md` 或个人目录 `~/.pi/roles/<id>.md` 覆盖或扩展岗位，无需修改本包。

---

## 在 Personal Agent（PA）中使用

- **资产复用**：PA 宿主在 [boot.ts](../../packages/server/src/server/boot.ts) 与 [template-loader.ts](../../packages/server/src/roles/template-loader.ts) 中直接把本包 `roles/` 与根目录下仅属于 PA 宿主的 [roles/README.md](../../roles/README.md)（`pi-default.md`、`role-architect.md`）合并为完整内置名录。
- **扩展静默让位**：当 `index.ts` 检测到 `PA_TEAM_BRIDGE_URL` 时自动 no-op（不注册 `list_roles` 与 `/roles`），避免与 PA 宿主 [worker-runtime](../../pa-extensions/README.md) 提供的带多租户/组织作用域隔离的 `read_team_roles` 冲突。
- **测试校验**：`node --test test/pi-extension-delegation-and-roles.test.ts` 与 `npm run check:startup` 会检验单一事实源无重复且 6 个内置角色完整加载。
