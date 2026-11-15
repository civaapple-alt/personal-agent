# 角色定义的解析代码

本目录是解析器，不存放团队角色内容。可分享的角色资产在顶层 [roles/](../../roles/README.md)，运行经验在 [storage](../storage/README.md)。

[types.ts](types.ts) 定义 `RoleTemplate` 与五个正文段落；[template-loader.ts](template-loader.ts) 提供解析、目录加载和 Markdown 序列化。frontmatter 是本项目支持的简单字段/数组格式，不是完整 YAML 解析器。

目录加载只把角色 Markdown 作为资产，排除 `README.md` 文档。增加元数据或正文标题时，要同时核对类型、解析、序列化、服务导入导出及编排核的实际消费，不能只让字段出现在 UI。

导出不会自动附带私有数据库记录，但也不能自动识别用户写入正文中的秘密。`skills`、`tools`、`mcpDependencies` 由 [执行装配](../orchestrator/README.md)落实，解析成功不代表能力可用。

从仓库根运行 `node --test test/phase2-orchestrator.test.ts`，验证目录文档与四个初始资产共存、正文解析及序列化。修改导入/导出接口时再按 [server](../server/README.md)选择对应覆盖。
