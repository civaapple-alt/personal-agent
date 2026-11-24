---
name: pa-space-deliverables
description: Personal Agent SOP for writing and updating Git Space documents (save_space_page, read_space) and proposing reusable team experiences (propose_experience). Load before saving a formal Space document or proposing a memory candidate.
---

# PA Space Deliverables & Experience SOP

Use this workflow when creating or revising documents in a PA Git Space or proposing reusable experience candidates.

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

## 4. Proposing Reusable Experience (`propose_experience`)
- Use `propose_experience` with the appropriate `category` and `scope` (`role_general`, `company_private`, or `project_private`) when work reveals a reusable efficiency improvement, troubleshooting method, collaboration agreement, or project rule.
- Treat every newly proposed entry as an unverified candidate until verified by a human or review pass.
