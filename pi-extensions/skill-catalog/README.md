# Pi Skill 目录

PA 在事项岗位和独立角色架构师进程中加载此扩展，将 Pi 当前发现且未出现在 `<available_skills>` 中的额外 Skill（如 `disable-model-invocation` 手动触发类方法）以极简单行索引注入系统提示（上限 `3,600` 字符；若无额外 Skill 则零开销不注入）。角色按任务或用户自然语言自主搜索并调用 `load_available_skill` 直接应用，不要求用户在 Web 端输入 Pi 终端的 `/skill:*` 斜杠命令。

- `list_available_skills`：按可选 `query`（关键词）、`source` 与 `limit`（默认 `20`）检索 Pi 当前发现的 Skill 清单（含手动调用类 Skill）。为节省上下文，单名无歧义的 Skill 默认省略宿主机绝对 `path`，仅在重名时返回 `path` 供消歧。
- `load_available_skill`：根据名称（兼容 `name`、`skill:name`、`/skill:name`）读取清单中对应的完整 `SKILL.md` 正文并返回 SHA-256；重名时须同时提供 `path`。只读取 Pi 当前发现的 Skill 文件，单个文件不超过 256 KiB。

Pi 负责资源发现、用户设置与项目信任；PA 明确装配角色与附加目录 Skills。目录的存在或正文被读取不证明角色实际应用了方法，也不改变宿主和用户的授权边界。 [执行配置](../../docs/reference/configuration.md#cli-启动与能力装配)

运行 `node --test test/skill-catalog.test.ts` 检查紧凑索引、空集零注入、`query` 过滤、重名消歧、读取范围和取消。
