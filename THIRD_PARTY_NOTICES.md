# Third-party notices

Personal Agent's original code, role definitions and documentation are licensed under the root [MIT license](LICENSE). Third-party components retain their own notices and licenses. The project license does not grant rights to third-party names, logos, reference images or separately installed tools and method packs.

## pstack-derived writing method

[skills/technical-writing/SKILL.md](skills/technical-writing/SKILL.md) adapts the writing method from [pstack](https://github.com/cursor/plugins/tree/main/pstack), including its concise writing and Diátaxis guidance, with project-specific deliverable conventions. Preserve the upstream MIT notice below when redistributing this adaptation.

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

## Reference images and external products

These files were saved from Grok Bot's official product materials for local research. No redistribution grant for them has been established in this repository, and they are not covered by Personal Agent's MIT grant:

- `docs/references/grok-bot/official-overview.webp`
- `docs/references/grok-bot/official-learning.webp`
- `docs/references/grok-bot/official-collaboration.webp`

They were moved out of the tracked source tree into gitignored `.notes/references/`; `.gitattributes` also excludes any `docs/references/grok-bot/*.webp` pattern from `git archive` and the source/prebuilt archives derived from it, while public-facing documentation uses official source links (`https://x.ai/bot`). Untracking does not remove files from prior local Git commits; before publishing an existing Git history, establish permission or prepare a clean public snapshot that omits those historical objects.

Pi, pstack, Grok Bot and other referenced products are separate projects. References and compatibility work do not imply affiliation or endorsement.
