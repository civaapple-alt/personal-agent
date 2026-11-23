# Pi Skill 目录

PA 在事项岗位和独立角色架构师进程中加载此扩展，将 Pi 当前发现的 Skill 和插件命令名称、来源及描述作为目录元数据提供给模型（已出现在 `<available_skills>` 的 Skill 会自动去重省略；Skill 条目以裸 `name` 暴露，由角色按任务或用户自然语言自行调用 `load_available_skill` 并直接应用，不要求用户输入 Pi 终端的 `/skill:*` 斜杠命令）；目录最多 24000 字符，超出时标明并提供完整查询工具。`list_available_skills` 使用 Pi 的当前 Skill 命令清单，包括 `disable-model-invocation` 标记为手动调用的 Skill；`load_available_skill` 根据名称（兼容 `name`、`skill:name`、`/skill:name`）读取清单中对应的完整正文并返回 SHA-256。重名时须同时提供清单中的路径。只读取 Pi 当前发现的 Skill 文件，单个文件不超过 256 KiB。

Pi 负责资源发现、用户设置与项目信任；PA 明确装配角色与附加目录 Skills。目录的存在或正文被读取不证明角色实际应用了方法，也不改变宿主和用户的授权边界。 [执行配置](../../docs/reference/configuration.md#cli-启动与能力装配)

运行 `node --test test/skill-catalog.test.ts` 检查目录、重名、读取范围和取消。


`list_pi_commands` 查询当前 Pi 进程实际注册的扩展命令。`request_pi_command` 只接受当前已注册的扩展命令名称和单行参数，并通过 Pi 的 `sendUserMessage` 请求分发。该 API 不返回命令完成回执，工具只报告“已提交，结果未知”；命令可能请求交互、改变会话或产生副作用，是否适用取决于用户任务和运行环境，须依据后续事件或实际效果核实。它不将 Pi 内置 TUI 命令或提示模板冒充为扩展命令。Skill 命令通过 `load_available_skill` 读取，不作为扩展命令分发。
