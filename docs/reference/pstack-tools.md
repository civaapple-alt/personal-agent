# Pi Skill 目录与读取

PA 的 [skill-catalog 扩展](../../pi-extensions/skill-catalog/README.md)让岗位按任务自主检索并读取 Pi 已发现的 Skills，包括可通过斜杠命令手动调用的方法。pstack 和其他 Skill 包使用相同流程；安装与资源启停由 Pi 管理。 [使用指南](../guides/pstack-runtime.md)

| 工具 | 输入 | 返回 |
| --- | --- | --- |
| `list_available_skills` | `{ "query"?: "关键词", "source"?: "来源", "offset"?: 0, "limit"?: 20 }` | 匹配的 Skill 名称、精简描述、来源及 `hasMore` / `nextOffset` 分页信息（默认每页 20 条；仅重名时附带 `path` 供消歧） |
| `load_available_skill` | `{ "name": "how", "path"?: "..." }` | 对应 Skill 的完整正文、来源和 SHA-256；重名时同时指定目录返回的 `path` |

工具只读取 Pi 当前清单中的 Skill 正文，单文件不超过 256 KiB。方法包的其他资源可按正文说明使用 Pi 的文件工具读取。工具清单、成功读取与实际应用是不同证据；当前调用不证明模型正确使用了方法。

PA 不再提供 `load_pstack_skill`，也不再暴露仅面向 Pi TUI 终端的扩展斜杠命令工具（`list_pi_commands` / `request_pi_command`）；真正的插件能力由各扩展直接通过 Pi 工具注册提供。事项名册、资料发布、组织访问与用户授权仍由宿主处理；Pi 以服务账号权限运行，不是操作系统沙箱。
