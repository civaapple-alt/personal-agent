# 构建与隔离检查脚本

命令均从仓库根运行，具体别名在 [package.json](../package.json)。本目录不承载产品运行策略。

| 脚本与命令 | 输入、输出及执行边界 |
| --- | --- |
| [build-web.mjs](build-web.mjs)：`npm run build:web` | 将 `web/src/main.tsx` 和 HTML 构建到 `web/dist/`，不调用模型。`npm run build` 另外先编译后端 |
| [check-server-startup.mjs](check-server-startup.mjs)：`npm run check:startup` | 需要先构建；为源码/编译入口分别使用临时数据库和端口，检查 bootstrap、首页、SIGTERM 退出，不发起事项或真实模型请求 |
| [check-docs.mjs](check-docs.mjs)：`npm run check:docs` | 零额外依赖，核对各级 README/AGENTS 的本地链接、章节锚点、npm 脚本与直接 Node 文件入口；只读取文件，不联网或运行文档中的命令 |

文档检查器还确认各级导航可从根入口到达。`dist/` 命令按对应源文件核对，不要求预先构建，也不能据此声称产物已生成。它不验证外部 URL、Mermaid 图、产品语义或命令的运行结果。新增别名需同步 package 脚本；声明“已通过启动检查”前必须实际运行启动脚本，不能仅因为入口文件存在就声称启动成功。

真实 Pi 请求单列于 [src/demo](../src/demo/README.md)，离线测试按 [test](../test/README.md)选择。修改脚本时保持临时资源清理和用户数据隔离，不把产物、运行日志或密钥写进源码。
