---
name: pa-self-inspection
description: Use when inspecting Personal Agent (PA) itself, diagnosing recurring tool/command failures, unused Skills, MCP or extension loading issues, or navigating PA's architecture progressively instead of guessing from a single README.
---

# PA Self-Inspection & Session Insights

Never guess how Personal Agent is wired or why a previous run failed from memory alone. Follow this progressive inspection path: **hard runtime evidence first → targeted architecture map → exact source verification**.

## 1. Collect Deterministic Session Insights (Zero-Model, Read-Only)

Run the bundled read-only script to inspect local Pi session `.jsonl` files (automatically masks home paths, tokens, keys, and emails):

```sh
# Analyze recent Pi sessions in .data/sessions/
node pa-extensions/self-inspect/skills/pa-self-inspection/scripts/session-insights.mjs

# Analyze sessions linked to a specific matter ID (reads SQLite read-only)
node pa-extensions/self-inspect/skills/pa-self-inspection/scripts/session-insights.mjs --matter <matterId>

# Machine-readable JSON output
node pa-extensions/self-inspect/skills/pa-self-inspection/scripts/session-insights.mjs --json
```

Look for these deterministic signals before changing prompts or code:
- **Failing commands**: repeated shell failures (often an environment/script issue — fix the root cause or capture a reliable script via `propose_skill`).
- **Unused listed Skills**: Skills injected into `<available_skills>` that are never loaded (prune noisy Skills to save per-turn tokens).
- **File rework / repeated tool calls**: signals missing upfront specs or broken verification loops.
- **Repeated user instructions**: strong evidence to propose a reusable Skill (`SKILL.md` + `scripts/*`) via `propose_skill`.

When running inside a live PA matter, you can also call `read_pa_help` with `topics: ["runtime_tools", "current_matter"]` for live turn facts, and users can view the same insights in **Settings → 运行洞察** (`#/settings/insights` / `GET /api/runtime/insights`).

## 2. Navigate PA Progressively (Do Not Rely on One Summary)

When diagnosing system behavior, read [reference/architecture-map.md](reference/architecture-map.md) first to find the exact owning package and README, then read only the relevant source files:
- Never assume a rule lives in prompts — in PA, session scoping, delegation depth, space publishing, and skill confirmation are enforced in `packages/server` runtime code.
- Distinguish portable `pi-extensions/*` (can run in vanilla Pi) from PA host-bridge `pa-extensions/*` (`pi/` + `server/` + `web/`).

## 3. Troubleshoot Runtime, MCP & Extensions

For missing tools, MCP auth/loading failures, `pi-web-access` provider routing, or `propose_skill` confirmation/discovery issues, read [reference/runtime-troubleshooting.md](reference/runtime-troubleshooting.md).
