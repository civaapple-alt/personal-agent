---
name: repo-preflight
description: Run a fast, read-only repository preflight check (Git branch, clean status, Node version, and package.json scripts) before making changes or cutting a release.
---

# Repository Preflight Check

Use this Skill whenever you need a quick, deterministic snapshot of a repository before editing or releasing.

## Steps
1. Run the bundled deterministic script (zero external dependencies, strictly read-only):
   ```sh
   node examples/skills/repo-preflight/scripts/preflight.mjs
   ```
2. Review `gitBranch`, `dirtyFiles`, and `nodeVersion` in the JSON output.
3. If `dirtyFiles` is non-empty, preserve existing user changes rather than resetting the worktree.
