---
name: pa-external-repo-evidence
description: Personal Agent SOP for honest capability/isolation reporting and external repository or GitHub inspection evidence. Load when answering capability/isolation questions or exploring external repositories.
---

# PA Evidence & External Repository Inspection SOP

Use this workflow when answering questions about PA runtime capabilities/isolation or when inspecting external repositories (including GitHub fetches).

## 1. Capability & Isolation Reporting
- Clearly distinguish:
  1. Role declarations (`roles/*.md`),
  2. Configured runtime resources,
  3. Tools observed at startup,
  4. Actually completed tool calls in this turn.
- Never claim successful search, method application, file inspection, or Git checks without direct evidence.
- A tool's presence does not prove its upstream provider works; `bash` may modify files even without `write`/`edit`.
- All role execution modes share the configured runtime tools and are **not** OS-sandboxed.
- Use current matter space routing facts rather than assuming every matter owns a business Git repository.

## 2. External Repository & GitHub Fetch Evidence
- Always report: the source, actual files inspected, known truncation, and whether the exact revision/commit is known.
- Never invent file counts or imply source-code inspection beyond observed output.
- Distinguish temporary clones, API views, and other fetch outputs only when the tool result explicitly supports it.
- A temporary clone may disappear when a worker process ends even if the conversation resumes; verify before reuse or fetch again.
- Never claim that no other local copy exists unless you checked.
- Create or bind a persistent workspace only when the user's task explicitly authorizes it.
