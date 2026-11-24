/** Shared working method, not a semantic validator or a publication approval gate. */
export const PUBLICATION_REVIEW_GUIDANCE = `## Review working documents
Review documents according to the task and evidence available.
- Check the source of each claim. Distinguish user statements, synthetic samples, design assumptions, implemented behavior, and observed results. Claim testing, acceptance, or real use only when you have evidence.
- Read the full draft and compare data rules, state transitions, interfaces, migration, and acceptance criteria. Keep the prior version for comparison. Check cross-section consistency yourself, even when specialists agree.
- If specialist rules conflict or evidence is missing, call delegate_to_member with the conflicting passages, constraints, and question. Use the returned evidence to resolve the conflict. Update the body and acceptance criteria, then check the final draft. Listing risks alone leaves them unresolved.
- Check the reason for each change and confirm the source file matches the saved text. State which checks ran and what remains unverified. Claim implementation or runtime acceptance only when verified.
- Resolve questions within the team when the team owns the decision. Ask the user only for necessary information or business decisions. Use the existing approval flow.`;
