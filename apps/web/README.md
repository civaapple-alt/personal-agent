# 本地网页工作台

前端是三环架构中的 **UI Client 环**（`@pa/web`），使用 React 19、esbuild 与原生 CSS，通过可配置端点的 HTTP/SSE 传输层（默认同源，支持 `window.__PA_API_BASE__` / `setApiBaseUrl`）访问宿主，仅依赖 `@pa/contracts`、`@pa/extension-api/web` 与 `@pa/ext-*/web`（由 `npm run check:boundaries` 强制门禁校验）。[index.html](index.html) 是构建输入，`apps/web/dist/` 是生成资源，不直接修改。

```text
apps/web/
├── index.html          # 网页构建入口模板
├── tsconfig.json       # 前端独立 TypeScript 配置
├── dist/               # esbuild 构建产物（不直接编辑）
└── src/                # 前端源码（详见 src/README.md）
    ├── main.tsx        # 应用挂载、根级 ErrorBoundary 与样式加载顺序
    ├── App.tsx         # 顶层壳装配、Hash 路由、视图级 ErrorBoundary 与全局 SSE 同步
    ├── api/            # 参数化 HTTP/SSE 传输层（client.ts）与按业务拆分的 DTO 请求模块
    ├── primitives/     # 零业务依赖的基础 UI 原语（ErrorBoundary、ModalDialog、SettingsKit 等）
    ├── views/          # 顶层路由视图（ChatStage、DeliverablesView、SpacePages、TeamView、AccountView 等）
    ├── components/     # 可复用业务组件（Sidebar、ExploringStatus、ModelPicker、chat/、team/ 等）
    ├── extensions/     # 前端静态扩展注册表（registry.ts，消费 @pa/ext-*/web）
    ├── hooks/          # 会话认证、事项范围、滚动、右侧分屏文档与澄清状态等 hooks
    ├── utils/          # 领域纯函数（委托投影、消息流解析、组织名册等）
    └── styles/         # 按页面职责拆分的原生 CSS（tokens/primitives/chat-*/deliverables/team 等）
```

从仓库根运行：

```bash
npm run build:web
npm run start:web
```

`start:web` 会重新构建网页并启动 [服务入口](../../packages/server/src/server/README.md)，默认使用已有 `.data/` 数据库；需要验证团队版多组织权限与资料空间版本交互、且避免改动真实数据时，可用 `npm run start:team:sandbox` 启动带预设样本数据的隔离沙盒（说明见[开发指南](../../docs/guides/development.md#团队版一键验证沙盒)）。只验证启动时使用 `npm run build` 后的 `npm run check:startup`，不要用用户事项执行试验任务。

- 改页面、路由或事件处理先读 [src/README.md](src/README.md)。
- 涉及接口时同时检查 [server](../../packages/server/src/server/README.md)；涉及工作区、运行状态或成果判断时再读 [orchestrator](../../packages/server/src/orchestrator/README.md)，不在网页复制这些执行策略。

- `npm run check` 包含前后端类型与规范检查，`npm run build:web` 验证资源构建。
- 网页呈现变化还需实际查看相应页面；离线服务测试不代表视觉体验已验证。
- V1–V4 早期视觉原型演进已整理至本地不跟踪的 `.notes/prototypes/` 目录，当前双栏界面以实现为准。
