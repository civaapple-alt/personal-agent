# PA Progressive Architecture Map

Follow the Three-Ring + Dual-Half layout from outermost symptom to exact owning module:

## 1. Three Rings
- **`packages/contracts/`**: Pure wire types & runtime-neutral helpers (`human-decision`, `skill-proposal`, `session-insights`, `extensions`, `model-selection`). Zero `node:*` or `react` imports.
- **`packages/pi-rpc/`**: Pure Pi RPC subprocess lifecycle & JSON-RPC transport primitives. Zero PA business logic.
- **`packages/extension-api/` & `packages/extension-sdk/`**: Internal full extension contract (`@pa/extension-api`) and curated external author SDK (`@pa/extension-sdk`, API `1.0`).
- **`packages/server/`**: Engine Host (SQLite repos, Git Space repo, Role loader, Pi RPC orchestrator, HTTP/SSE server).
  - `src/roles/` — role templates, capability resolution, atomic `SKILL.md` + `scripts/*` disk writer (`role-package-store.ts`).
  - `src/storage/` — SQLite schema & repos (`matters`, `messages`, `spaces`, `worker_sessions`, `organizations`).
  - `src/rpc/` — `team-tool-bridge.ts` (loopback HTTP trust boundary & argument validation).
  - `src/extensions/` — server extension registry (`registry.ts`) and host runtime assembly (`team-extension/runtime.ts`, `human-question`, `web-access`, `workbench-help`).
  - `src/orchestrator/execution/` — `worker-runner.ts` (Pi RPC spawning, `--extension` / `--skill` mounting, tool dispatch), `matter-dispatch.ts`, `execution-context.ts` (scoped skill discovery).
  - `src/orchestrator/runtime/` — `runtime-info.ts` (`GET /api/runtime`), `session-insights.ts` (`GET /api/runtime/insights`), `workbench-context.ts`, `workspace-customizations.ts`.
  - `src/server/` — composition root (`app.ts`, `boot.ts`, `acl.ts`, `routes/*`).
- **`apps/web/`**: Browser UI client (`api/`, `primitives/`, `components/`, `views/`, `extensions/registry.ts`).
- **`apps/cli/`**: Thin launcher bundled into self-contained `apps/cli/dist/main.js`.

## 2. Extensions Split
- **`pi-extensions/*`** (100% portable, runnable in vanilla Pi): `visualize`, `human-question`, `skill-catalog`, `role-skills`.
- **`pa-extensions/*`** (PA host-only, `pi/` + `server/` + `web/`): `worker-runtime`, `workbench-help`, `space`, `delegation`, `skill-capture`, `workflow`, `self-inspect`, plus host wrappers for `visualize`, `human-question`, `skill-catalog`, `web-access`.

## 3. Enforcement
Run `npm run check:boundaries` (`scripts/check-module-boundaries.mjs`) to verify all cross-ring and extension isolation rules.
