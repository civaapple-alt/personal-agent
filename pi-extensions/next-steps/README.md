# Portable `next-steps` Pi Extension

Zero-dependency portable Pi extension registering `suggest_next_steps`, allowing an agent to finish a turn with 2–4 concrete one-click follow-up suggestions (e.g., requesting independent QA verification, capturing a proven workflow as a Skill, or advancing to the next implementation step).

Adapted in spirit from JetBrains ThinkRail's `@thinkrail/pi-next-steps` (Apache-2.0).

## Usage in vanilla Pi

```bash
pi --extension ./pi-extensions/next-steps/index.ts
```

In RPC / GUI hosts (such as Personal Agent), the structured `details.suggestions` payload is surfaced as clickable chips above the composer.
