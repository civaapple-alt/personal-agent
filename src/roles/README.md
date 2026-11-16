# 角色定义的解析代码

本目录是解析器，不存放团队角色内容。可分享的角色资产在顶层 [roles/](../../roles/README.md)，运行经验在 [storage](../storage/README.md)。

[types.ts](types.ts) 定义 `RoleTemplate`（含可选 `roleKind` 区分业务与架构师元角色、可选 `antiJobs` 不做清单）与五个正文段落；[template-loader.ts](template-loader.ts) 提供解析、目录加载、`loadRoleTemplatesWithCustomDir`（将仓库内建 `roles/` 与运行期自定义目录 `.data/roles/` 合并）和 Markdown 序列化；[role-architect.ts](role-architect.ts) 基于单一核心职责（One Job）、显式 Anti-Jobs 与最小工具权责按需生成角色草案，并导出内置元角色模板 `BUILTIN_ROLE_ARCHITECT_TEMPLATE` 与辅助判定。

frontmatter 是本项目支持的简单字段/数组格式，不是完整 YAML 解析器。
`id` 同时作为文件名，只接受最长 128 字符的小写字母、数字和连接短横线，不接受 `readme`。解析与 HTTP 新建使用相同校验，思考档位也共用解析器；既有非法 ID 不自动改名或重写历史关联。

目录加载只把角色 Markdown 作为资产，排除 `README.md` 文档。增加元数据或正文标题时，要同时核对类型、解析、序列化、服务导入导出及编排核的实际消费，不能只让字段出现在 UI。

导出不会自动附带私有数据库记录，但也不能自动识别用户写入正文中的秘密。`skills`、`tools`、`mcpDependencies` 由 [执行装配](../orchestrator/README.md)落实，解析成功不代表能力可用。

从仓库根运行 `node --test test/phase2-orchestrator.test.ts`，验证目录文档与四个初始资产共存、正文解析及序列化。修改导入/导出接口时再按 [server](../server/README.md)选择对应覆盖。
