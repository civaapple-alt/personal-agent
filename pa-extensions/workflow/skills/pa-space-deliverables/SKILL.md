---
name: pa-space-deliverables
description: Personal Agent SOP for writing and updating Git Space documents (save_space_page, read_space) and proposing reusable Skills or scripts (propose_skill). Load before saving a formal Space document or proposing a Skill.
---

# PA Space Deliverables & Skill Capture SOP

Use this workflow when creating or revising documents in a PA Git Space or proposing reusable Skills and helper scripts.

## 1. Space Documents vs. Business Repository Files
- Each PA Space is backed by its own Git repository. Use `save_space_page` for useful plans, working notes, reviews, and formal deliverables (pass `sourcePath` when linking a repository file instead of duplicating content manually).
- Business repository code edits via `write`/`edit` stay in the business repository itself.
- Keep routine replies and clarifications in the conversation rather than creating noisy Space pages.

## 2. Reading Before Updating
- Always call `read_space` on an existing page before updating it, and pass its current `revision` to avoid overwriting concurrent human edits.
- Complete necessary verification checks in the same turn before saving.

## 3. Document Structure & `changeNote`
- **`changeNote`**: write 1–3 concise sentences stating the conclusion, key changes, and verification evidence.
- **Document body**:
  1. Start with the key points / executive summary.
  2. Develop the body in clear sections.
  3. End with a short account of checks run, observed results, and remaining limits.
  4. Leave full raw logs in the conversation or workspace rather than pasting them into the document.

## 4. Proposing Reusable Skills & Scripts (`propose_skill`)
- Use `propose_skill` when work establishes a reusable convention, troubleshooting playbook, multi-step workflow, or deterministic helper script (`scripts/<filename>`) that should be one-shot repeatable next time.
- Choose the narrowest accurate `storageScope`: `workspace` (`.agents/skills/` inside the bound repository), `personal`, `org`, or `global`.
- `propose_skill` never writes directly to disk; it surfaces a confirmation card so the user can review and approve saving `SKILL.md` and scripts.
