## 改动说明

- 要解决的问题：
- 行为变更与影响模块：

## 验证清单（仅勾选实际运行并通过的项目）

- [ ] `npm run check`（Biome 规范检查 + 前后端 TypeScript 类型检查）
- [ ] `npm run build`（服务端与网页构建）
- [ ] `npm test`（离线自动化测试，说明新增或覆盖的用例）
- [ ] `npm run check:startup`（入口或数据库改动时必填）
- [ ] `npm run check:docs`（Markdown 链接、锚点与命令校验）
- [ ] `npm run check:opensource`（无私有路径、无凭据泄露、许可元数据一致）
- [ ] 网页视觉走查（UI 改动时在浏览器实看对应页面）
- [ ] 若运行了 `npm run demo:*` 真实模型验证，请单独写清场景条件、成功/失败项及限制，勿与离线测试混写

## 兼容性与安全核对

- [ ] 未提交 `.data/`、`.notes/`、API 密钥、个人绝对路径或未确认授权的第三方素材
- [ ] 未通过仅改角色提示词替代宿主执行约束或能力校验
- [ ] 相关目录 `README.md` 与 `CHANGELOG.md`（Unreleased）已同步更新
