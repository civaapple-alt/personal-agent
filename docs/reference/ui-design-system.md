# UI 设计系统与前端组件规范

本文档定义 Personal Agent Web 工作台（`apps/web`）的视觉原则、语义 Token、排版与布局规范、纯 React 原语使用方式，以及面向人工开发与 AI 协作的静态门禁约束。架构定位与状态流参见 [前端总览](../../apps/web/README.md) 与 [前端源码说明](../../apps/web/src/README.md)。

---

## 1. 视觉原则与架构定位

Personal Agent 采用 **Tailwind v4 + 零外部 UI 依赖原语** 方案，视觉收敛为 **Vercel Geist + Linear**：

- **默认主题（Geist 中性白灰）**：主界面采用极纯净的亮色白灰层级（`bg-canvas` / `bg-sidebar` / `bg-stage` / `bg-card` / `bg-subtle`），主操作 CTA 使用高对比深墨黑（`bg-cta` `#171717`）。
- **工作台密度（Linear 紧凑秩序）**：靠 `1px` 极细边框（`border-line` / `border-line-subtle`）与微弱明度差分层，减少大面积背景色块和厚重阴影；默认控件高度保持紧凑（`28px` / `32px`，顶栏 `44px` / `48px`）。
- **品牌点缀克制（PA 深墨绿）**：品牌色 `accent`（`#0f6b60`）仅用于焦点环（`:focus-visible`）、激活 Tab / 选中指示、重要状态徽章和关键行内链接，不作为大面积主按钮或装饰底色。
- **暗黑模式就绪**：[tokens.css](../../apps/web/src/styles/tokens.css) 已预留 `[data-theme="dark"]` 全套深色中性变量，并通过 `@theme inline` 映射给 Tailwind v4 工具类；组件内必须始终使用语义类而非硬编码颜色，保证未来切暗黑主题零改造成本。

---

## 2. 语义 Token 速查

真源位于 [tokens.css](../../apps/web/src/styles/tokens.css)，入口级联顺序定义在 [app.css](../../apps/web/src/styles/app.css)（`@layer theme, base, components, utilities;`）。

### 2.1 表面与背景（Surfaces）

| Tailwind 类 | 底层 CSS 变量 | 亮色值 | 使用场景 |
| --- | --- | --- | --- |
| `bg-canvas` | `--bg-canvas` | `#fafafa` | 最外层工作台/滚动画布底 |
| `bg-sidebar` | `--bg-sidebar` | `#f7f7f8` | 左侧全局导航栏、移动端顶栏 |
| `bg-stage` | `--bg-stage` | `#ffffff` | 主内容舞台、输入框与弹层白底 |
| `bg-card` | `--bg-card` | `#ffffff` | `Card` 卡片容器底面 |
| `bg-surface` | `--surface` | `#fafafa` | 次级面板、空状态虚线框底 |
| `bg-subtle` | `--bg-subtle` | `#f4f4f5` | 标签底槽、分段控制器底槽、用户气泡 |
| `bg-hover` | `--bg-hover` | `#ededef` | 列表项/次按钮悬停底 |
| `bg-cta` | `--dark-pill` | `#171717` | 主 CTA 按钮底（配合 `text-stage`，暗黑自动反转为浅底深字） |
| `bg-accent` / `bg-accent-soft` | `--accent` / `--bg-accent-soft` | `#0f6b60` / 8% 透明 | 强调按钮、激活态徽章与轻强调选中背景 |

### 2.2 文字、边框与状态色

| 类别 | Tailwind 类 | 用途与约定 |
| --- | --- | --- |
| 文字层级 | `text-ink` / `text-ink-secondary` / `text-ink-muted` / `text-accent` | 标题与正文 / 次要说明与摘要 / 时间戳、计数与辅助提示 / 行内链接与高亮态 |
| 边框 | `border-line` / `border-line-subtle` / `border-line-strong` / `border-accent-border` | 默认 `1px` 卡片与分割线 / 卡片内部分割线 / hover 加强边框 / 激活框 |
| 成功 `success` | `bg-success-bg` `border-success-border` `text-success-text` | 验收通过、实时连接绿点、可用状态 |
| 警告 `warn` | `bg-warn-bg` `border-warn-border` `text-warn-text` | 停滞、返工提示、私密可见提醒 |
| 危险 `danger` | `bg-danger-bg` `border-danger-border` `text-danger-text` | 错误提示、中止、不可逆确认 |
| 信息 `info` | `bg-info-bg` `border-info-border` `text-info-text` | 关联仓库、`@成员` 标记、中性引导 |
| 旁听 `observer` | `bg-observer-bg` `border-observer-border` `text-observer-text` | AI 旁听角色与补充发言徽章 |

### 2.3 圆角与阴影

