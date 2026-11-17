# 本地网页工作台

前端使用 React、esbuild 与原生 CSS，通过同源 HTTP/SSE 访问后端。这里没有独立 Vite 开发服务器或 WebSocket 通道；[index.html](index.html) 是构建输入，`web/dist/` 是生成资源，不直接修改。

从仓库根运行：

```bash
npm run build:web
npm run start:web
```

`start:web` 会重新构建网页并启动 [服务入口](../src/server/README.md)，默认使用已有用户数据库。只验证启动时使用 `npm run build` 后的 `npm run check:startup`，不要用用户事项执行试验任务。

- 改页面、路由或事件处理先读 [src/README.md](src/README.md)。
- 涉及接口时同时检查 [server](../src/server/README.md)；涉及工作区、运行状态或成果判断时再读 [orchestrator](../src/orchestrator/README.md)，不在网页复制这些执行策略。

- `npm run check` 包含前后端类型与规范检查，`npm run build:web` 验证资源构建。
- 网页呈现变化还需实际查看相应页面；离线服务测试不代表视觉体验已验证。
- V1–V4 早期视觉原型演进已整理至本地不跟踪的 `.notes/prototypes/` 目录，当前双栏界面以实现为准。
