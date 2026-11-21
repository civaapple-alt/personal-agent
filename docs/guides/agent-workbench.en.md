# Workbench features at a glance

This guide ships with PA. The [user guide](user-guide.md) covers the full workbench UI.

## Matters and dispatch

Use the composer to ask a question, discuss a proposal, or assign work. Mention a role with `@` to select a recipient for the turn. A clear work request starts a turn when the sender has permission. Set the matter lead in the collaboration members panel.

For example, ask QA to run the login regression and record failures to assign work. Ask which login cases to cover for advice. Use Stop execution to interrupt an active turn.

## Collaboration and observers

The matter lead replies by default. Use `@` to address a teammate or an AI role. When AI observers are enabled, selected AI collaborators can contribute relevant findings after the reply. The lead still responds and delegates according to the matter settings when observers are off. Open the turn’s delegation details to see assignments and reports.

## Decisions

Suppose you ask AI to verify sign-in and the test scope is open. A decision card can ask whether to include password recovery.

1. The assigned respondent selects “Include password recovery” and submits the answer.
2. The card shows that it was answered and records who answered and when.
3. AI can resume with the selected scope when the matter is idle and dispatch is allowed. An authorized member can continue a saved answer if it has not resumed.

If a card asks whether to start execution, Start execution dispatches the original request. Discuss first continues in read-only mode. The pending decisions panel links to cards waiting for an answer.

Ask for a decision card demo and open the trial below the help reply to submit a sample answer.

## Roles and permissions

Open Role Architect or invite it from the collaboration members panel. Review each proposed role, its responsibilities, tools, availability scope, and intended matter participation before confirming. Creating a role and adding it to a matter are separate choices.

## Deliverables and feedback

The lead of an authorized work turn can publish deliverables. Open the matter's deliverable library from the header menu and expand the version history to see earlier versions. Leave feedback on a version to help the lead revise it and publish a new version.

## Models, repositories, and capabilities

Use the composer model picker to select the lead's model for the matter. Authorized administrators configure organization role and platform defaults. Select the matter's repository in its settings.

Web search requires administrator setup and a role grant. The pstack methods package can be configured in platform settings. Check the active tools for the running role before claiming a capability is available. PA capabilities are configured through platform settings, roles, and skills. Pi manages installation of its own extensions. New PA product capabilities require a maintained PA release.

Ask what tools or extensions the role can use to see the tools reported when it started in this workspace. Human Question provides `request_clarification`. During assigned work leads use it to request decisions from people, and collaborators use it to ask their delegator.

## Team experience

A matter retrospective can propose reusable working practices. Review the evidence and the organization or repository scope before confirming an experience as verified.
