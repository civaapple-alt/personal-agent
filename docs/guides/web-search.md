# 为 AI 岗位启用网页检索

在工作台打开「设置 → 扩展插件 → pi-web-access」。网页检索供应商由 Pi 扩展配置，岗位仍沿用 PA 里的模型选择。 [Pi 软件包目录](https://pi.dev/packages/pi-web-access)

1. 用超级管理员账号点「通过 Pi 安装」。如果服务账号已经安装，卡片会显示版本。
2. 安装后默认允许全部 AI 业务岗位（包含后续新建的角色）使用网页检索；如需单独停用某个岗位，取消对应勾选并点「保存配置」，从下一次运行生效。
3. 给获授权的岗位安排一条查询，要求它提供网页标题和来源链接。主责、内部委托和讨论回复都可使用。

也可以在运行 PA 的同一系统账号中安装，然后刷新设置。

```sh
pi install npm:pi-web-access
pi list
```

## 检索密钥与默认供应商顺序

PA 在「设置 → `.env 密钥配置`」（或项目根目录 `.env`，参考 [.env.example](../../.env.example)）支持管理以下 3 个网页检索密钥，且仅注入已获 `pi-web-access` 授权的岗位进程：

| 优先级（`auto` 模式） | 环境变量 | 对应供应商 | 说明 |
| --- | --- | --- | --- |
| `#1` | `EXA_API_KEY` | `exa` | Exa 公开网页搜索 |
| `#2` | `DEEPSEEK_API_KEY` | `deepseek` | DeepSeek Search API（`https://api.deepseek.com/v1/tools/search`） |
| `#3` | `MOONSHOT_API_KEY` | `kimi` | Moonshot / Kimi 搜索 |

- **默认顺序**：未显式指定时（`webSearchProvider = "auto"`），PA 按 **`Exa → DeepSeek → Kimi`** 顺序自动选用第一个已配置密钥的供应商，并通过 `PA_WEB_SEARCH_PROVIDER` 注入 `web_search` 默认参数；若 3 个环境变量都未配置，则交由 `pi-web-access` 自身的 `~/.pi/agent/web-search.json` 或 `/login kimi-coding` 决定。
- **手动指定**：超级管理员可在「设置 → 扩展插件 → `pi-web-access`」的「默认搜索供应商」下拉框中显式固定为 `DeepSeek Search`、`Exa Search` 或 `Moonshot / Kimi`，保存后下次运行生效。

## 使用已有的 Kimi Code 登录

在 Pi 中通过 `/login kimi-coding` 完成登录。将以下字段合并到服务账号的 `~/.pi/agent/web-search.json`。如通过 `PI_CODING_AGENT_DIR` 指定了配置目录，在该目录中使用同名文件。

```json
{
  "provider": "kimi",
  "webSearch": { "allowedProviders": ["kimi"] }
}
```

岗位可以用 OpenCode Go 的 DeepSeek 模型回复，同时通过 Kimi 搜索。Kimi 搜索使用 Kimi Code Plan 的额度。查询和搜索供应商的回包经过 Pi 扩展处理。 [Kimi 搜索配置](https://github.com/nicobailon/pi-web-access#kimi-code-plan)

## 核对运行状态

安装成功后仍需保存岗位授权。PA 启动获授权的岗位时核查 `web_search`、`get_search_content` 和 `fetch_content`，因此应在扩展配置中保留这三个工具及其默认名称。卡片有安装异常时，在服务账号中运行 `pi list` 核对包入口。

PA 将网页搜索设为直接返回搜索结果，关闭按次指定代理；`fetch_content` 允许抓取公开 HTTP/HTTPS 网页正文（由 `pi-web-access` 阻止内网地址与非 HTTP(S) 协议）。旁听、独立验收、角色设计和经验提炼沿用各自的窄工具配置。 [Pi 扩展装配](../../pi-extensions/README.md)
