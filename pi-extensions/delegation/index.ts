import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { formatCompactRolesIndex, type RoleDefinition, resolveRoleDefinition } from "../roles/loader.ts";
import {
	runSharedPiRpcWorker,
	type SharedPiWorkerRequest,
	type SharedPiWorkerResult,
	type WorkerModelOverride,
} from "../shared/local-rpc-worker.ts";
import { createTeamBridgeClient } from "../shared/team-bridge-client.ts";

export interface DelegationVerificationArgs {
	assignmentNumber?: number;
	target: {
		kind: "commit" | "file" | "draft";
		reference: string;
	};
	criteria: string;
}

export interface StandaloneDelegationArgs {
	memberId: string;
	task: string;
	ownedScope?: string[];
	verification?: DelegationVerificationArgs;
	modelOverride?: WorkerModelOverride;
}

export type DelegationWorkerExecutor = (
	req: SharedPiWorkerRequest,
	signal?: AbortSignal,
) => Promise<SharedPiWorkerResult>;

export interface DelegationUiContext {
	ui?: {
		notify?(message: string, level?: "info" | "warning" | "error"): void;
	};
}

export interface DelegationExtensionApi {
	registerTool(definition: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters: object;
		execute(
			callId: string,
			args: unknown,
			signal?: AbortSignal,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
	}): void;
	registerCommand?(
		name: string,
		definition: {
			description: string;
			handler(args: string, ctx?: DelegationUiContext): Promise<string | undefined> | string | undefined;
		},
	): void;
	sendUserMessage?(content: string): void;
}

export interface CreateDelegationExtensionOptions {
	env?: Record<string, string | undefined>;
	cwd?: string;
	executor?: DelegationWorkerExecutor;
}

const SAFE_MEMBER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const PA_DELEGATE_PARAMETERS = {
	type: "object",
	properties: {
		memberId: { type: "string" },
		task: { type: "string" },
		handoffDocumentIds: {
			type: "array",
			items: { type: "string" },
			maxItems: 5,
			description:
				"Optional Space document IDs visible in this matter to attach as structured handoff context (validated before launching the colleague; missing or inaccessible documents fail closed).",
		},
		verification: {
			type: "object",
			properties: {
				assignmentNumber: {
					type: "integer",
					minimum: 1,
					description: "Completed assignment number in this turn, when there is one",
				},
				target: {
					type: "object",
					properties: {
						kind: { type: "string", enum: ["commit", "file", "draft"] },
						reference: {
							type: "string",
							description: "Full commit hash, workspace-relative text path, or exact staged document title",
						},
					},
					required: ["kind", "reference"],
					additionalProperties: false,
				},
				criteria: { type: "string" },
			},
			required: ["target", "criteria"],
			additionalProperties: false,
		},
	},
	required: ["memberId", "task"],
	additionalProperties: false,
};

const STANDALONE_DELEGATE_PARAMETERS = {
	type: "object",
	properties: {
		memberId: {
			type: "string",
			description:
				"Target role name, alias, or member id (e.g. 'qa', '测试', '研发', 'qa-manager', 'engineering-manager', or an ad-hoc specialist label).",
		},
		task: {
			type: "string",
			description: "Concrete task or specialist review request including objective, context, and expected evidence.",
		},
		ownedScope: {
			type: "array",
			items: { type: "string" },
			description: "Optional workspace paths/modules in scope.",
		},
		verification: PA_DELEGATE_PARAMETERS.properties.verification,
		modelOverride: {
			type: "object",
			properties: {
				provider: { type: "string" },
				model: { type: "string" },
				thinkingLevel: {
					type: "string",
					enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
				},
			},
			required: ["provider", "model"],
			additionalProperties: false,
			description: "Optional provider/model override (e.g. heterogeneous cross-model independent verification).",
		},
	},
	required: ["memberId", "task"],
	additionalProperties: false,
};

function normalizeRoleQuery(rawQuery: string): string {
	const cleaned = rawQuery.trim().replace(/^@/, "").trim();
	if (!cleaned || cleaned.includes("..") || cleaned.includes("/") || cleaned.includes("\\")) {
		throw new Error(`Invalid role identifier "${rawQuery}"`);
	}
	return cleaned;
}

function toSafeSessionSlug(label: string): string {
	if (SAFE_MEMBER_ID_RE.test(label) && !label.includes("..")) {
		return label;
	}
	return `role-${createHash("sha256").update(label).digest("hex").slice(0, 12)}`;
}

function buildStandaloneDelegationPrompt(args: StandaloneDelegationArgs, role: RoleDefinition | undefined): string {
	const lines: string[] = [];
	if (role) {
		lines.push(`[Delegated Specialist: ${role.name} (${role.id})]`);
		if (role.skills.length > 0) lines.push(`Recommended skills: ${role.skills.join(", ")}`);
		if (role.antiJobs.length > 0) lines.push(`Boundaries (antiJobs): ${role.antiJobs.join("; ")}`);
		if (role.body) lines.push("", role.body);
	} else {
		lines.push(`[Delegated Specialist: ${args.memberId}]`);
	}

	if (args.ownedScope?.length) {
		lines.push("", `Owned scope: ${args.ownedScope.join(", ")}`);
	}

	if (args.verification) {
		lines.push(
			"",
			"[Independent Verification Mode — READ-ONLY]",
			"- Edit and write tools are stripped (`--exclude-tools edit,write`). Inspect evidence directly and do not edit deliverables.",
			`- Target: ${args.verification.target.kind} -> ${args.verification.target.reference}`,
			`- Acceptance criteria: ${args.verification.criteria}`,
		);
	}

	lines.push("", "Task:", args.task.trim());
	return lines.join("\n");
}

