---
name: team-review-loop
description: Use when orchestrating a multi-role implementation and independent verification loop across PA teammates (single writer, evidence-based P0/P1/P2 review, bounded fix rounds, and Space handoff).
---

# Team Review Loop

Run a lead-orchestrated, evidence-driven implementation and verification loop across PA team roles.

## Principles
- **Single writer per workspace**: Only one colleague should modify code in the active workspace at a time. Run parallel delegations only for read-only recon, research, or independent review.
- **Structured Space handoff**: Save the confirmed spec or plan to the matter's Git Space (`save_space_page`) and pass its document ID in `delegate_to_member({ handoffDocumentIds: [...] })` rather than relying on lossy verbal summaries.
- **Evidence over severity**: Independent reviewers report only concrete defects backed by source proof, test output, or contract contradictions (`P0` blocks release, `P1` fix before release, `P2` report-only note) and end with `BLOCK`, `OK`, or `OK with notes` (or `No issues found.`).

## Workflow
1. **Confirm scope & handoff contract**
   - Ensure goal, acceptance criteria, and constraints are clear; use `request_clarification` if an unapproved product or scope decision blocks work.
   - If a durable spec or plan exists in Space, note its `pageId` for `handoffDocumentIds`.
2. **Single-writer implementation pass**
   - Delegate the concrete change slice to the implementing role (e.g., `engineering-manager`) via `delegate_to_member` with `handoffDocumentIds` when applicable.
   - Require changed files, commands run with exit codes, and observed validation evidence.
3. **Independent verification pass (max 3 rounds)**
   - Delegate independent review to a different member (e.g., `qa-manager`) using `delegate_to_member` with `verification: { assignmentNumber, target, criteria }` and `handoffDocumentIds`.
   - Synthesize returned findings into `P0` blockers, `P1` required fixes, and `P2` deferred notes.
   - If a finding exposes an unapproved scope or architecture tradeoff, stop and ask the user via `request_clarification`.
4. **Focused fix & re-check**
   - Only launch a follow-up fix pass when concrete `P0` or required `P1` issues exist.
   - On re-verification, check only whether the named findings were resolved and whether the fix introduced regressions in its blast radius.
   - Stop early as soon as `P0` and required `P1` findings are clear (or after 3 rounds).
5. **Summarize & archive**
   - Report rounds completed, verified evidence, any deferred `P2` items, and remaining unverified gaps directly to the user. Save formal deliverables to Space when requested.
