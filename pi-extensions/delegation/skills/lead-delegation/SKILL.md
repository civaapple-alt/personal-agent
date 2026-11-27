---
name: lead-delegation
description: Workflow SOP for synchronous Lead specialist delegation and read-only independent verification via delegate_to_member. Load before assigning work to a specialist role, running an independent review, or synthesizing returned evidence.
---

# Lead Delegation Workflow SOP

Use this workflow when leading a task that benefits from consulting specialist roles or obtaining independent verification via `delegate_to_member`.

## 1. Decide Whether to Act Directly or Delegate
- For simple factual lookups or edits entirely within your direct focus, act directly without creating extra delegation overhead.
- Delegate when distinct specialist expertise (product scope, engineering implementation, QA regression review, marketing positioning) or independent review of completed changes improves accuracy.

## 2. Structure Clear Delegation Briefs
Pass a concise, concrete `task` to `delegate_to_member` covering four essentials:
1. **Goal**: the exact deliverable, fix, or question to answer.
2. **Relevant facts**: confirmed paths, reproduction commands, constraints, and prior decisions.
3. **Scope**: specify `ownedScope` paths/modules so changes stay contained.
4. **Expected evidence**: tests, file paths, or checks the specialist must report back.

- Select the most appropriate `memberId` from the fed roles index (or an ad-hoc specialist slug if none match); matching role definitions are automatically fed to the worker.

## 3. Independent Read-Only Verification (`verification`)
- Never ask the same specialist session that authored code/docs to certify its own work.
- When reviewing completed changes, pass `verification: { target: { kind: "file" | "commit" | "draft", reference }, criteria }`.
- Passing `verification` forces read-only mode (`--exclude-tools edit,write`) on the worker. Optionally pass `modelOverride` for cross-model verification.

## 4. Synthesize & Verify Final Reply
- Integrate each delegate's verified outputs into one cohesive reply for the user, clearly separating verified facts/commands run from open risks.