function registerPaBridgeDelegation(pi: DelegationExtensionApi, env: Record<string, string | undefined>): void {
	const post = createTeamBridgeClient(env);
	pi.registerTool({
		name: "delegate_to_member",
		label: "咨询团队成员",
		description:
			"Ask an existing colleague to perform specialist work and return evidence. Include the objective, constraints, and expected evidence. During authorized work, the lead can set verification to assign independent review of a commit, workspace text file, or a staged document draft. Use a different member from the author and refer to their completed assignment when applicable. The answer includes the assignment number for this turn's handoff board.",
		parameters: PA_DELEGATE_PARAMETERS,
		async execute(callId, args, signal) {
			const result = await post("/tool", { tool: "delegate_to_member", callId, args }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}

function registerStandaloneDelegation(
	pi: DelegationExtensionApi,
	options: CreateDelegationExtensionOptions = {},
): void {
	const env = options.env ?? process.env;
	if (env.PA_LOCAL_DELEGATE_SUBWORKER === "1") {
		return;
	}
	const cwd = options.cwd ?? process.cwd();
	const executor = options.executor ?? runSharedPiRpcWorker;
	const rolesIndex = formatCompactRolesIndex({ cwd, env });

	pi.registerTool({
		name: "delegate_to_member",
		label: "咨询团队成员",
		description:
			"Delegate specialist work or read-only independent verification (when verification is set) to an isolated Pi RPC session, auto-feeding role guidance when matching roles/*.md exists.",
		promptSnippet: "Delegate focused work or read-only independent review to a specialist session",
		promptGuidelines: [
			"When the user asks for specialist help or describes work matching another function (implementation, testing/QA, product scope, marketing, or ad-hoc specialist review), choose the fitting role(s) and call delegate_to_member automatically.",
			"Whenever a step involves checking, reviewing, or verifying completed work, pass `verification` ({ target, criteria }) so edit/write tools are disabled and never delegate verification to the same role that authored the change.",
			...(rolesIndex
				? [`Available local roles (or pass any ad-hoc specialist slug in memberId):\n${rolesIndex}`]
				: []),
		],
		parameters: STANDALONE_DELEGATE_PARAMETERS,
		async execute(_callId, rawArgs, signal) {
			signal?.throwIfAborted();
			const args = rawArgs as unknown as StandaloneDelegationArgs;
			const query = normalizeRoleQuery(args.memberId ?? "");
			const task = args.task?.trim();
			if (!task) {
				throw new Error("delegate_to_member requires a non-empty task");
			}
			const role = resolveRoleDefinition(query, { cwd, env });
			const resolvedMemberId = role?.id ?? query;
			const sessionsDir = join(cwd, ".pi", "delegations", "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const sessionFile = join(sessionsDir, `${toSafeSessionSlug(resolvedMemberId)}.jsonl`);
			const readOnly = Boolean(args.verification);
			const prompt = buildStandaloneDelegationPrompt({ ...args, memberId: resolvedMemberId }, role);

			const result = await executor(
				{
					cwd,
					readOnly,
					sessionFile,
					prompt,
					extraTools: [],
					modelOverride: args.modelOverride,
					env: {
						PA_LOCAL_DELEGATE_SUBWORKER: "1",
					},
				},
				signal,
			);

			const payload = {
				memberId: resolvedMemberId,
				roleTitle: role?.title ?? resolvedMemberId,
				resolvedFromRoleFile: Boolean(role),
				readOnly,
				sessionFile,
				assistantText: result.assistantText,
			};
			return {
				content: [{ type: "text", text: JSON.stringify(payload) }],
				details: payload,
			};
		},
	});

	pi.registerCommand?.("delegate", {
		description: "Delegate work or independent verification in natural language (/delegate <request>)",
		async handler(rawArgs, ctx) {
			const request = rawArgs.trim();
			if (!request) {
				const usage = "Usage: /delegate <自然语言任务，例如：修复 auth.ts 并让负责测试的同事独立验证>";
				ctx?.ui?.notify?.(usage, "warning");
				return usage;
			}
			const liveRolesIndex = formatCompactRolesIndex({ cwd, env });
			const prompt = [
				"Handle this request by delegating to the appropriate specialist role(s) via delegate_to_member:",
				request,
				"",
				...(liveRolesIndex
					? ["Available local roles (or create an ad-hoc role slug if none fit):", liveRolesIndex, ""]
					: []),
				"Instructions:",
				"1. Pick the right role(s) semantically based on the responsibilities described in the request — the user does not need to specify exact role IDs.",
				"2. For any review, audit, or verification step, pass `verification` ({ target, criteria }) so it runs read-only on a distinct role from the author.",
			].join("\n");
			pi.sendUserMessage?.(prompt);
			return prompt;
		},
	});
}

export function createDelegationExtension(options: CreateDelegationExtensionOptions = {}) {
	return function configuredDelegationExtension(pi: DelegationExtensionApi): void {
		// Snapshot env at registration time so tests that restore process.env after registration still retain bridge credentials.
		const env = { ...(options.env ?? process.env) };
		if (env.PA_TEAM_BRIDGE_URL?.trim()) {
			registerPaBridgeDelegation(pi, env);
			return;
		}
		registerStandaloneDelegation(pi, { ...options, env });
	};
}

export default function delegationExtension(pi: DelegationExtensionApi): void {
	createDelegationExtension()(pi);
}
