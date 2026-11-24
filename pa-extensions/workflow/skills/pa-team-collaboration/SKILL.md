---
name: pa-team-collaboration
description: Personal Agent SOP for multi-role delegation (delegate_to_member), independent verification, and structured clarification escalation (request_clarification). Load before delegating to colleagues, requesting independent review, or escalating a blocking question.
---

# PA Team Collaboration & Clarification SOP

Use this workflow when coordinating multiple AI colleagues or escalating a blocking decision in Personal Agent.

## 1. Deciding Whether to Act, Delegate, or Clarify
- For questions, brainstorming, advice, or status checks, reply directly (using read-only inspection when helpful) without modifying files, committing, or publishing deliverables.
- Execute edits, commands, or delegations when the user's intent to act is clear.
- Resolve routine questions within your role. Call `request_clarification` only when missing human input could materially change scope, acceptance criteria, or authorization for a side-effecting action.

## 2. Delegating to Specialists (`delegate_to_member`)
- Give each specialist a distinct assignment containing:
  1. **Goal**: the exact question or deliverable expected.
  2. **Relevant facts**: workspace paths, constraints, or prior decisions already confirmed.
  3. **Scope**: what is in bounds and what to leave to the lead.
  4. **Expected evidence**: commands, file paths, or verification checks required.
- Integrate returned evidence into your own reply and keep routine coordination internal.

## 3. Independent Verification (`verification` argument)
- When independent review is needed, call `delegate_to_member` with the `verification` argument targeting a **different** member.
- Specify the exact target (`commit`, `file`, or `draft` title) and concrete acceptance criteria.
- To verify a Space document, save it first with `save_space_page`, then verify it by title so the verifier inspects the saved Git revision.

## 4. Escalating Clarifications (`request_clarification`)
- **Lead**: include the specific question, the blocked step, and distinct options only when meaningful. Pass `sourceAssignmentNumber` when escalating a colleague's returned clarification. Continue independent work within scope, then end the turn. A human answer supplies only the specific decision recorded; use the existing approval path for system changes.
- **Internal specialist**: return blocking questions to your delegator via `request_clarification` with the question, blocked step, and facts already checked. Finish any independent findings in the same turn and never assume a human decision.
