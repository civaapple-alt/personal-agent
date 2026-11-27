---
name: board-collaboration
description: Workflow SOP for multi-agent Board coordination using spawn_board_agent, post_to_board, and read_board_post. Load when decomposing parallel tasks, assigning non-overlapping ownedScope, enforcing read-only independent verification, or resolving @user escalations.
---

# Board Collaboration Workflow SOP

Follow this workflow when operating as the root Coordinator or a spawned team member on a collaboration board.

## 1. Coordinator Setup & Decomposition
- Form builders and at least one independent **read-only Verifier** (`boardRole: "verifier"`) with `spawn_board_agent`.
- Give every `builder` a clear mission `brief` and non-overlapping `ownedScope` paths so parallel agents never edit the same files.
- Give the `verifier` concrete `acceptanceCriteria` (files, behavior, and test commands to run). Pass `modelOverride` when heterogeneous cross-model verification is appropriate.
- When matching role definitions exist (`roles` package / `<cwd>/roles/`), pass `sourceMemberId` so the worker inherits role boundaries.

## 2. Asynchronous Wakeup & Lazy Loading
- Kick off execution with `post_to_board` using `kind: "assign"`, a concise one-line `summary`, detailed instructions in `body`, and explicit `mentions` (e.g. `["builder-1"]`).
- When woken up with incremental post summaries, call `read_board_post(postNo)` only for referenced posts where `hasBody` is true and details are needed.

## 3. Builder <-> Verifier Rework Loop & Anti-Self-Verification
- Builders implement and check changes only within `ownedScope`, then post `kind: "handoff"` referencing prior post numbers and mentioning the Verifier.
- Verifiers have `edit` and `write` tools stripped (`--exclude-tools edit,write`). Inspect files and run verification commands directly.
- Never issue `verify_pass` targeting your own work or referencing a post you authored (`validateVerification` rejects self-verification).
- If checks fail, post `kind: "verify_rework"` mentioning the builder (`verification.verdict: "rework"`) so the rework cycle completes before bothering `@coordinator`.
- When all criteria pass, post `kind: "verify_pass"` with `verification: { target, verdict: "pass", criteria }` mentioning `@coordinator`.

## 4. Blocking Decisions & Closing
- Use `post_to_board` with `kind: "clarification"` and `mentions: ["user"]` only when human input changes scope, criteria, or risk tolerance.
- Coordinator integrates verified outcomes (`artifacts`, failing/passing command outputs, remaining risks) into a concise final response.
