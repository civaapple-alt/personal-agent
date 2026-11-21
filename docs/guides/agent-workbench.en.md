# Workbench features at a glance

This guide ships with PA. The [user guide](user-guide.md) covers the full workbench UI.

## PA and Pi

PA (Personal Agent) is the workbench that manages matters, role collaboration, and decisions. Pi runs the role sessions, connects to models, and invokes tools. PA starts and manages those sessions through Pi's RPC interface.

## Matters and dispatch

Use the composer to ask a question, discuss a proposal, or assign work without switching between separate discussion and execution modes. Mention a role with `@` to select a recipient for the turn; set the matter lead in the collaboration members panel.

For example, asking QA to run the login regression or asking which login cases to cover are both handled directly by the role using its own tools and judgment. Use Stop execution to interrupt an active turn.

## How roles work and execute

Each AI role runs with its configured tools, skills, `read_pa_help`, and Human Question (`request_clarification`) in a single persistent Pi session per matter workspace:

- For questions, advice, or status checks, the role replies directly (using read-only inspection when helpful) without modifying files, committing, or publishing deliverables.
- When your intent to act is clear, the role executes, delegates, or publishes deliverables within its role boundaries.
- When scope, trade-offs, or side-effecting authorization need your input, the lead calls `request_clarification` to show a decision card and waits for your answer.

## Collaboration and observers

The matter lead replies by default. Use `@` to address a teammate or an AI role (mentioning only human teammates saves the message without triggering AI). When AI observers are enabled, selected AI collaborators can contribute relevant findings after the reply. The lead still responds and delegates according to the matter settings when observers are off. Open the turn’s delegation details to see assignments and reports.

## Decisions

Suppose you ask AI to verify sign-in and the test scope is open. The role can call `request_clarification` to ask whether to include password recovery.

1. The assigned respondent picks “Include password recovery” or enters a custom reply, then submits the answer.
2. The card shows that it was answered and records who answered and when.
3. AI resumes with the selected scope when the matter is idle and dispatch is allowed. An authorized member can continue a saved answer if it has not resumed.

The pending decisions panel links to cards waiting for an answer.

Ask for a decision card demo and open the trial below the help reply to submit a sample answer.

## Roles and permissions

Open Role Architect or invite it from the collaboration members panel. Review each proposed role, its responsibilities, tools, availability scope, and intended matter participation before confirming. Creating a role and adding it to a matter are separate choices.

## Deliverables and feedback

The lead of an authorized work turn can publish deliverables. Open the matter's deliverable library from the header menu and expand the version history to see earlier versions. Leave feedback on a version to help the lead revise it and publish a new version.

## Models, repositories, and capabilities

Use the composer model picker to select the lead's model for the matter. Authorized administrators configure organization role and platform defaults. Select the matter's repository in its settings.

Web search requires administrator setup and a role grant. The pstack methods package can be configured in platform settings. Check the active tools for the running role before claiming a capability is available. PA capabilities are configured through platform settings, roles, and skills. Pi manages installation of its own extensions. New PA product capabilities require a maintained PA release.

Ask what tools or extensions the role can use to see the tools reported when it started in this workspace. Human Question provides `request_clarification`. Leads use it to request decisions from people, and collaborators use it to ask their delegator.

## Team experience

A matter retrospective can propose reusable working practices. Review the evidence and the organization or repository scope before confirming an experience as verified.
