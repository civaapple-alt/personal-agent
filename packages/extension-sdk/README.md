# 外部扩展 SDK（`@pa/extension-sdk`）

本包面向未来的外部扩展作者，提供 `@pa/extension-api` 的**精选稳定子集**（API `1.0`），与宿主内部能力解耦：

- `@pa/extension-sdk/server`（[src/server.ts](src/server.ts)）：`defineExternalServerExtension`（仅暴露 `apiVersion`、`name`、`title`、`description`、`tools`、`piPackage`、`interactiveTools`）
- `@pa/extension-sdk/web`（[src/web.ts](src/web.ts)）：`defineExternalWebExtension`（仅暴露安全的浏览器侧工具展示声明）
- `@pa/extension-sdk/manifest`（[src/manifest.ts](src/manifest.ts)）：`validateExternalExtensionDescriptor`，显式拒绝宿主内部保留字段（`builtinPiEntry`、`builtinSkillPackage`、`workflowRule`、`workflowSkillDir`、`supersedesPackages`）

内部全量契约见 [packages/extension-api/README.md](../extension-api/README.md)。
