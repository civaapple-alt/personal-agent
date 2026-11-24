# `visualize` 便携 Pi 扩展

改编自 JetBrains ThinkRail 的 `@thinkrail/pi-visualize`（Apache-2.0），面向零额外运行时依赖的 Node ESM，可在原生终端 Pi 或 Personal Agent 中独立加载：

```bash
pi -e ./pi-extensions/visualize/index.ts
```

提供 `visualize` 工具，支持三种可视化卡片：
- `type: "diagram"`：Mermaid 图表（架构图、时序图、状态图等）；
- `type: "comparison"`：并排方案对比卡片（含 `recommended`、`pros`、`cons` 与内嵌 `mermaid`）；
- `type: "file"`：工作区文件预览或 `before → path` 前后对比。

PA 宿主侧的双半边装配与网页卡片渲染见 [pa-extensions/visualize](../../pa-extensions/README.md)。
