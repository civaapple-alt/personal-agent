---
name: technical-writing
description: Use when writing or revising a technical document or formal deliverable that needs a clear conclusion and traceable evidence.
---

# Write technical documents and deliverables

Adapted from [pstack technical-writing](https://github.com/cursor/plugins/tree/main/pstack/skills/technical-writing) for Personal Agent's deliverable fields and document structure. See the [third-party notices](../../THIRD_PARTY_NOTICES.md#pstack-derived-writing-method) for attribution and the MIT license.

Put the conclusion, important changes, and verification evidence where a reader can find them on the first pass.

## Write for the reader's decision

- Use short sentences and plain words. Give each sentence one main point. Split nested conditions or long lists. Use actual file paths, modules, commands, and metric names.
- Lead with the conclusion or decision for this version. Give each section one purpose. State the outcome and its boundaries up front, then put the facts, interfaces, rules, and criteria in the body. Put any required actions in a numbered procedure. Put lookup tables, thresholds, and script references in a reference section or appendix. Use headings that name the decision or action.
- Explain the checks or specialist input that support the conclusion, the key trade-offs, what changed since the prior version, and what remains unverified. Cite concise results, commands, and source evidence. Keep full logs, stacks, and tool JSON in the conversation or workspace.

## Structure a formal deliverable

For `publish_deliverable`, use the requested deliverable language.

- Write `changeNote` and `summary` in one to three short sentences. State this version's conclusion, the key change, and the evidence. Aim for about 120 characters in Chinese. Keep long action lists, parameter tables, and path lists in the document body.
- Structure the Markdown body in this order.

  1. **Conclusion and key points.** Use three to five points to state the current result, decisions made, and choices that still need attention.
  2. **Main content.** Organize the details into sections, short lists, or compact tables. Keep paragraphs short.
  3. **Verification and delivery evidence.** Record key checks, specialist findings, version changes, remaining risks, or next actions.
