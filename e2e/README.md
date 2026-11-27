# End-to-End (E2E) Verification

Personal Agent organizes automated checks into three explicit tiers so fast offline gates never accidentally spend paid model tokens or touch local user data:

| Tier | Command | Runtime & Cost | What it covers |
| --- | --- | --- | --- |
| Unit & HTTP offline tests | `npm test` | Node `node:test`, stubbed Pi RPC, 0 model tokens | Storage, ACLs, orchestrator loops, route handlers, frontend utilities ([test](../test/README.md)) |
| Real-browser E2E (no-agent) | `npm run e2e` | Built `apps/web/dist` + real isolated server + headless Chrome, 0 model tokens | Real SPA rendering, navigation, `0.9.0` Board UI & SSE live push, Team Sandbox RBAC |
| Opt-in live / workflow E2E | `npm run e2e:live` | Spawns real Pi CLI (`packages/server/src/demo/*`), paid tokens except `--dry-run` | Real LLM tool calls, delegation, trust lifecycle, Board multi-agent orchestration ([demo](../packages/server/src/demo/README.md)) |

## Isolation Guarantees

Every `npm run e2e` spec boots its own PA host through [server.ts](fixtures/server.ts) and tears it down after each test:

- Allocates an ephemeral `127.0.0.1` port (`0` -> assigned free port).
- Creates a disposable `mkdtemp` root directory for SQLite (`PA_DB_PATH`), Git spaces (`spaces/`), workspaces (`PA_WORKSPACES_ROOT`, `PA_DEFAULT_WORKSPACE_DIR`), and sessions (`PA_SESSION_DIR`) — never reads or mutates `.data/`.
- Isolates Pi runtime configuration with `PI_CODING_AGENT_DIR=<temp>/pi-agent`, `PI_OFFLINE=1`, and `PA_LOCAL_PI_RESOURCES=0`.
- Attaches `page.on("pageerror")` to fail on any uncaught browser exception.

## Browser Resolution

[browser.ts](fixtures/browser.ts) resolves a browser binary in priority order without forcing duplicate Chromium downloads when Chrome is already installed:

1. `PA_E2E_CHROME_BIN` or `CHROMIUM_BIN` environment variable.
2. Playwright's downloaded Chromium (`chromium.executablePath()`).
3. Standard system Chrome/Chromium paths (`/Applications/Google Chrome.app/...`, `/usr/bin/google-chrome`, `/usr/bin/chromium`).

If no bundled Chromium exists yet on a headless CI host without system Chrome, run `npx playwright install chromium`.

## Real-Browser Specs (`e2e/*.spec.ts`)

- [workbench-personal.spec.ts](workbench-personal.spec.ts): personal-mode cold start, sidebar view navigation (`资料空间`, `AI 团队`, `设置`), initiation Lead/Board toggle, and in-matter `lead` ↔ `board` switching.
- [board-ui.spec.ts](board-ui.spec.ts): seeded multi-round `0.9.0` Board UI verification — coordinator pin without retire button, `隐藏非活跃` toggle, collapsed `已退场` expansion, pause/resume, `waiting`-only model hot-swap modal, `working` swap guard, one-click non-coordinator retire, `公告板` filter/search/lazy Markdown body/composer, `关系图` SVG & `@agentId` jump, cursor-paginated `事件轨迹` with `monitor_alert`, and live `/api/events` SSE push without reload.
- [team-sandbox-rbac.spec.ts](team-sandbox-rbac.spec.ts): `PA_REQUIRE_AUTH=1` seeded via [start-team-sandbox.mjs](../scripts/start-team-sandbox.mjs) — `AuthGateView` login, `org_owner` vs `org_viewer` multi-org Space isolation, and read-only Board ACLs (`403` on direct post).

Debug visually with `npm run e2e:headed` or inspect failed Playwright traces via `npx playwright show-report playwright-report`.

## Live Workflow Harness (`e2e:live`)

[run-live.ts](run-live.ts) wraps all cataloged scenarios in [catalog.ts](live/catalog.ts) with deterministic exit verdicts (`PASS`, `REVIEW_PENDING`, `FAIL` — never LLM-judged) and appends structured JSONL run logs to gitignored `e2e/.live-runs.jsonl`:

```bash
npm run e2e:live -- --list
npm run e2e:live -- --scenario board --dry-run
npm run e2e:live -- --scenario board
```
