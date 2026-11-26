import { createTeamBridgeClient, type PiHostToolExtensionApi } from "../../worker-runtime/pi/bridge-client.ts";
import { matchManagedSkillScriptCall, parseManagedSkillRoots, parseSkillTrustPolicies } from "./skill-trust-gate.ts";

const CHOICE_ALLOW_ONCE = "仅本次允许执行";
const CHOICE_TRUST_AUTONOMOUS = "信任此 Skill，后续自主执行";
const CHOICE_DENY = "拒绝执行";

interface SkillCaptureExtensionApi extends PiHostToolExtensionApi {
	on?(
		event: "tool_call",
		handler: (
			event: { toolName: string; toolCallId?: string; input: Record<string, unknown> },
			ctx?: {
				cwd?: string;
				hasUI?: boolean;
				ui?: {
					select?(title: string, options: string[]): Promise<string | undefined>;
				};
			},
		) => Promise<{ block: true; reason: string } | undefined> | { block: true; reason: string } | undefined,
	): void;
}

export default function skillCaptureExtension(pi: SkillCaptureExtensionApi): void {
	const env = { ...process.env };
	const post = createTeamBridgeClient(env);
	const managedRoots = parseManagedSkillRoots(env.PA_MANAGED_SKILL_ROOTS);
	const policies = parseSkillTrustPolicies(env.PA_SKILL_TRUST_POLICIES);

	pi.registerTool({
		name: "propose_skill",
		label: "提议沉淀 Skill 与脚本",
		description:
			"Propose saving a proven, reusable workflow, convention, user correction, or deterministic helper script as a standard Pi Skill (SKILL.md plus optional executable scripts under scripts/) for human confirmation. Never writes directly to disk until the user approves the confirmation card. Use whenever work uncovers a reusable method, rule, or multi-step procedure that should be one-shot repeatable next time.",
		promptSnippet:
			"Propose saving a proven workflow or deterministic script as a standard Pi Skill (SKILL.md + scripts/*) for human confirmation.",
		promptGuidelines: [
			"Follow the `skill-design` Skill before calling propose_skill: sharp trigger-first description, one home per fact, concise imperative steps, and deterministic scripts/* only when code beats prose.",
		],
		parameters: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "Lowercase kebab-case skill name (e.g. 'release-preflight' or 'daily-repo-digest').",
				},
				description: {
					type: "string",
					maxLength: 500,
					description:
						"Concise trigger description telling future sessions when to load this Skill (max 500 chars).",
				},
				body: {
					type: "string",
					description: "Markdown instructions for SKILL.md (without YAML frontmatter).",
				},
				storageScope: {
					type: "string",
					enum: ["global", "org", "personal", "workspace"],
					description: "Target scope: workspace (.agents/skills/), personal, org, or global.",
				},
				rationale: {
					type: "string",
					description: "Why this workflow or rule is worth saving and what repeated effort it eliminates.",
				},
				scripts: {
					type: "array",
					description: "Optional deterministic helper scripts under scripts/<filename>.",
					items: {
						type: "object",
						properties: {
							path: { type: "string", description: "Must match scripts/<safe-filename>." },
							content: { type: "string" },
							executable: { type: "boolean" },
						},
						required: ["path", "content"],
						additionalProperties: false,
					},
				},
			},
			required: ["name", "description", "body", "storageScope", "rationale"],
			additionalProperties: false,
		},
		async execute(callId, args, signal) {
			const result = await post("/tool", { tool: "propose_skill", callId, args }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	if (typeof pi.on === "function" && managedRoots.length > 0) {
		pi.on("tool_call", async (event, ctx) => {
			if (event.toolName !== "bash" || typeof event.input.command !== "string") return undefined;
			const matched = matchManagedSkillScriptCall(event.input.command, managedRoots, ctx?.cwd ?? process.cwd());
			if (!matched) return undefined;

			const trustLevel = policies.get(matched.policyKey) ?? "confirm";
			const callId = event.toolCallId ?? `trust_${Date.now()}`;

			if (trustLevel === "disabled") {
				return {
					block: true,
					reason: `Skill "${matched.skillName}" (${matched.scope}) is currently disabled by trust policy. Re-enable it in Settings → 技能与信任 before running ${matched.scriptRelPath}.`,
				};
			}

			if (trustLevel === "autonomous") {
				void post("/tool", {
					tool: "record_skill_run",
					callId: `${callId}:run`,
					args: {
						scope: matched.scope,
						scopeId: matched.scopeId,
						skillName: matched.skillName,
						outcome: "autonomous_allowed",
					},
				}).catch(() => {});
				return undefined;
			}

			// Step 3 (confirm): ask the user natively via Pi extension UI (flows through DialogBroker in PA Web UI).
			if (typeof ctx?.ui?.select === "function") {
				const cmdPreview = event.input.command.trim().replace(/\s+/g, " ").slice(0, 240);
				const promptTitle = `允许运行 Skill「${matched.skillName}」的脚本 ${matched.scriptRelPath}？（${matched.scope}）\n命令：${cmdPreview}`;
				const choice = await ctx.ui.select(promptTitle, [CHOICE_ALLOW_ONCE, CHOICE_TRUST_AUTONOMOUS, CHOICE_DENY]);
				if (choice === CHOICE_TRUST_AUTONOMOUS) {
					policies.set(matched.policyKey, "autonomous");
					await post("/tool", {
						tool: "promote_skill_trust",
						callId: `${callId}:promote`,
						args: {
							scope: matched.scope,
							scopeId: matched.scopeId,
							skillName: matched.skillName,
							trustLevel: "autonomous",
						},
					}).catch(() => {});
					return undefined;
				}
				if (choice === CHOICE_ALLOW_ONCE) {
					void post("/tool", {
						tool: "record_skill_run",
						callId: `${callId}:once`,
						args: {
							scope: matched.scope,
							scopeId: matched.scopeId,
							skillName: matched.skillName,
							outcome: "confirmed_once",
						},
					}).catch(() => {});
					return undefined;
				}
				return {
					block: true,
					reason: `User declined running Skill "${matched.skillName}" script ${matched.scriptRelPath}.`,
				};
			}

			return undefined;
		});
	}
}
