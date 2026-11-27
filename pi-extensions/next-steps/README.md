# `next-steps` 便携 Pi 扩展（`pa-next-steps`）

## 能力概览

零依赖的便携 Pi 扩展（[package.json](package.json)，借鉴自 JetBrains ThinkRail 的 `@thinkrail/pi-next-steps` / Apache-2.0），注册 `suggest_next_steps` 工具，使 AI 在交付结束时可附带 `2–4` 条可立即执行的下一步具体建议（例如发起独立 QA 验收、将成熟流程沉淀为 Skill、或推进下一实施步骤）。

---

## 插件依赖与推荐搭配

- **代码与外部依赖**：**零代码与外部依赖**（零 PA 宿主、零 Node 特有依赖，纯参数校验与文本格式化）。
- **展示依赖差异**：原生终端 Pi 下以结构化文本列表呈现；PA Web 工作台则额外配合 [pa-extensions/next-steps](../../pa-extensions/README.md) 的前端能力，将 `details.suggestions` 渲染成输入框上方的快捷可点按钮。
- **推荐搭配扩展**：独立终端可与 [../visualize/README.md](../visualize/README.md)、[../role-skills/README.md](../role-skills/README.md) 及 [../human-question/README.md](../human-question/README.md) 组合挂载。

---

## 在原生终端 `pi`（Pi Console）中使用

```bash
pi -e ./pi-extensions/next-steps/index.ts
```

### 在控制台里怎么触发和调用？

本扩展**无斜杠命令**，模型在任务结尾通常会按上下文自主收尾；也可以用普通话术表达需要行动建议：

- **示例提问**：「排查完这个报错后，最后给我列出 2–4 个具体的下一步可执行建议。」
- 扩展校验建议数量（2–4 条）与每条建议的标题/指令正文，在终端直接打印编号清晰的可执行建议列表（可按建议复述发送），并在 `details.suggestions` 中输出结构化数组。

---

## 在 Personal Agent（PA）中使用

- **双半边装配**：PA 宿主侧通过 [pa-extensions/next-steps](../../pa-extensions/README.md) 装配：
  - `server` 半边：仅为 **Lead 主责岗位** 与 **`solo` 单兵模式** 加载本扩展入口（内部委派专家、Coordinator 子 Worker 与旁听成员不挂载，避免底层成员向用户直接抛出越级指令）；
  - `web` 半边：在对话输入框上方将 `details.suggestions` 展示为一键可点建议按钮（点击直接发送，按住 `Shift` 点击可填入输入框编辑后再发）。
