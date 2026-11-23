# Pi Skill 目录

PA 在事项岗位和独立角色架构师进程中加载此扩展。`list_available_skills` 使用 Pi 的当前 Skill 命令清单，包括 `disable-model-invocation` 标记为手动调用的 Skill；`load_available_skill` 根据名称读取清单中对应的完整正文并返回 SHA-256。重名时须同时提供清单中的路径。只读取 Pi 当前发现的 Skill 文件，单个文件不超过 256 KiB。

Pi 负责资源发现、用户设置与项目信任；PA 明确装配角色与附加目录 Skills。目录的存在或正文被读取不证明角色实际应用了方法，也不改变宿主和用户的授权边界。 [执行配置](../../docs/reference/configuration.md#cli-启动与能力装配)

运行 `node --test test/skill-catalog.test.ts` 检查目录、重名、读取范围和取消。
