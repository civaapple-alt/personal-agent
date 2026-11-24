# 构建与隔离检查脚本

命令均从仓库根运行，具体别名在 [package.json](../package.json)。本目录不承载产品运行策略。

| 脚本与命令 | 输入、输出及执行边界 |
| --- | --- |
| [build-web.mjs](build-web.mjs)：`npm run build:web` | 将 `apps/web/src/main.tsx` 和 HTML 构建到 `apps/web/dist/`，同时复制项目许可及第三方说明，不调用模型 |
| [build-cli.mjs](build-cli.mjs)：`npm run build:cli` | 将 `apps/cli/src/main.ts` 与 `@pa/server`、System One SDK 打包为无 `node_modules` 依赖的自包含 `apps/cli/dist/main.js`，并附带 SDK 许可。由 `npm run build` 调用 |
| [check-module-boundaries.mjs](check-module-boundaries.mjs)：`npm run check:boundaries` | 静态检查 `apps/`、`packages/`、`pa-extensions/`、`pi-extensions/` 之间的三环硬边界与双半边隔离，纳入 `npm run check` |
| [run-tests.mjs](run-tests.mjs)：`npm test` | 在临时 Pi 配置目录运行所有离线测试，避免本机 Pi 软件包影响工具清单；退出时清理目录 |
| [start-team-sandbox.mjs](start-team-sandbox.mjs)：`npm run start:team:sandbox` | 构建网页并在系统临时目录启动独立团队版沙盒（`PA_REQUIRE_AUTH=1`，默认端口 `4399`，退出自动清理除非传 `--keep` 或 `--dir=`）；预置超级管理员、待审核账号、多组织 RBAC 角色（`org_owner`/`org_admin`/`org_member`/`org_viewer`）、公开与受限仓库及跨组织/多版本/私密/受限交付成果、验收反馈与候选经验，不触碰 `.data/`，登录界面保持标准表单 |
| [check-server-startup.mjs](check-server-startup.mjs)：`npm run check:startup` | 需要先构建；源码/编译入口分别检查文件与内存数据库，使用临时工作目录、模板副本、端口并固定绑定 `127.0.0.1`，不继承 `PA_HOST`（Windows 用 junction）。检查 bootstrap、已移除的演示接口、角色隔离、首页与退出；非 Windows 文件库用 `SIGTERM`、内存库用 IPC，Windows 全用 IPC，不派发 AI |
| [check-docs.mjs](check-docs.mjs)：`npm run check:docs` | 零额外依赖，核对仓库 Markdown 的本地链接、章节锚点、npm 脚本与直接 Node 文件入口，包含使用/开发/贡献指南、README/AGENTS 和岗位方法；跳过隐藏目录、依赖与构建物，只读且不运行文档中的命令 |
| [check-open-source.mjs](check-open-source.mjs)：`npm run check:opensource` | 只读核对许可/版本、Git 跟踪路径与有限凭据模式；`--history` 检查可达对象，`--public` 对待审参考图返回非零。匹配值不输出，不检查 `.data/` 内容，不代表穷尽的凭据或权利审查 |
| [package-release.mjs](package-release.mjs)：`npm run package:release` | 从干净、已提交的 HEAD 生成 `.releases/v<版本>/` 的源码包、预构建包、manifest 与 SHA256SUMS。`--preview` 使用独立预览目录。在临时源码快照中借用已安装依赖构建和检查源码入口，移除依赖链接后打包，再解压检查预构建入口。不包含用户数据，不调用模型，不创建标签或发布 |

检查边界如下：

- [release-policy.mjs](release-policy.mjs) 统一开源检查与打包器的私有路径和生成文件规则。打包携带 MIT 许可与第三方说明。公开历史中的素材处理见 [0.6.0 发布说明](../docs/releases/v0.6.0.md)。
- 文档检查器还确认各份 Markdown 可从根 README/AGENTS 的本地链接到达；`dist/` 命令按对应源文件核对，不要求预先构建，也不能据此声称产物已生成。
- 检查器不验证外部 URL、Mermaid 图、产品语义或命令的运行结果；新增别名需同步 package 脚本。
- 声明“已通过启动检查”前必须实际运行启动脚本，不能仅因为入口文件存在就声称启动成功。
- 打包通过 `npm run package:release` 运行时，使用当前 Node 执行 `npm_execpath` 指向的 npm 入口，避免 Windows 把 `npm.cmd` 当作原生可执行文件启动；Windows 需通过 npm 命令进入打包器。Windows 预览验证已纳入 CI，本机 macOS 检查不等于 Windows runner 已通过。

真实 Pi 请求单列于 [src/demo](../packages/server/src/demo/README.md)，离线测试按 [test](../test/README.md)选择。修改脚本时保持临时资源清理和用户数据隔离，不把产物、运行日志或密钥写进源码。
