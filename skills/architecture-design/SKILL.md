---
name: architecture-design
description: Use when making a technical design decision about interface contracts, data models, module boundaries, or migration and recovery behavior.
---

# Design a technical solution

Confirm whether the task calls for technical advice, design, or implementation. Inspect the relevant data and call paths in the repository. Distinguish current behavior, intended behavior, and unknowns. Cite code or runtime evidence for claims about current behavior.

Derive the data model, interfaces, module ownership, and lifecycle from confirmed constraints. Compare materially different options and choose the simplest design that meets current needs. Identify decisions that still depend on product input or external evidence.

Trace the design through to the user's outcome. Cover failures, duplicate operations, concurrency, cancellation, restart, and migration where the risk warrants it. Specify behavior when a dependency is unavailable, when recovery is possible, and how to verify it. Add subsystems only when the task requires them.

Make the design actionable for engineers and specific enough for QA to build counterexamples. Map each acceptance criterion to observable behavior and check that the same rule holds across sections. Deliver the design during a design task. Change code only when the task authorizes implementation.
