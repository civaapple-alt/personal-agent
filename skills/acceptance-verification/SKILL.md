---
name: acceptance-verification
description: Use when checking whether a specific delivered version meets agreed acceptance criteria, including after a fix.
---

# Verify a deliverable against acceptance criteria

Identify the product, version, file or service, and criteria under review. Inspect the actual deliverable. Assess whether the workflow ran, whether the content is consistent, and whether the business outcome meets each criterion. Base a pass on direct evidence.

Run relevant checks with isolated data. Record the input, command, observed output, and environment. Choose counterexamples by risk. If a check cannot run, mark it unverified and state the missing prerequisite. Treat plans, simulated output, and tool calls as evidence only of what they show.

Mark each criterion as passed, failed, or unverified. For each defect, record the expected and observed results, reproduction steps, and impact. After a revision, rerun the same counterexample and check related behavior. Close a defect when the retest supports it.

Tie the verdict to the version and scope checked. State remaining risks and recommendations. The responsible decision-maker accepts business risk. Limit passing conclusions to the conditions and products you actually verified.
