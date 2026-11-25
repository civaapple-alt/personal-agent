---
name: pa-trust-capture
description: Personal Agent SOP for Step 2 of the Four-Step Trust progression — capturing proven workflows, user corrections, and deterministic helper scripts via propose_skill (SKILL.md + scripts/*). Load before calling propose_skill.
---

# PA Trust Capture SOP (`propose_skill`)

Personal Agent follows a four-step trust progression: **probe first → capture as Skill / script → grant scoped authority → run autonomously**. Use `propose_skill` to complete Step 2 cleanly.

## 1. When to Call `propose_skill`
- A multi-step workflow, troubleshooting playbook, or user-corrected rule just succeeded with concrete evidence and is worth making one-shot repeatable next time.
- A repetitive, deterministic step (data parsing, preflight check, report formatting, API query) can be distilled into a small helper script under `scripts/<safe-filename>` so future runs do not re-derive it from scratch.
- Do **not** propose trivial one-off status notes or unverified guesses.

## 2. Choosing `storageScope`
Pick the narrowest accurate scope:
- **`workspace`** (`<workspace>/.agents/skills/<name>/`): repository-specific commands, release checks, or codebase conventions that belong in Git alongside the project.
- **`personal`** (`.data/skills/users/<userId>/<name>/`): individual working style, formatting preferences, or personal automation.
- **`org`** (`.data/skills/orgs/<orgId>/<name>/`): cross-repository standards shared across the organization.
- **`global`** (`.data/skills/global/<name>/`): general methodology useful across all organizations and projects.

## 3. Authoring Quality `SKILL.md` + `scripts/*`
- Follow the `skill-design` Skill for authoring principles (trigger-first `description`, one home per fact, progressive disclosure, no no-op guardrails or one-off bandaids, and verification).
- Attach `scripts` only when deterministic code beats prose (prefer existing CLI tools when adequate); mark runnable scripts with `executable: true` and include a shebang (e.g. `#!/usr/bin/env node` or `#!/usr/bin/env bash`).

## 4. Human Confirmation & Graduated Trust (Steps 2 → 3 → 4)
- **Step 2 (`propose_skill`)**: never writes directly to disk during execution. It stages a confirmation card so the user can inspect `SKILL.md`, review `scripts/*`, adjust scope, and explicitly approve writing to disk. Once approved, Pi natively discovers the saved Skill on subsequent turns.
- **Step 3 (Graduated confirmation / `confirm`)**: newly approved Skills with `scripts/*` default to `confirm` policy. When a role runs a managed Skill script via `bash`, PA's Pi `tool_call` gate pauses and asks the user via a confirmation dialog to allow once, deny, or promote to autonomous.
- **Step 4 (Autonomous execution / `autonomous`)**: once the user promotes the Skill (either from the confirmation dialog or in **Settings → 技能与信任**), roles can execute its vetted scripts autonomously within its scope, with run count and last outcome tracked and one-click downgrade/disable always available.
