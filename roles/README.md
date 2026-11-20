# 可分享的岗位定义

这里存放角色 Markdown 资产；解析代码在 [src/roles](../src/roles/README.md)，具体执行在 [orchestrator](../src/orchestrator/README.md)。`README.md` 只是导航，不是角色。

| 初始资产 | 主要职责 |
| --- | --- |
| [product-manager.md](product-manager.md) | 澄清需求、组织专业意见、定义范围与验收；新安装时的默认主要联系人 |
| [engineering-manager.md](engineering-manager.md) | 核查仓库事实、技术设计和授权范围内的实现 |
| [qa-manager.md](qa-manager.md) | 验证计划、回归影响和实际验收证据 |
| [marketing-lead.md](marketing-lead.md) | 市场、竞品、价值表达与发布内容 |

新增角色可参考现有文件的 frontmatter 和五个正文标题，不必固定为上述四个岗位。`id` 决定注册身份，当前通过不同 ID 组合成员；修改已有 ID 会影响成员与运行历史的对应。

frontmatter 字段与依赖校验约定：

- 模型配置独立于岗位定义，通过[系统、组织和事项设置](../docs/guides/user-guide.md#调整岗位模型)管理。旧版角色包可以导入，导出时只包含岗位定义。
- `keywords` 用于新事项初始路由和立项评分，业务角色保留原中文岗位名作为路由别名。`responsibilityKeywords` 可为本地立项规则显式指定职责匹配词，省略时沿用正文匹配。
- `skills` 对应[实际 Skill 文件](../skills/README.md)，`tools` 与 `mcpDependencies` 须通过运行工具清单核查。
- 声明、导入、序列化成功都不是依赖已安装或工具已执行的证据。

五段正文分别承载职责边界、方法、工具环境、协作约定及交付验证。保留“内部咨询返回主成员、正式阶段成果才发布”的协作语义，具体机制以[运行说明](../docs/reference/runtime-collaboration.md)为准。
四个基线角色与内置角色架构师当前为 `1.1.1`。内置模板的显示名、五个章节标题、正文和 `antiJobs` 使用英文。解析器也接受旧版中文章节标题。岗位分工、默认工具和验证边界见[角色设计说明](../docs/reference/role-design.md)。已有 `.data/roles/` 同 ID 自定义模板仍优先。

只放通用岗位定义，不写用户密钥、公司私有背景或项目会话；导出不会自动发现正文中的秘密。运行后积累的经验属于私有 storage，不回填进分享定义。

改动后从仓库根运行 `node --test test/phase2-orchestrator.test.ts`；涉及装载/调用再选择 [test](../test/README.md)中的能力和协作覆盖。
