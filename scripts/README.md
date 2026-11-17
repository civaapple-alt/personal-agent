# 构建与隔离检查脚本

命令均从仓库根运行，具体别名在 [package.json](../package.json)。本目录不承载产品运行策略。

| 脚本与命令 | 输入、输出及执行边界 |
| --- | --- |
| [build-web.mjs](build-web.mjs)：`npm run build:web` | 将 `web/src/main.tsx` 和 HTML 构建到 `web/dist/`，同时复制项目许可及第三方说明，不调用模型。`npm run build` 另外先编译后端 |
| [check-server-startup.mjs](check-server-startup.mjs)：`npm run check:startup` | 需要先构建；源码/编译入口分别检查文件与内存数据库，使用临时工作目录、模板副本和端口。检查 bootstrap、文件库的演示准备、内存库的角色创建隔离、首页与 SIGTERM 退出，不派发 AI 或调用模型 |
| [check-docs.mjs](check-docs.mjs)：`npm run check:docs` | 零额外依赖，核对仓库 Markdown 的本地链接、章节锚点、npm 脚本与直接 Node 文件入口，包含使用/开发/贡献指南、README/AGENTS 和岗位方法；跳过隐藏目录、依赖与构建物，只读且不运行文档中的命令 |
| [check-open-source.mjs](check-open-source.mjs)：`npm run check:opensource` | 只读核对许可/版本、Git 跟踪路径与有限凭据模式；`--history` 检查可达对象，`--public` 对待审参考图返回非零。匹配值不输出，不检查 `.data/` 内容，不代表穷尽的凭据或权利审查 |
| [package-release.mjs](package-release.mjs)：`npm run package:release` | 从干净、已提交的 HEAD 生成 `.releases/v<版本>/` 的源码包、预构建包、manifest 与 SHA256SUMS；`--preview` 改用 `.releases/previews/v<版本>-<提交>/`，不占用正式目录。在临时源码快照中借用已安装依赖构建，移除依赖链接后打包，再解压检查源码/编译入口启动。不包含用户数据，不调用模型，不创建标签或对外发布；重复执行只核验已有产物，不覆盖它们 |

检查边界如下：

- [release-policy.mjs](release-policy.mjs) 统一开源检查与打包器的私有/生成路径规则；打包必须携带 MIT 许可与第三方说明。素材归档排除与完整历史公开范围不同，见 [0.6.0 准备说明](../docs/releases/v0.6.0.md)。
- 文档检查器还确认各份 Markdown 可从根 README/AGENTS 的本地链接到达；`dist/` 命令按对应源文件核对，不要求预先构建，也不能据此声称产物已生成。
- 检查器不验证外部 URL、Mermaid 图、产品语义或命令的运行结果；新增别名需同步 package 脚本。
- 声明“已通过启动检查”前必须实际运行启动脚本，不能仅因为入口文件存在就声称启动成功。

真实 Pi 请求单列于 [src/demo](../src/demo/README.md)，离线测试按 [test](../test/README.md)选择。修改脚本时保持临时资源清理和用户数据隔离，不把产物、运行日志或密钥写进源码。
