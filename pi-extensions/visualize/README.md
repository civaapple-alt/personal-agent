# `visualize` 便携 Pi 扩展（`pa-visualize`）

## 能力概览

改编自 JetBrains ThinkRail 的 `@thinkrail/pi-visualize`（Apache-2.0），面向零额外运行时依赖的 Node ESM，注册 `visualize` 工具，支持三类结构化视觉呈现：

- `type: "diagram"`：Mermaid 图表（架构图、时序图、状态图、流程图等）；
- `type: "comparison"`：并排方案对比卡片（支持 `recommended` 推荐标记、`pros`、`cons` 与内嵌 Mermaid 图）；
- `type: "file"`：工作区文件预览或 `before → path` 前后对比视图。

---

## 插件依赖与推荐搭配

- **代码与外部依赖**：**零代码与外部依赖**（纯 ESM 参数校验与 Markdown 格式化，不含任何 React 或宿主导入）。
- **展示依赖差异**：工具本身可在纯终端运行；若要在 Web 工作台中渲染交互式 Mermaid SVG 与并排对比组件，则配套由 [pa-extensions/visualize](../../pa-extensions/README.md) 的 Web 半边注册 `toolRenderers`。
- **推荐搭配扩展**：独立控制台可与 [../next-steps/README.md](../next-steps/README.md) 及 [../role-skills/README.md](../role-skills/README.md) 组合使用。

---

## 在原生终端 `pi`（Pi Console）中使用

```bash
pi -e ./pi-extensions/visualize/index.ts
```

### 在控制台里怎么触发和调用？

本扩展**无斜杠命令**，在对话中直接用自然语言提出图形化、对比或文件对照需求时，模型会自动调用：

- **画架构/流程图**：「帮我画一张当前模块调用的时序图。」
- **多方案对比**：「把方案 A 和 B 的优缺点并排做个对比，标出你推荐的一个。」
- **文件前后对照**：「把修改前后的配置文件对照展示给我看。」
- 在纯终端中，`visualize` 会先校参，再输出规范的 Markdown 源码与对比摘要，同时保留结构化 `details`；若在支持自定义渲染的 GUI/RPC 客户端中则会升级为富交互视图。
- 单元测试：`node --test test/runtime-settings.test.ts` 等离线覆盖验证参数校验与格式化输出。

---

## 在 Personal Agent（PA）中使用

- **双半边装配**：PA 宿主侧通过 [pa-extensions/visualize](../../pa-extensions/README.md) 装配：
  - `server` 半边：声明对全部非 `Role Architect` 业务与单兵（`solo`）岗位加载本扩展入口；
  - `web` 半边：消费工具返回的 `details`，在聊天执行记录中渲染可折叠 Mermaid 图表、对比筹码与文件对比预览。
