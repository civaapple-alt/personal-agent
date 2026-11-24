# Personal Agent 可运行示例（`examples/`）

本目录随 `git clone` 源码仓库与预构建发布包（`personal-agent-<version>-prebuilt.tar.gz`）**同步分发**，供人类开发者与 AI 角色在需要编写或排查 PA 扩展、Skill 脚本与角色定义时直接查阅和运行。

| 示例 | 用途 | 运行 / 参考方式 |
| --- | --- | --- |
| [extensions/hello-card](extensions/hello-card/package.json) | 使用 `@pa/extension-sdk` 编写双半边 PA 外部扩展（`./server` + `./web` + `toolRenderers`） | 查阅 `server/index.ts` 与 `web/index.ts` |
| [skills/repo-preflight](skills/repo-preflight/SKILL.md) | 符合 `propose_skill` 规范的 `SKILL.md` + 可执行确定性脚本 | `node examples/skills/repo-preflight/scripts/preflight.mjs` |
| [roles/security-reviewer.md](roles/security-reviewer.md) | 最小自定义岗位模板（Markdown Frontmatter + 职责分节） | 可作为角色架构师或自定义 `roles/` 模板参考 |
