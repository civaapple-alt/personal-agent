---
name: skill-design
description: Concise, high-signal principles for authoring, reviewing, and refining Pi Skills (SKILL.md + optional scripts/* and references/*). Use whenever proposing a new Skill via propose_skill, drafting bundled newSkills in propose_role, or editing an existing Skill.
---

# Skill Design Principles

A Skill is an actionable prompt and optional deterministic toolkit for an agent, not a manual. Apply these principles whenever authoring or editing a Skill, and mechanically re-check your draft against each one before proposing it.

## 1. Trigger-First `description`
- `name` must be lowercase kebab-case (`a-z`, `0-9`, `-`, 2–64 chars, e.g. `release-preflight`).
- `description` is the sole discovery trigger (keep under 500 chars): state both **what the Skill does** and **concrete user intents/contexts when to load it**. Keep all "when to use" triggers in `description` so Pi loads it reliably without undertriggering.

## 2. Scope Shapes Abstraction
- Confirm the intended scope **before** drafting `SKILL.md` or `scripts/*`: when the workflow is clearly specific to the current repository (repo-only paths, build/release commands, or codebase conventions), default directly to repository-local without interrupting the user; only ask first when the scope is genuinely ambiguous (e.g., could be repo-local, org-wide, or global).
- Deliberately match the level of abstraction to the target scope:
  - **Repository-local**: concrete repo paths, module names, domain objects, and project commands are appropriate.
  - **Team / organization**: strip single-repo names and private symbols; keep shared tech-stack conventions and reusable scripts.
  - **Universal / global**: pure, repo-agnostic and stack-agnostic methodology — avoid repo-specific examples or single-stack hardcoded scripts unless clearly marked optional.
  - **Personal**: match the individual's workflow and preferences without over-generalizing.

## 3. One Home per Fact (Single Source of Truth)
- Keep each rule, schema, or checklist in one authoritative place and point to it rather than restating it across files.
- When drafting a bundled Skill for a role (`propose_role`), keep role identity/boundaries in the role definition and put only the reusable procedure or checklist in the Skill.

## 4. Progressive Disclosure & Lean Body
- Structure Skills in three levels:
  1. **Metadata** (`name` + `description`): always in context, sharp and compact.
  2. **`SKILL.md` body**: loaded on trigger — use imperative, ordered steps, concrete output templates or short examples, and explain *why* key constraints matter instead of piling up heavy-handed "MUST NOT" walls.
  3. **Bundled resources**: move deterministic, repetitive steps into executable `scripts/<name>` (with shebang; prefer existing CLI tools when adequate) and deep reference tables into `references/*` loaded on demand.

## 5. Cut No-Op Statements & One-Off Bandaids
- Remove filler or statements not needed for the Skill to work. If an updated instruction already clearly says "do Y", skip redundant "do not do X" guardrails.
- Solve the underlying class of problem where the fact is owned instead of patching one narrow symptom — generalize accurately without overgeneralizing.

## 6. Verify & Lack of Surprise
- For Skills with objectively verifiable outputs (checks, transforms, fixed workflows), include 1–2 realistic test prompts or verification criteria so the Skill can be checked on real inputs.
- Never hide unexpected side effects, destructive commands, or undisclosed external actions inside a Skill or script.
