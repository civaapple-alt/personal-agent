---
name: pa-pi-runtime-tuning
description: Use when auditing, verifying, or optimizing Personal Agent's real Pi RPC runtime context, prompt-cache stability, tool surface, role isolation (`solo` vs `business`), or Skill discovery (`skill-catalog`, `pstack`/`poteto-mode`).
---

# PA Real-Pi Runtime Auditing & Context Tuning

Verify and tune how Personal Agent actually launches Pi RPC workers, injects `PA_MEMBER_CONTEXT` / `PA_TURN_CONTEXT`, registers tools, and discovers Skills — using real Pi measurements rather than mocks alone.

## 1. Measure Before Tuning

Never guess context size or tool lists from source code alone; inspect actual Pi RPC payloads:

- **Compare `solo` vs `business` runtime context & tools**:
  ```bash
  npm run demo:solo
  ```
  Captures exact `PA_MEMBER_CONTEXT`, `PA_TURN_CONTEXT`, CLI `args`, and `runtime_ready` observed tools for `pi-default` (`roleKind: solo`) vs `product-manager` (`roleKind: business`).
- **Verify lazy team capability lookup + prompt-cache hit rate**:
  ```bash
  npm run demo:team:capabilities
  ```
  Inspect the saved `result.json` (`events` → `tool_execution_start`/`end` for `read_team_roles` and `runtime_model_usage` → `cacheRead` / `input`). Completion alone is not a quality pass.
- **Verify `pstack` / `poteto-mode` and leaf skill loading**:
  ```bash
  npm run demo:pstack -- --source ~/.pi/agent/git/github.com/backnotprop/pstack
  npm run demo:pstack:selection -- --source ~/.pi/agent/git/github.com/backnotprop/pstack --case how
  npm run demo:pstack:selection -- --source ~/.pi/agent/git/github.com/backnotprop/pstack --case why
  ```
  Always inspect the retained `report.json` / `turns.json` tool calls to see whether the model used `load_available_skill`, `list_available_skills`, or direct `read` on `../<skill>/SKILL.md`.

## 2. Context & Prompt-Cache Checklist

1. **Keep `PA_TURN_CONTEXT` cache-stable**:
   - `pa-extensions/worker-runtime` deduplicates `<pa_runtime_context>` by exact string equality (`previous?.content !== content`).
   - Do NOT embed volatile timestamps (`createdAt`), turn IDs (`sourceUserMessageId`), or full 40-tool startup lists inline into `PA_TURN_CONTEXT`. Put a compact, coarse-state index in `PA_TURN_CONTEXT` and expose full details on demand via a tool (e.g., `read_team_roles({ includeCapabilities: true })`).
2. **Bound and paginate Skill catalogues (`pi-extensions/skill-catalog`)**:
   - Deduplicate against Pi's native `<available_skills>`; return `""` (zero prompt injection) when no additional manual skills remain.
   - Use compact single-line entries (`- <name>: <desc>`) without repeating long package URLs on every line.
   - When truncated, emit `hasMore=true` with exact `offset` pagination guidance, and support `{ query, source, offset, limit }` + `hasMore`/`nextOffset` in `list_available_skills` (omit absolute `path` unless duplicate names exist).
3. **Avoid TUI-only slash commands in RPC**:
   - In headless PA Web (Pi RPC without TUI), extension slash commands (like `/mcp`, `/websearch`) are mostly interactive TUI menus without completion receipts. Expose real capabilities via Pi `registerTool` instead.
4. **Separate domain role definitions from runtime coordination**:
   - `roles/*.md` should describe domain responsibilities, methods, anti-jobs, and quality standards only.
   - Runtime participation rules (`## Matter lead coordination`, `## Internal delegation`, `## Independent verification`, `## Observer participation`) belong in `packages/server/src/orchestrator/execution/prompts.ts` keyed by `sessionMode`.
5. **Recognize both `load_available_skill` and direct `read` as skill-read evidence**:
   - Composite skills like `poteto-mode` instruct agents to read sibling leaf skills via relative paths (`../<name>/SKILL.md`). Evidence checks (such as `pstack-evidence.ts`) should accept both `load_available_skill` (SHA-256 + full text) and direct `read` of the exact `SKILL.md` text.

## 3. Verification Gate After Any Runtime Change

Run offline gates first, then the relevant real-Pi smoke demo:

```bash
npm run check && npm run build && npm test && npm run check:docs
```

Report exact before/after character counts, tool counts, cache-read ratios, and any remaining limitations honestly.
