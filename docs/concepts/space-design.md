# 资料空间设计

资料空间采用 **每个空间一个独立 Git 仓库**（`<dataDir>/spaces/<spaceId>/`）的方式，统一承载团队在组织、仓库、个人、AI 角色与自定义主题下形成的计划、过程资料与文档修订。

## 五类空间模型

| 类型 (`kind`) | 标识与磁盘路径 | 权限边界与用途 |
| --- | --- | --- |
| `org`（组织默认空间） | `spc_org_<orgId>` → `spaces/orgs/<orgId>/` | 每个组织自动拥有；组织成员可读，非 `org_viewer` 可写 |
| `workspace`（仓库默认空间） | `spc_ws_<workspaceId>` → `spaces/workspaces/<workspaceId>/` | 每个业务仓库自动拥有；沿用仓库访问控制（受限仓库仅授权人与管理员可访问） |
| `user`（人类用户个人空间） | `spc_usr_<userId>` → `spaces/users/<userId>/` | 每个人类用户自动拥有；严格仅本人可读写（连超管亦不可访问他人个人空间）；**私密事项**的资料默认落入发起人个人空间，从物理 Git 仓库层面隔离 |
| `member`（AI 角色空间） | `spc_mem_<memberId>` → `spaces/members/<memberId>/` | 每个 AI 角色自动拥有；沿用角色可见作用域（`global`/`org`/`personal`），承载岗位沉淀与过程资料 |
| `custom`（自定义空间） | `spc_<uuid>` → `spaces/custom/<spaceId>/` | 用户按需创建，可设为组织共享（`org`）或仅自己私密（`private`） |

## 事项路由与仓库文件关联

- **默认空间路由**：私密事项 → 发起人的 `user` 个人空间；非私密且绑定仓库的事项 → 该仓库的 `workspace` 空间；非私密未绑定仓库的事项 → 该组织的 `org` 空间。
- **过程资料写入 Git**：用户手动新建/编辑、或主责岗位调用 `save_space_page` 写入的文档，均直接提交到目标空间的 Git 仓库并生成标准 commit 与 unified diff；编辑时校验基线修订号/提交号，冲突返回 `409` 并保留草稿。
- **五类协作语义类型（`docType`）与单文件/目录条目（`entryKind`）**：空间文档按协作语义分为 `plan`（方案）、`spec`（规格）、`decision`（决策）、`rule`（规范）与 `note`（资料，默认），每个条目支持 **单文件（`file`）** 与 **目录条目（`folder`）** 两种形态。新建单文件落入 `<typeDir>/<docId>.md`；目录条目落入 `<typeDir>/<docId>/`（默认包含入口 `README.md` 与条目级 `.gitignore`，可存放多个参考子文档或静态演示站点 `demo/index.html` 并经受控路由 `/api/spaces/documents/:docId/preview/*` 预览；单文件也可一键转为目录条目）。AI 工具 `save_space_page` / `read_space` 支持可选 `subPath` 读写子文件，前端提供空间内类型筛选与跨空间「最近修改」视图，对话卡片仅对 `plan` 类型的最新一轮结果展示「确认并推进」。
- **关联仓库文件或链接**：`space_documents` 通过可选的 `(linked_org_id, linked_workspace_id, linked_file_path)` 字段记录文档对应的组织、仓库与相对路径（或外部链接）。业务代码仓本身的 `write` / `edit` 变更留在业务仓 Git 与事项事件中，空间不额外维护引用表，也不把业务仓正文双写进空间仓库。

## 经验复盘与后续路线

- 工作台移除了与空间并列且重复的「成果与版本」视图，统一以「资料空间」承载文档与 Git 历史。
- 经验复盘（RSI）在事项协作抽屉中触发，直接基于事项对话与关联空间资料提炼候选经验；后续将沿组织、仓库、角色与自定义空间路线进一步对齐经验归属与沉淀。
