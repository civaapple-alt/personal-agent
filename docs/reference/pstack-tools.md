# Pi Skill 目录与读取

PA 的 [skill-catalog 扩展](../../pi-extensions/skill-catalog/README.md)让岗位按任务选择 Pi 已发现的 Skills，包括可通过斜杠命令手动调用的方法。pstack 和其他 Skill 包使用相同流程；安装与资源启停由 Pi 管理。 [使用指南](../guides/pstack-runtime.md)

| 工具 | 输入 | 返回 |
| --- | --- | --- |
| `list_available_skills` | `{}` | Pi 当前发现的 Skill 名称、描述和来源路径 |
| `load_available_skill` | `{ "name": "how" }` | 对应 Skill 的完整正文、来源和 SHA-256；重名时同时指定目录返回的 `path` |
| `list_pi_commands` | `{}` | 当前 Pi 已注册的插件命令及用途 |
| `request_pi_command` | `{ "name": "命令名", "arguments": "参数" }` | 请求 Pi 异步分发插件命令；只确认提交，不确认执行结果 |

工具只读取 Pi 当前清单中的 Skill 正文，单文件不超过 256 KiB。方法包的其他资源可按正文说明使用 Pi 的文件工具读取。工具清单、成功读取与实际应用是不同证据；当前调用不证明模型正确使用了方法。

PA 不再提供 `load_pstack_skill`，也不会自动为调试流程附带特定原则。角色根据任务选择方法和相关资源。事项名册、资料发布、组织访问与用户授权仍由宿主处理；Pi 以服务账号权限运行，不是操作系统沙箱。