| Token 类 | 亮色值 | 适用元素 |
| --- | --- | --- |
| `rounded-xs` / `rounded-sm` | `4px` / `6px` | 超小按钮、常规按钮、输入框、列表选中项 |
| `rounded-md` / `rounded-lg` | `8px` / `12px` | `Card` 卡片、横幅、分段栏、弹窗与抽屉容器 |
| `rounded-xl` / `rounded-pill` | `16px` / `9999px` | 对话悬浮输入卡 / 状态徽章 `Badge` |
| `shadow-sm` / `shadow-md` / `shadow-lg` | 极轻环境阴影 | 激活分段按钮 / `Popover` / `ModalDialog` 与 `Drawer` 浮层；普通卡片不加阴影 |

---

## 3. 排版与文字规则

- **字体族**：正文使用 `font-sans`（系统无衬线 + `PingFang SC` / `Noto Sans SC`），路径、Commit Hash、Token 配额、代码片段与 Diff 使用 `font-mono`，数字统计推荐加 `tabular-nums`。
- **字号阶梯**：
  - `text-micro`（`11px`）：徽章内文字、辅助小计数、窄格图标标签
  - `text-xs`（`12px`）：表单标签、次级提示、卡片说明、紧凑按钮文字
  - `text-sm`（`13px`）：列表项正文、默认 `CardBody`、标准按钮与输入控件
  - `text-base`（`14px`）：根字号与对话 Markdown 正文
  - `text-md` / `text-lg` / `text-xl` / `text-2xl`（`15px` / `16px` / `18px` / `22px`）：`CardHeader`、次级节标题、`PaneHeader` `h1` 标题、着陆/登录主标题
- **防挤压与防断词**：
  - 所有 flex/grid 文本列必须保留 `min-w-0`，需要单行省略的元素搭配 `truncate`（并尽量附带完整 `title` 提示）；
  - 窄格多词英文名称（如侧边栏岗位图标标签）使用 `break-normal` 与合理字号避免在单词中间断行。
- **全局专项 CSS（仅保留 4 份少量样式文件）**：
  - [markdown.css](../../apps/web/src/styles/markdown.css)：[MarkdownView.tsx](../../apps/web/src/MarkdownView.tsx) 的 `.md-*` 排版及 `.diff-add`/`.diff-del`/`.diff-hunk`；业务视图复用 Markdown 展示，不自己重写 HTML 标签样式。
  - [extensions.css](../../apps/web/src/styles/extensions.css)：`pa-extensions/visualize` 与 `pa-extensions/skill-capture` 便携扩展的 `.pa-viz-*` 卡片与 `.pa-viz-copy-btn`。
  - [bot-avatar.css](../../apps/web/src/styles/bot-avatar.css)：[BotFaceIcon.tsx](../../apps/web/src/primitives/BotFaceIcon.tsx) 表情动画与降动效兼容。
  - [view-transitions.css](../../apps/web/src/styles/view-transitions.css)：页面与抽屉 View Transitions 过渡。

---

## 4. 布局与响应式约定

- **外层壳**：桌面端（`>= 961px`）为固定 `276px` 左侧栏（`--sidebar-width`）+ `flex-1 min-w-0` 右侧主舞台；`< 961px` 自动切换为顶部移动导航条 + 左侧滑出抽屉与遮罩。
- **独立管理/内容页**：统一用 `PageShell`（`maxWidth="md"` `840px` / `"wide"` `1160px` / `"full"`）+ `PaneHeader` +（按需）`SplitPane`，禁止在不同视图另起平行页面边距规则。
- **窄分屏适配优先用 `@container`**：在聊天右侧弹出 Board（`460px`）或资料文档分屏时，视口本身仍可能是桌面宽屏，此时依赖 `md:`/`lg:` 媒体查询会导致中间聊天列徽章与按钮挤压。局部自适应（如 `ChatStageHeader`、`ComposerDock` 工具条）应为容器添加 `@container` 并使用 `@[580px]:`、`@[480px]:` 等容器查询条件。
- **浮层锚点隔离**：悬浮于内容区右上角的面板（如 `MatterRosterPopover`、`MatterCollabDrawer`）必须挂载在 Header 和状态横条下方的 `relative flex-1 min-h-0` 容器内，禁止对包含顶栏的祖先做全局固定像素 `top-*` 偏移。

---

## 5. 纯 React Primitives 选用指南

所有共享原语位于 [apps/web/src/primitives/index.ts](../../apps/web/src/primitives/index.ts)，零外部 UI 运行时依赖；类名拼接统一使用 [cn.ts](../../apps/web/src/utils/cn.ts)。**写新页面或重构模块时，优先从 `primitives/index.ts` 取用现有原语，禁止退回手写裸标签拼整套状态样式。**

