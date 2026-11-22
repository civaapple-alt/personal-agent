# 角色定义的解析代码

本目录是解析器，不存放团队角色内容。可分享的角色资产在顶层 [roles/](../../roles/README.md)，运行经验在 [storage](../storage/README.md)。

[types.ts](types.ts) 定义 `RoleTemplate`（含 `roleKind`、`antiJobs` 及多租户作用域字段 `roleScope` / `ownerOrgId` / `ownerUserId`、`SkillStorageScope`、`NewSkillDraft`）与五个正文段落；[template-loader.ts](template-loader.ts) 提供解析、目录加载（同时支持 `<id>.md` 单文件与 `<id>/<id>.md` 角色包目录，且由目录归属覆盖 frontmatter 的 `roleScope`/`ownerOrgId`/`ownerUserId` 以防止越权伪造，并阻止非 `global` 角色覆盖全局模板或成为主联系人）、`loadRoleTemplatesWithCustomDir`（将仓库内建 `roles/` 与运行期自定义目录 `.data/roles/` 根、`orgs/<orgId>/`、`users/<userId>/` 合并）和 Markdown 序列化；[role-package-store.ts](role-package-store.ts) 维护作用域目录映射（`global` 写入 `<rolesDir>` 根，`org`/`personal` 分别写入 `orgs/<orgId>/` 与 `users/<userId>/` 且生成 `org-<8hex>-` / `usr-<8hex>-` 命名空间 ID）、`newSkills` 草案校验（大小/作用域限制）与随角色包落盘的 `<roleDir>/skills/<skillName>/SKILL.md` 及 `.data/skills/{global,orgs,users}/` 原子读写与清理；[role-architect.ts](role-architect.ts) 基于单一核心职责（One Job）、显式 Anti-Jobs 与最小工具权责按需生成角色草案及可选 `newSkills` 建议（仅作草案预览，确认前不落盘），并导出内置元角色模板 `BUILTIN_ROLE_ARCHITECT_TEMPLATE` 与辅助判定。

frontmatter 是本项目支持的简单字段/数组格式，不是完整 YAML 解析器。
方法路径与作用域 Skill 目录清单位于 [capabilities.ts](capabilities.ts)，提供 `validateSkillReference`（拒绝 `..`、`\` 与绝对路径越界）、`resolveAllowedSkillRoots` 与 `listScopedSkillCatalog`；草案检查只标记 Skill 文件存在/缺失与 MCP 待运行核查，不安装依赖，也不证明效果；实际能力仍由执行器核查。

确认新 Skill 时按目标作用域检查名称。批量请求在创建任何角色前检查所有文件目标。同名文件返回 HTTP 409，用户可以改名或选用已有 Skill。
`id` 同时作为文件名，只接受最长 128 字符的小写字母、数字和连接短横线，不接受 `readme`。解析与 HTTP 新建使用相同的 ID 校验。既有非法 ID 不自动改名或重写历史关联。

目录加载只把角色 Markdown 作为资产，排除 `README.md` 文档。解析器接受五个英文标题及其旧版中文别名。创建和调整通过 `formatRoleTemplateBody` 写英文标题。导入后直接导出会保留原 Markdown 正文。

导出不会自动附带私有数据库记录，但也不能自动识别用户写入正文中的秘密。`skills`、`tools`、`mcpDependencies` 由 [执行装配](../orchestrator/README.md)落实，解析成功不代表能力可用。

从仓库根运行 `node --test test/phase2-orchestrator.test.ts`，验证目录文档与四个初始资产共存、正文解析及序列化。修改导入/导出接口时再按 [server](../server/README.md)选择对应覆盖。
