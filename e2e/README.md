# 端到端验证（E2E）

Personal Agent 将自动化测试划分为三个明确层级，确保日常快速门禁不会意外消耗外部付费模型额度，也绝不污染本地 `.data/` 用户数据：

| 层级 | 命令 | 运行方式与成本 | 覆盖范围 |
| --- | --- | --- | --- |
| 1. 离线单测与 HTTP 测试 | `npm test` | `node:test` + 桩 Worker，零模型消耗 | 存储拆表、ACL 权限、Board 编排闭环、CoE 信号与前端纯函数（[test](../test/README.md)） |
| 2. 无模型真实浏览器 E2E | `npm run e2e` | 构建 `apps/web/dist` + 隔离临时服务 + 本机 Chrome 实测，零模型消耗 | 真实 SPA 渲染与导航、`0.9.0` 看板 UI 与 SSE 实时推送、团队版沙盒 RBAC |
| 3. 按需真实 Pi E2E | `npm run e2e:live` | 启动真实 Pi CLI（`packages/server/src/demo/*`），除 `--dry-run` 外均消耗模型额度 | 真实模型工具调用、动态组队、信任四步、跨模型验收与角色决策（[demo](../packages/server/src/demo/README.md)） |

## 隔离保证

每次运行 `npm run e2e` 都会通过 [server.ts](fixtures/server.ts) 独立启动临时 PA 实例并在结束后彻底销毁：

- 自动分配空闲 `127.0.0.1` 临时端口；
- 为 SQLite（`PA_DB_PATH`）、Git 资料空间（`spaces/`）、工作区（`PA_WORKSPACES_ROOT`、`PA_DEFAULT_WORKSPACE_DIR`）与会话（`PA_SESSION_DIR`）创建独立的 `mkdtemp` 临时目录，不读写 `.data/`；
- 通过 `PI_CODING_AGENT_DIR=<temp>/pi-agent`、`PI_OFFLINE=1` 与 `PA_LOCAL_PI_RESOURCES=0` 隔离 Pi 运行环境；
- 监听浏览器 `page.on("pageerror")`，出现未捕获前端异常立即判失败。

## 浏览器自动解析

[browser.ts](fixtures/browser.ts) 按以下优先级自动查找 Chrome / Chromium，本机已安装 Chrome 时无需重复下载测试浏览器：

1. 环境变量 `PA_E2E_CHROME_BIN` 或 `CHROMIUM_BIN`。
2. Playwright 缓存目录中的 Chromium（`chromium.executablePath()`）。
3. 常见系统路径（`/Applications/Google Chrome.app/...`、`/usr/bin/google-chrome`、`/usr/bin/chromium`）。

若在无系统 Chrome 的纯容器环境下运行，请先执行 `npx playwright install chromium`。

## 真实浏览器测试用例（`e2e/*.spec.ts`）

- [workbench-personal.spec.ts](workbench-personal.spec.ts)：个人版冷启动、侧栏导航（资料空间 / AI 团队 / 设置）、新事项 `Lead ↔ Board` 切换及已有事项 L1 状态条模式切换。
- [board-ui.spec.ts](board-ui.spec.ts)：预置多轮 `0.9.0` Board 夹具，真实点击验证 `MatterBoardPane` 全部交互——Coordinator 置顶且无退场按钮、`隐藏非活跃` 切换、默认折叠 `已退场` 展开、`working` 禁用换模型、暂停/恢复、`waiting` 原地换模型弹窗、非 Coordinator 一键 `退场`、公告板筛选/搜索/Markdown 正文懒加载/发帖、SVG `@mention` 关系图与点击节点跳回过滤、游标分页事件与 `monitor_alert` 高亮，以及共享 `/api/events` SSE 不刷新实时推送。
- [team-sandbox-rbac.spec.ts](team-sandbox-rbac.spec.ts)：在 `PA_REQUIRE_AUTH=1`（复用 [start-team-sandbox.mjs](../scripts/start-team-sandbox.mjs) `--seed-only`）下验证 `AuthGateView` 登录、多组织资料空间隔离（`org_viewer` 不可见其他组织文档）及看板只读权限边界（直接发帖返回 `403`）。

可视调试可运行 `npm run e2e:headed`；失败用例会自动保存截图与 Trace，可通过 `npx playwright show-report playwright-report` 查看。

## 真实模型工作流（`e2e:live`）与成本配置

[run-live.ts](run-live.ts) 统一调度 [catalog.ts](live/catalog.ts) 中登记的 16 个真实 Pi 场景，按退出码给出**确定性裁决**（`PASS` / `REVIEW_PENDING` / `FAIL`，绝不交给大模型自评），并将每次执行记录追加到受 `.gitignore` 忽略的 `e2e/.live-runs.jsonl`：

```bash
npm run e2e:live -- --list
npm run e2e:live -- --show-models
npm run e2e:live -- --scenario board --dry-run
npm run e2e:live -- --scenario board
```

### 按测试目的分档选模型 + 白名单防误扣费

出于代码与项目数据隐私保护，模板[配置示例](live.config.example.json)刻意**不预置也不推荐使用免费模型（free tier）**（免费额度通常默认允许厂商将请求内容用于模型训练），仅保留付费订阅/低单价模型，并支持供应商白名单与完全自定义档位（Profile）。

复制示例为本地受 `.gitignore` 忽略的 `e2e/live.config.json`（由 [config.ts](live/config.ts) 解析）：

```bash
cp e2e/live.config.example.json e2e/live.config.json
```

示例中的档位按**能力与成本角色**命名（均为自定义别名，程序不对名字做硬编码判断，可随时替换底层模型）：

| Profile | 供应商 / 模型 | Thinking | 定位与适用场景 |
| --- | --- | --- | --- |
| `default`（默认） | `kimi-coding/kimi-for-coding` | `high` | 常规主力使用 |
| `strong` | `kimi-coding/k3.1-pro` | `high` | 强能力（复杂编排、上线前质量复核） |
| `budget` | `opencode-go/deepseek-v4.1-flash` | `high` | 成本优先常规使用 |
| `budget-alt` | `opencode-go/glm-5.3-flash` | `high` | 成本优先常规使用（备选模型） |
| `budget-strong` | `opencode-go/glm-5.3` | `high` | 成本可控下的强能力备选 |
| `cross-verify` | 主控 `kimi-coding/kimi-for-coding` + 验收 `opencode-go/deepseek-v4.1-flash` | `high` | 跨模型家族独立验收（`board` / `mention-verify`） |

生效优先级为：**CLI 参数 > 环境变量（`PA_E2E_*`） > `e2e/live.config.json` 档位（`--profile` > `PA_E2E_PROFILE` > `defaultProfile`） > 本机 Pi 默认模型**。一旦配置了 `allowedProviders`（或 `--allow-providers` / `PA_E2E_ALLOWED_PROVIDERS`），未在白名单内的主模型或 Verifier 供应商会在启动 Pi 前直接报错拦截（fail closed）：

```bash
npm run e2e:live -- --show-models --profile budget
npm run e2e:live -- --scenario board --profile budget-strong
npm run e2e:live -- --scenario board --profile cross-verify
npm run e2e:live -- --scenario board --provider kimi-coding --model kimi-for-coding --thinking high --verifier-provider opencode-go --verifier-model deepseek-v4.1-flash --allow-providers kimi-coding,opencode-go
```
