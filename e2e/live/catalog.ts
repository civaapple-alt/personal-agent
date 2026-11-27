export type LiveScenarioCategory = "board" | "collaboration" | "runtime" | "roles" | "pstack";

export interface LiveScenarioDefinition {
	id: string;
	category: LiveScenarioCategory;
	script: string;
	fixedArgs?: readonly string[];
	supportsDryRun: boolean;
	requiresRealModel: boolean;
	description: string;
}

/** Catalog of explicit opt-in live/real-Pi demo workflows under `packages/server/src/demo/`. */
export const LIVE_SCENARIO_CATALOG: readonly LiveScenarioDefinition[] = [
	{
		id: "board",
		category: "board",
		script: "packages/server/src/demo/board-smoke.ts",
		supportsDryRun: true,
		requiresRealModel: true,
		description: "0.9.0 Board dynamic spawning (Builder + Verifier), @mention loop, handoff & verdict",
	},
	{
		id: "mention-verify",
		category: "collaboration",
		script: "packages/server/src/demo/mention-verify-smoke.ts",
		supportsDryRun: false,
		requiresRealModel: true,
		description: "Multi-turn @mention lead delegation and independent QA verification",
	},
	{
		id: "rpc",
		category: "runtime",
		script: "packages/server/src/demo/rpc-smoke.ts",
		supportsDryRun: false,
		requiresRealModel: true,
		description: "Low-level Pi RPC subprocess transport smoke check",
	},
	{
		id: "pi-native",
		category: "runtime",
		script: "packages/server/src/demo/pi-native-smoke.ts",
		supportsDryRun: false,
		requiresRealModel: true,
		description: "<pa_docs> native read, visualize, suggest_next_steps, and session-insights check",
	},
	{
		id: "rsi",
		category: "runtime",
		script: "packages/server/src/demo/rsi-smoke.ts",
		supportsDryRun: false,
		requiresRealModel: true,
		description: "Four-Step Trust (propose_skill -> confirm tool_call -> autonomous + session-insights)",
	},
	{
		id: "team",
		category: "collaboration",
		script: "packages/server/src/demo/team-smoke.ts",
		supportsDryRun: false,
		requiresRealModel: true,
		description: "Multi-member delegation, clarification without premature publish, and host restart continuation",
	},
	{
		id: "team-capabilities",
		category: "collaboration",
		script: "packages/server/src/demo/team-capabilities-smoke.ts",
		supportsDryRun: false,
		requiresRealModel: true,
		description: "Lead judgment across synthetic startup transcripts, responsibilities, and tool evidence",
	},
	{
		id: "space",
		category: "collaboration",
		script: "packages/server/src/demo/space-smoke.ts",
		supportsDryRun: false,
		requiresRealModel: true,
		description: "Org Space ACLs, Git version diffs, feedback on historical revisions, and preview guards",
	},
	{
		id: "solo",
		category: "roles",
		script: "packages/server/src/demo/solo-vs-business-smoke.ts",
		supportsDryRun: false,
		requiresRealModel: true,
		description: "Contrast pi-default (solo) vs product-manager (business) Pi runtime context & tool handshake",
	},
	{
		id: "review",
		category: "collaboration",
		script: "packages/server/src/demo/publication-review-smoke.ts",
		supportsDryRun: false,
		requiresRealModel: true,
		description: "Pre-publication review evidence, artifact consistency, and independent editorial quality",
	},
	{
		id: "observer",
		category: "collaboration",
		script: "packages/server/src/demo/observer-smoke.ts",
		supportsDryRun: false,
		requiresRealModel: true,
		description: "Targeted observer visibility, risk warnings, feedback escalation, and silent isolation",
	},
	{
		id: "architect",
		category: "roles",
		script: "packages/server/src/demo/role-design-smoke.ts",
		fixedArgs: ["--scenario", "architect"],
		supportsDryRun: false,
		requiresRealModel: true,
		description: "Role Architect end-to-end role proposal, creation, and read-only contradiction check",
	},
	{
		id: "roles",
		category: "roles",
		script: "packages/server/src/demo/role-design-smoke.ts",
		fixedArgs: ["--scenario", "builtin"],
		supportsDryRun: false,
		requiresRealModel: true,
		description: "Built-in role evaluation across product, engineering, QA, and marketing judgments",
	},
	{
		id: "decision",
		category: "roles",
		script: "packages/server/src/demo/decision-smoke.ts",
		supportsDryRun: false,
		requiresRealModel: true,
		description: "Typed Pi initiation decision engine and AI role design scenarios",
	},
	{
		id: "pstack",
		category: "pstack",
		script: "packages/server/src/demo/pstack-smoke.ts",
		supportsDryRun: false,
		requiresRealModel: true,
		description: "pstack methodology bundle reading and engineering bugfix verification (requires -- --source <dir>)",
	},
	{
		id: "pstack-selection",
		category: "pstack",
		script: "packages/server/src/demo/pstack-selection-smoke.ts",
		supportsDryRun: false,
		requiresRealModel: true,
		description: "Natural-task pstack selection behavior across unprompted tasks (requires -- --source <dir>)",
	},
];

export function findLiveScenario(id: string): LiveScenarioDefinition | undefined {
	return LIVE_SCENARIO_CATALOG.find((item) => item.id === id);
}
