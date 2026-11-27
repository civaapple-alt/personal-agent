# Pi Skill 目录扩展（`skill-catalog`）

## 能力概览

将 Pi 当前运行环境中已发现、但未出现在系统提示 `<available_skills>` 的额外 Skill（例如 `disable-model-invocation` 手动触发类方法与插件命令）以紧凑单行索引注入上下文（默认上限 `6,500` 字符，可无截断容纳整套 `pstack` 等方法包；若无额外 Skill 则零开销不注入），并提供按需检索与安全读取工具：

- `list_available_skills`：按 `query`、`source`、`offset`（默认 `0`）、`limit`（默认 `20`）检索或分页浏览清单，返回 `hasMore` 与 `nextOffset`；单名唯一时默认省略绝对路径，仅在重名时返回 `path` 消歧。
- `load_available_skill`：兼容 `name`、`skill:name`、`/skill:name` 读取 Pi 已发现 Skill 的完整 `SKILL.md` 正文并返回 SHA-256（单个文件上限 256 KiB；重名时须传入 `path`）。

---

## 插件依赖与推荐搭配

- **代码与外部依赖**：零第三方与内部包依赖，仅使用 Node 标准库（`node:crypto`、`node:fs/promises`、`node:path`）。
- **运行时能力依赖**：依赖 Pi 运行时生命周期事件 `before_agent_start` 与 `pi.getCommands()`（由 `pi` CLI / RPC 宿主原生提供）。
- **推荐搭配扩展**：[../role-skills/README.md](../role-skills/README.md)（提供内置岗位方法包）及运维者按需通过 `pi install` 配置的全局方法包（如 `pstack`）。

---

## 在原生终端 `pi`（Pi Console）中使用

```bash
pi -e ./pi-extensions/skill-catalog/index.ts \
   -e ./pi-extensions/role-skills
```

### 在控制台里怎么触发和调用？

本扩展**无新斜杠命令**，用户无需点名内部工具名，靠自动上下文注入或自然语言需求即可触发：

- **背景注入**：对于原本要求手动 `/skill:*` 才能触发的已安装 Skill（如禁用自动触发的方法包），`before_agent_start` 会自动在系统上下文附带极简单行目录；
- **自然语言自动检索**：直接提出任务诉求（例如「按团队写交付文档或测试验收的标准方法先检查一下，再动手执行」），模型会自行检索已安装目录并按需加载 `SKILL.md` 正文。
- 严格遵守安全边界：只允许读取 Pi 运行时已确认发现的 Skill 文件路径，不能任意读取磁盘其他目录。

---

## 在 Personal Agent（PA）中使用

- **装配入口**：PA 为全部业务岗位及 `Role Architect` 进程显式加载本扩展入口（参见 [pa-extensions/skill-catalog](../../pa-extensions/README.md) 与 [执行配置](../../docs/reference/configuration.md#cli-启动与能力装配)）。
- **协作价值**：Web 工作台端不暴露 Pi 终端的 `/skill:*` 输入体验，PA 借助本扩展让角色在网页端也能自主发现、分页浏览并按需应用 `pstack`、工作区 `.agents/skills` 与团队 Skills（配合 `session_compact` 续接锚点保留已读方法，具体见 [pstack 方法工具参考](../../docs/reference/pstack-tools.md)）。
- **单元测试**：`node --test test/skill-catalog.test.ts` 检查紧凑索引、空集零注入、关键词过滤、重名消歧、256 KiB 体积上限与取消行为。
