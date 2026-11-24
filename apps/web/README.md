# 本地网页工作台

前端使用 React、esbuild 与原生 CSS，通过同源 HTTP/SSE 访问后端。这里没有独立 Vite 开发服务器或 WebSocket 通道；[index.html](index.html) 是构建输入，`web/dist/` 是生成资源，不直接修改。

```text
web/
├── index.html          # 网页构建入口模板
├── tsconfig.json       # 前端独立 TypeScript 配置
├── dist/               # esbuild 构建产物（不直接编辑）
└── src/                # 前端源码（详见 src/README.md）
    ├── main.tsx        # 应用挂载与样式加载顺序
    ├── App.tsx         # 顶层页面装配、Hash 路由与全局 SSE 同步
    ├── api/            # 按业务拆分的 HTTP DTO 与请求模块（matters/space/team/orgs/runtime 等）
    ├── hooks/          # 会话认证、事项范围、滚动、右侧分屏文档与澄清状态等 hooks
    ├── components/     # 页面与组件（chat/ 对话流与分屏文档、team/ 团队管理、SpacePages 等）
    ├── utils/          # 领域纯函数（委托投影、消息流解析、组织名册等）
    └── styles/         # 按页面职责拆分的原生 CSS（tokens/primitives/chat-*/deliverables/team 等）
```

从仓库根运行：

```bash
npm run build:web
npm run start:web
```

`start:web` 会重新构建网页并启动 [服务入口](../src/server/README.md)，默认使用已有 `.data/` 数据库；需要验证团队版多组织权限与资料空间版本交互、且避免改动真实数据时，可用 `npm run start:team:sandbox` 启动带预设样本数据的隔离沙盒（说明见[开发指南](../docs/guides/development.md#团队版一键验证沙盒)）。只验证启动时使用 `npm run build` 后的 `npm run check:startup`，不要用用户事项执行试验任务。

- 改页面、路由或事件处理先读 [src/README.md](src/README.md)。
- 涉及接口时同时检查 [server](../src/server/README.md)；涉及工作区、运行状态或成果判断时再读 [orchestrator](../src/orchestrator/README.md)，不在网页复制这些执行策略。

- `npm run check` 包含前后端类型与规范检查，`npm run build:web` 验证资源构建。
- 网页呈现变化还需实际查看相应页面；离线服务测试不代表视觉体验已验证。
- V1–V4 早期视觉原型演进已整理至本地不跟踪的 `.notes/prototypes/` 目录，当前双栏界面以实现为准。
