# Third-party notices

Personal Agent's original code, role definitions and documentation are licensed under the root [MIT license](LICENSE). Third-party components retain their own notices and licenses. The project license does not grant rights to third-party names, logos, reference images or separately installed tools and method packs.

## pstack-derived writing method

[pi-extensions/role-skills/skills/deliverable-writing/SKILL.md](pi-extensions/role-skills/skills/deliverable-writing/SKILL.md) adapts the writing method from [pstack](https://github.com/cursor/plugins/tree/main/pstack), including its concise writing and Diátaxis guidance, with project-specific deliverable conventions. Preserve the upstream MIT notice below when redistributing this adaptation.

The optional Pi integration reads an operator-provided method pack, such as [backnotprop/pstack](https://github.com/backnotprop/pstack). Personal Agent does not bundle that external pack; its license and any additional notices remain with it.

```text
MIT License

Copyright (c) 2026 Lauren Tan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Browser runtime dependencies

The built web application bundles React, React DOM and Scheduler. Versions are pinned in [package-lock.json](package-lock.json); the 0.6.0 preparation snapshot uses React/React DOM 19.3.0 and Scheduler 0.28.0. Their MIT license is reproduced below. Build and development dependencies are installed separately and retain the licenses declared in the lockfile and their packages; no `node_modules` directory is included in project release archives.

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Decision SDK

The prebuilt server bundles the MIT-licensed `@typesafe-ai/sdk` from the version pinned in [package-lock.json](package-lock.json). Its license accompanies the compiled module as `apps/cli/dist/typesafe-sdk-LICENSE.txt`.

## ThinkRail `@thinkrail/pi-visualize`, `@thinkrail/pi-next-steps`, `@thinkrail/pi-session-insights`, and `skillCarryover`

The `visualize` tool schema, validation rules, and card presentation in [pi-extensions/visualize](pi-extensions/visualize/README.md) and [pa-extensions/visualize](pa-extensions/README.md), the `suggest_next_steps` portable extension and Web chip flow in [pi-extensions/next-steps](pi-extensions/next-steps/README.md) and [pa-extensions/next-steps](pa-extensions/README.md), the post-compaction Skill carryover design in [pa-extensions/worker-runtime/pi/compaction-carryover.ts](pa-extensions/worker-runtime/pi/compaction-carryover.ts), as well as the deterministic local session-insights rules and privacy-redaction design in [packages/server/src/orchestrator/runtime/session-insights.ts](packages/server/src/orchestrator/runtime/session-insights.ts) and [pa-extensions/self-inspect](pa-extensions/README.md), are adapted from JetBrains ThinkRail (`https://github.com/JetBrains/thinkrail`), licensed under the Apache License, Version 2.0.

## Reference images and external products

These files were saved from Grok Bot's official product materials for local research. No redistribution grant for them has been established in this repository, and they are not covered by Personal Agent's MIT grant:

- `docs/references/grok-bot/official-overview.webp`
- `docs/references/grok-bot/official-learning.webp`
- `docs/references/grok-bot/official-collaboration.webp`

These files remain in the local research notes. The public Git history and release archives omit them. Public documentation links to [the official product site](https://x.ai/bot).

Pi, pstack, Grok Bot and other referenced products are separate projects. References and compatibility work do not imply affiliation or endorsement.
