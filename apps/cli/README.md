# CLI 薄启动器（`@pa/cli`）

本目录是 Personal Agent 的命令行启动壳，仅负责环境变量/信号处理、调用 `@pa/server/boot` 的 `bootHost()` 并输出访问地址，不承载编排核或业务路由逻辑：

- 源码入口：[src/main.ts](src/main.ts)（`npm run start:web` 使用）
- 预构建入口：`dist/main.js`（由 `npm run build:cli` 打包为无 `node_modules` 依赖的自包含产物，供 `prebuilt.tar.gz` 发布与 `npm run check:startup` 验证）