| 原语 | 主要变体 / Props | 适用场景 |
| --- | --- | --- |
| `PageShell` | `maxWidth?: "md" \| "wide" \| "full"` | 独立视图外层滚动区与内容限宽居中 |
| `PaneHeader` | `title`, `subtitle?`, `meta?`, `actions?`, `sticky?` | 页面顶部标准标题栏（`h1` + 徽章 + 右侧操作组） |
| `SplitPane` | `sidebar`, `sidebarWidth?`, `children` | 左右分栏页（Team、Organizations、Materials、Skills 等，`lg` 以下自动堆叠） |
| `Card` 系列 | `Card`（`interactive`, `padding?: "none" \| "sm" \| "md"`）, `CardHeader`, `CardBody`, `CardFooter` | 信息卡、配置分组、列表明细容器；设置/管理面板也可使用 `SettingsCard` / `SettingsDisclosure` |
| `Button` / `IconButton` | `variant?: "primary" \| "secondary" \| "ghost" \| "danger" \| "accent" \| "inline"`, `size?: "xs" \| "sm" \| "md"` | 主操作 CTA 用 `primary`（黑底反色），普通次操作用 `secondary`，行内链接动作或 `accent` 弱强调 |
| `Badge` | `tone?: "neutral" \| "accent" \| "success" \| "warn" \| "danger" \| "info" \| "observer"`, `dot?`, `size?: "xs" \| "sm"` | 状态标记、作用域胶囊、统计数字；禁止再新建 `.pill-*` / `*-badge` 自定义类 |
| `Tabs` | `variant?: "underline" \| "pill"`, `size?: "sm" \| "md"`, `items`, `value`, `onChange` | 页内标签页与筛选条；窄列放置多项 `pill` 筛选时传入 `className="flex-wrap"` 防止裁剪；支持方向键/`Home`/`End` 键盘导航 |
| `FieldGroup` / `Input` / `Select` / `Textarea` | `size?: "sm" \| "md"`, `mono?`, `label?`, `hint?`, `error?` | 所有表单输入控件与标签/错误布局 |
| `EmptyState` | `icon?`, `title`, `description?`, `action?`, `compact?` | 列表为空、无匹配筛选结果、未选择条目 |
| `Banner` | `tone?: "neutral" \| "info" \| "warn" \| "danger" \| "success"`, `title?`, `actions?`, `onDismiss?` | 页面提示条、权限只读说明、悬浮工作台通知 |
| `ModalDialog` | `open`, `onClose`, `title`, `subtitle?`, `size?: "sm" \| "md" \| "lg"`, `footer?`, `closeDisabled?` | 居中确认/表单/预览模态框，内置 `Escape` 关闭与遮罩 |
| `Drawer` | `open`, `onClose`, `title`, `size?: "sm" \| "md" \| "lg"`, `footer?`, `closeDisabled?` | 右侧滑出详情抽屉 |
| `Popover` | `open?`, `onOpenChange?`, `trigger`, `align?: "start" \| "end"`, `side?: "bottom" \| "top"` | 点击外部与 `Escape` 自动关闭的轻量浮动菜单 |
| `BotFaceIcon` / `ErrorBoundary` / `ElapsedTimer` / `ViewFade` | — | AI 角色拟人头像与心情态、视图错误隔离、实时耗时叶子组件、View Transition 淡入 |

---

## 6. 硬性边界与自动化门禁

1. **禁止写 Raw Hex 任意值**：TSX 中严禁出现 `bg-[#...]`、`text-[#...]`、`border-[#...]` 等任意十六进制颜色类；SVG 图形需用 `tokens.css` CSS 变量（如 `var(--border-strong)`、`var(--accent)`）或语义 Tailwind SVG 类。违反将在 `npm run check:css`（[check-css-classes.mjs](../../scripts/check-css-classes.mjs)）直接失败。
2. **所有静态类名必须可解析**：[check-css-classes.mjs](../../scripts/check-css-classes.mjs) 会在离线状态下加载 `@tailwindcss/node` 编译器与样式目录，验证 `apps/web/src` 与 `pa-extensions/*/web` 中的静态 `className` 与 `cn()` 参数；拼错 Tailwind 类名会直接阻断 `npm run check`。
3. **禁止再新增全局业务样式表**：不得恢复 `chat-*.css` / `board.css` / `settings.css` 这类按页面复制布局和按钮的 CSS 文件；确属跨组件全局动画/Markdown 排版，优先审查是否真无法由 Tailwind 工具类或 `tokens.css` 表达。
4. **单文件行数上限 `< 1,000` 行**：[check-file-sizes.mjs](../../scripts/check-file-sizes.mjs) 作为 `npm run check` 的零豁免门禁检查全部源码与 CSS 文件；拆分子组件优先沿域边界落到 `apps/web/src/components/<domain>/`。
5. **E2E 结构标记类约定**：Playwright 测试（[e2e/](../../e2e/README.md)）依赖少量无样式结构标记类定位元素（例如 `.board-member-card`、`.board-post-card`、`.board-event-row`、`.board-graph-node`、`.board-graph-node-filters`、`.sidebar-footer-bar`、`.pill`、`.live`），重构这些组件时必须保留标记类名，若新增/移除需同步核对 `e2e/*.spec.ts` 与 `check-css-classes.mjs` 白名单。
6. **变更后验证与实机抽检**：改前端后至少跑 `npm run format && npm run check && npm run build:web && npm run e2e`；涉及布局、弹窗或分屏的改动，须在隔离沙盒 `npm run start:team:sandbox` 上做真实浏览器查看（不修改 `.data/`）。
