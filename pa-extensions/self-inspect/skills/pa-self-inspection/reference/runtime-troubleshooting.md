# PA Runtime, MCP & Extension Troubleshooting

## 1. Missing Tool in a Worker Turn
1. Check `GET /api/runtime` (or **Settings → 扩展插件**) to verify whether the extension entry exists (`fileStatus: "present"`).
2. Remember PA mounts host extensions **on demand**:
   - `delegation` (`delegate_to_member`) is only mounted when the role has consult targets and is not in architect/observer mode.
   - `space` (`read_space`, `save_space_page`) is omitted for architect mode; `save_space_page` is disabled (`PA_CAN_SAVE_SPACE=false`) for internal specialists and discussion mode.
   - `skill-capture` (`propose_skill`) is only mounted for non-architect, non-discussion lead/internal workers.
3. Check the matter's `runtime_ready` notice to see the exact tool list reported by `worker-runtime` after the `session_start` handshake.

## 2. MCP Server Not Available
- PA passes `--extension builtin:mcp` to Pi workers; MCP server definitions live in Pi's own config (`~/.pi/agent/mcp.json` or trusted workspace `.pi/mcp.json`).
- Verify `GET /api/runtime` under `pi-builtin-mcp` to see which roles declared `mcpDependencies`.
- Never claim an MCP tool ran unless a `tool_execution_end` event with `isError: false` is observed.

## 3. `propose_skill` Confirmed But Not Discovered
- Workspace skills write to `<workspace>/.agents/skills/<name>/SKILL.md` (discovered natively by Pi when `cwd` is the workspace).
- `global`, `org`, and `personal` skills write to `.data/skills/{global,orgs/<orgId>,users/<userId>}/<name>/SKILL.md`.
- `worker-runner.ts` mounts existing scoped directories via `resolveScopedDiscoveredSkillDirs` (`--skill`); verify the matter's `orgId` and triggering user match the target scope.

## 4. `pi-web-access` Search Issues
- Provider priority is `Exa → DeepSeek → Kimi` (`auto`), configurable in **Settings → 扩展插件** or `.env`.
- `worker-runtime` strips per-call `proxy` overrides and tags GitHub `fetch_content` results with `temporary_clone` vs `github_api` evidence.
