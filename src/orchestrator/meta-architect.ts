import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assessRoleCapabilities, listRoleSkillCatalog } from "../roles/capabilities.ts";
import {
	BUILTIN_ROLE_ARCHITECT_TEMPLATE,
	buildRoleDesignDraft,
	isArchitectRoleTemplate,
	normalizeRoleTools,
	normalizeRoleVerificationPlan,
	type RoleArchitectDraft,
	type RoleInteractionStyle,
	type RoleWorkspaceScope,
} from "../roles/role-architect.ts";
import type { RoleTemplate } from "../roles/types.ts";
import type { PromptRunResult } from "../rpc/pi-rpc-worker.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { TeamMember } from "../storage/types.ts";
import { resolveRoleSkills } from "./execution-context.ts";
import type { CollaborationPresetMode } from "./matter-initiation.ts";
import { extractJsonObject } from "./pi-decision.ts";
import { collectTeamHealthEvidence, formatTeamHealthEvidence, type TeamHealthEvidence } from "./team-health.ts";
import { truncateInline, type WorkerFactory } from "./types.ts";

export interface MetaArchitectMessage {
	role: "user" | "assistant";
	content: string;
}

export interface MetaArchitectBlueprintProposal {
	draft: RoleArchitectDraft;
	rationale: string;
}

export interface MetaArchitectHealthFinding {
	status: "ok" | "warn";
	title: string;
	detail: string;
	evidence?: TeamHealthEvidence[];
}

export interface MetaArchitectRoleAdjustment {
	memberId: string;
	memberName: string;
	currentTools: string[];
	suggestedTools?: string[];
	addAntiJobs?: string[];
	workflowNote?: string;
	rationale: string;
}

export interface MetaArchitectFormationSuggestion {
	mode: CollaborationPresetMode;
	existingMemberIds: string[];
	observerMemberIds: string[];
	rationale: string;
}

export interface MetaArchitectChatInput {
	messages: MetaArchitectMessage[];
	matterPrompt?: string;
	workspaceId?: string | null;
	includeHealthcheck?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface MetaArchitectChatResult {
	reply: string;
	followUpQuestions: string[];
	healthFindings?: MetaArchitectHealthFinding[];
	roleAdjustments?: MetaArchitectRoleAdjustment[];
	blueprints: MetaArchitectBlueprintProposal[];
	recommendedFormation?: MetaArchitectFormationSuggestion;
	usedHealthcheck: boolean;
}

export interface RoleProposalPayload {
	status: "pending" | "applied" | "dismissed";
	reply?: string;
	followUpQuestions: string[];
	healthFindings?: MetaArchitectHealthFinding[];
	roleAdjustments?: MetaArchitectRoleAdjustment[];
	blueprints: MetaArchitectBlueprintProposal[];
	recommendedFormation?: MetaArchitectFormationSuggestion;
	isMidMatterConsult?: boolean;
	appliedMemberIds?: string[];
	appliedAdjustmentIds?: string[];
}

async function enrichBlueprintCapabilities(result: Pick<MetaArchitectChatResult, "blueprints">): Promise<void> {
	await Promise.all(
		result.blueprints.map(async ({ draft }) => {
			draft.capabilityReport = await assessRoleCapabilities(draft.template);
		}),
	);
}

async function architectMethodText(): Promise<string> {
	const paths = await resolveRoleSkills(BUILTIN_ROLE_ARCHITECT_TEMPLATE);
	return (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n\n");
}

function listBusinessMembers(store: PersonalAgentStore, templatesById: Map<string, RoleTemplate>): TeamMember[] {
	return store
		.listMembers()
		.filter(
			(m) => !isArchitectRoleTemplate(templatesById.get(m.templateId) ?? templatesById.get(m.id) ?? { id: m.id }),
		);
}

/** Collects a compact, read-only digest of recent team friction and roster coverage for Meta-Bot audits. */
export function collectTeamFrictionDigest(store: PersonalAgentStore, templatesById: Map<string, RoleTemplate>): string {
	const members = listBusinessMembers(store, templatesById);
	const matters = store.listMatters().slice(0, 12);
	const deliverables = store.listDeliverables();
	let abortedCount = 0;
	let failedCount = 0;
	let observerNotes = 0;
	let negativeFeedback = 0;

	for (const deliv of deliverables) {
		if (deliv.feedbackRating === "negative") negativeFeedback += 1;
	}
	for (const matter of matters) {
		for (const msg of store.listMessages(matter.id, "user")) {
			if (msg.metadata?.aborted === true) abortedCount += 1;
			if (msg.metadata?.failed === true) failedCount += 1;
			if (msg.metadata?.observerIntervention === true) observerNotes += 1;
		}
	}
	const candidateMemories = members
		.flatMap((m) => store.listMemberMemories(m.id))
		.filter(
			(mem) => mem.status === "candidate" || mem.category === "user_correction" || mem.category === "collaboration",
		)
		.slice(-8)
		.map((mem) => `- [${mem.memberId} · ${mem.category}] ${truncateInline(mem.content, 120)}`);

	return [
		`- Current AI roles (${members.length}): ${members
			.map((m) => {
				const tpl = templatesById.get(m.templateId) ?? templatesById.get(m.id);
				const tools = tpl?.tools.length ? tpl.tools.join(", ") : "none";
				const antiCount = tpl?.antiJobs?.length ?? 0;
				return `${m.id} (${m.displayName}, tools: ${tools}${antiCount > 0 ? `, boundaries: ${antiCount}` : ""})`;
			})
			.join(", ")}`,
		`- Across the latest ${matters.length} matters: ${failedCount} failures, ${abortedCount} cancellations, and ${observerNotes} observer comments. Across all deliverables: ${negativeFeedback} negative ratings. Treat counts as leads.`,
		candidateMemories.length > 0
			? `- Recent correction and collaboration signals:\n${candidateMemories.join("\n")}`
			: "",
		`- Citable cases and configuration. The records establish what was observed:\n${formatTeamHealthEvidence(collectTeamHealthEvidence(store, templatesById))}`,
	]
		.filter(Boolean)
		.join("\n");
}

function normalizeStyle(raw: unknown): RoleInteractionStyle {
	return raw === "lead_direct" || raw === "consult_specialist" || raw === "risk_observer" || raw === "mixed"
		? raw
		: "consult_specialist";
}

function normalizeScope(raw: unknown): RoleWorkspaceScope {
	return raw === "read_write_code" || raw === "read_only_repo" || raw === "no_repo_docs" ? raw : "read_only_repo";
}

function normalizePresetMode(raw: unknown): CollaborationPresetMode {
	return raw === "solo" || raw === "lead_consult" || raw === "lead_review" || raw === "human_first"
		? raw
		: "lead_consult";
}

/** Parses Meta-Bot output JSON into validated, least-privilege RoleArchitect drafts (never auto-creating them). */
export function parseMetaArchitectResponse(
	rawText: string,
	existingMembers: TeamMember[],
	options?: {
		templatesById?: Map<string, RoleTemplate>;
		isHealthcheck?: boolean;
		healthEvidence?: TeamHealthEvidence[];
	},
): Omit<MetaArchitectChatResult, "usedHealthcheck"> {
	const cleaned = rawText.trim();
	const parsed = extractJsonObject(rawText);
	if (!parsed) {
		return {
			reply: cleaned || "请补充说明你期望的工作流程、参与边界，或需要拆分的具体环节。",
			followUpQuestions: [],
			blueprints: [],
		};
	}

	const rec = parsed;
	const reply =
		typeof rec.reply === "string" && rec.reply.trim()
			? rec.reply.trim()
			: "我已整理出初步建议，请核对下方追问或角色草案。";
	const followUpQuestions = Array.isArray(rec.followUpQuestions)
		? rec.followUpQuestions
				.map((q) => (typeof q === "string" ? q.trim() : ""))
				.filter(Boolean)
				.slice(0, 3)
		: [];

	const businessExisting = options?.templatesById
		? existingMembers.filter(
				(m) =>
					!isArchitectRoleTemplate(
						options.templatesById!.get(m.templateId) ?? options.templatesById!.get(m.id) ?? { id: m.id },
					),
			)
		: existingMembers.filter((m) => m.id !== "role-architect");
	const memberById = new Map(businessExisting.map((m) => [m.id, m]));
	const validExistingIds = new Set(businessExisting.map((m) => m.id));
	let recommendedFormation: MetaArchitectFormationSuggestion | undefined;
	if (!options?.isHealthcheck && rec.recommendedFormation && typeof rec.recommendedFormation === "object") {
		const fm = rec.recommendedFormation as Record<string, unknown>;
		const existingIds = Array.isArray(fm.existingMemberIds)
			? fm.existingMemberIds.map(String).filter((id) => validExistingIds.has(id))
			: [];
		const observerIds = Array.isArray(fm.observerMemberIds)
			? fm.observerMemberIds.map(String).filter((id) => validExistingIds.has(id))
			: [];
		const rationale = typeof fm.rationale === "string" ? fm.rationale.trim() : "";
		if (rationale || existingIds.length > 0 || observerIds.length > 0) {
			recommendedFormation = {
				mode: normalizePresetMode(fm.mode),
				existingMemberIds: Array.from(new Set(existingIds)),
				observerMemberIds: Array.from(new Set(observerIds)),
				rationale,
			};
		}
	}

	const healthFindings: MetaArchitectHealthFinding[] = Array.isArray(rec.healthFindings)
		? rec.healthFindings
				.slice(0, 5)
				.map((item): MetaArchitectHealthFinding | null => {
					if (!item || typeof item !== "object") return null;
					const entry = item as Record<string, unknown>;
					const title = typeof entry.title === "string" ? entry.title.trim() : "";
					const detail = typeof entry.detail === "string" ? entry.detail.trim() : "";
					if (!title && !detail) return null;
					return {
						status: entry.status === "ok" ? "ok" : "warn",
						title: title || "检查项",
						detail: detail || title,
						evidence: (options?.healthEvidence ?? []).filter(
							(source) => Array.isArray(entry.evidenceIds) && entry.evidenceIds.includes(source.id),
						),
					};
				})
				.filter((item): item is MetaArchitectHealthFinding => item !== null)
		: [];

	const roleAdjustments: MetaArchitectRoleAdjustment[] = Array.isArray(rec.roleAdjustments)
		? rec.roleAdjustments
				.slice(0, 8)
				.map((item): MetaArchitectRoleAdjustment | null => {
					if (!item || typeof item !== "object") return null;
					const entry = item as Record<string, unknown>;
					const memberId = typeof entry.memberId === "string" ? entry.memberId.trim() : "";
					const member = memberById.get(memberId);
					if (!member) return null;
					const tpl = options?.templatesById?.get(member.templateId) ?? options?.templatesById?.get(member.id);
					const currentTools = tpl?.tools ?? [];
					const suggestedTools = Array.isArray(entry.suggestedTools)
						? normalizeRoleTools(entry.suggestedTools.map(String))
						: undefined;
					const addAntiJobs = Array.isArray(entry.addAntiJobs)
						? entry.addAntiJobs.map((s) => String(s).trim()).filter(Boolean)
						: undefined;
					const workflowNote =
						typeof entry.workflowNote === "string" && entry.workflowNote.trim()
							? entry.workflowNote.trim()
							: undefined;
					const rationale = typeof entry.rationale === "string" ? entry.rationale.trim() : "";
					if (suggestedTools === undefined && (!addAntiJobs || addAntiJobs.length === 0) && !workflowNote) {
						return null;
					}
					return {
						memberId: member.id,
						memberName: member.displayName,
						currentTools,
						...(suggestedTools !== undefined ? { suggestedTools } : {}),
						...(addAntiJobs && addAntiJobs.length > 0 ? { addAntiJobs } : {}),
						...(workflowNote ? { workflowNote } : {}),
						rationale,
					};
				})
				.filter((item): item is MetaArchitectRoleAdjustment => item !== null)
		: [];

	const rawBlueprints = Array.isArray(rec.blueprints) ? rec.blueprints.slice(0, 4) : [];
	const reservedIds = existingMembers.map((m) => m.id);
	const blueprints: MetaArchitectBlueprintProposal[] = [];

	for (const item of rawBlueprints) {
		if (!item || typeof item !== "object") continue;
		const bp = item as Record<string, unknown>;
		const oneJob = typeof bp.oneJob === "string" ? bp.oneJob.trim() : "";
		if (!oneJob) continue;
		const antiJobs = Array.isArray(bp.antiJobs)
			? bp.antiJobs.map((s) => String(s).trim()).filter(Boolean)
			: undefined;
		const keywords = Array.isArray(bp.keywords)
			? bp.keywords.map((s) => String(s).trim()).filter(Boolean)
			: undefined;
		const draft = buildRoleDesignDraft({
			oneJob,
			antiJobs,
			quietWhen: typeof bp.quietWhen === "string" ? bp.quietWhen : undefined,
			interactionStyle: normalizeStyle(bp.interactionStyle),
			workspaceScope: normalizeScope(bp.workspaceScope),
			roleId: typeof bp.id === "string" ? bp.id : undefined,
			roleName:
				typeof bp.name === "string"
					? bp.name
					: typeof bp.roleName === "string"
						? bp.roleName
						: typeof bp.displayName === "string"
							? bp.displayName
							: undefined,
			roleTitle:
				typeof bp.title === "string" ? bp.title : typeof bp.roleTitle === "string" ? bp.roleTitle : undefined,
			keywords,
			workflowRules: typeof bp.workflowRules === "string" ? bp.workflowRules : undefined,
			constraints: typeof bp.constraints === "string" ? bp.constraints : undefined,
			skills: Array.isArray(bp.skills)
				? bp.skills.filter((value): value is string => typeof value === "string")
				: [],
			mcpDependencies: Array.isArray(bp.mcpDependencies)
				? bp.mcpDependencies.filter((value): value is string => typeof value === "string")
				: [],
			communicationStyle: typeof bp.communicationStyle === "string" ? bp.communicationStyle : undefined,
			verificationPlan: normalizeRoleVerificationPlan(bp.verificationPlan),
			existingMemberIds: reservedIds,
		});
		reservedIds.push(draft.template.id);
		blueprints.push({
			draft,
			rationale: typeof bp.rationale === "string" ? bp.rationale.trim() : "",
		});
	}

	return {
		reply,
		followUpQuestions,
		...(healthFindings.length > 0 ? { healthFindings } : {}),
		...(roleAdjustments.length > 0 ? { roleAdjustments } : {}),
		blueprints,
		recommendedFormation,
	};
}

export interface MetaArchitectDeps {
	store: PersonalAgentStore;
	defaultCwd: string;
	workerFactory: WorkerFactory;
	templatesById: Map<string, RoleTemplate>;
}

export const ARCHITECT_SYSTEM_INSTRUCTIONS = [
	"You are Personal Agent's Role Architect. Design, diagnose, split, or simplify AI roles and human–AI collaboration. Leave business work with the business roles.",
	"Base proposals on the user's actual workflow, the decisions humans own, and the existing team.",
	"Write user-facing prose in the user's language unless they request another language. Preserve JSON keys, enum values, IDs, and evidence references.",
	"",
	"## Design roles",
	"1. Give each role one core outcome.",
	"2. For non-coding, review, and observer roles, state which actions are outside their remit and when to return [SILENT].",
	"3. Choose the minimum workspace access in `workspaceScope`: `no_repo_docs` for planning and writing without tools, `read_only_repo` for inspection, or `read_write_code` when implementation requires code changes or commands.",
	"4. Reuse suitable team members first. If gaps remain, propose one to four complementary roles with distinct responsibilities in `blueprints`. Explain how they work with people.",
	"5. Ask up to three questions, limited to gaps that could change the goal, capability, or acceptance criteria. Use answers already given. When you have enough information, return the smallest workable plan.",
	"6. Use relevant installed Skills. Identify missing dependencies without assuming that an integration works. Blueprints can include skills, mcpDependencies, communicationStyle, and verificationPlan.",
	"7. Follow the role-design Skill. Give each proposed role a small runnable task, success criteria, and a boundary check. Report capability as verified only after execution. Use a short string or { task, successCriteria, boundaryCheck } with three nonempty strings for verificationPlan. State when the plan is missing.",
	"",
	"## Assess team health",
	"- Put a one-sentence summary in `reply` and give each finding its own item in `healthFindings`. Each item has a short title, a one-sentence detail, and a status of ok or warn.",
	"- Put any change to tools, antiJobs, or workflowNote in `roleAdjustments` so the owner can confirm it.",
	"- For a health check without a new workflow proposal, set `recommendedFormation` to null.",
	"- Cite host-supplied configuration or case IDs in `evidenceIds`. Treat occurrence counts and candidate experience as leads. If there is no concrete issue, leave `healthFindings` and `roleAdjustments` empty.",
	"",
	"## Return valid JSON only",
	JSON.stringify(
		{
			reply: "One or two concise sentences for the user, or a clarifying question",
			followUpQuestions: ["Optional short reply", "Another short reply"],
			healthFindings: [
				{
					status: "ok | warn",
					title: "Short title, such as overlapping responsibilities",
					detail: "One sentence with concrete evidence and the conclusion",
					evidenceIds: ["role:product-manager"],
				},
			],
			roleAdjustments: [
				{
					memberId: "product-manager",
					suggestedTools: ["read"],
					addAntiJobs: ["Define scope and acceptance criteria. Leave command-line checks to a specialist."],
					workflowNote: "When retrying a delegation, include a short context brief.",
					rationale: "One sentence explaining the adjustment",
				},
			],
			recommendedFormation: null,
			blueprints: [],
		},
		null,
		2,
	),
	'For a new workflow proposal, you may omit `healthFindings` and `roleAdjustments`. Use `recommendedFormation: { mode, existingMemberIds, observerMemberIds, rationale }` and `blueprints: [{ id: "ux-designer", name: "UX Designer", title: "UX Designer", oneJob: "One sentence describing the core responsibility", antiJobs: ["One explicit boundary"], interactionStyle: "consult_specialist | risk_observer | lead_direct", workspaceScope: "read_only_repo | no_repo_docs | read_write_code", rationale: "Why this role is needed" }]`. Give each blueprint a short display name, a kebab-case English ID, and an English title. Default the display name to English and preserve names specified by the user. Put the responsibility in `oneJob`.',
].join("\n");

/** Builds read-only live roster, health digest, and JSON proposal contract for an in-matter Role Architect turn. */
export async function buildArchitectMatterContext(
	deps: { store: PersonalAgentStore; templatesById: Map<string, RoleTemplate> },
	options?: { isMidMatterConsult?: boolean },
): Promise<string> {
	const businessMembers = listBusinessMembers(deps.store, deps.templatesById);
	const rosterLines = businessMembers
		.map((m) => {
			const tpl = deps.templatesById.get(m.templateId) ?? deps.templatesById.get(m.id);
			const resp = truncateInline(tpl?.sections.responsibilitiesAndBoundaries ?? "", 160);
			const tools = tpl?.tools.length ? tpl.tools.join(", ") : "";
			const anti = tpl?.antiJobs?.length ? ` | Anti-Jobs: ${tpl.antiJobs.join("; ")}` : "";
			return `- ${m.id} | ${m.displayName} (${m.roleTitle}) | Tools: [${tools}] | Skills: [${tpl?.skills.join(", ") ?? ""}] | MCP (unverified): [${tpl?.mcpDependencies.join(", ") ?? ""}]${anti}${resp ? ` | Responsibilities: ${resp}` : ""}`;
		})
		.join("\n");
	const healthDigest = collectTeamFrictionDigest(deps.store, deps.templatesById);
	const midMatterHint = options?.isMidMatterConsult
		? "\nYou were invited into an active matter. Diagnose the blocker from the conversation. Provide only the necessary `blueprints` to add a role or `roleAdjustments` to refine boundaries. The current lead still owns the matter."
		: "";

	return [
		ARCHITECT_SYSTEM_INSTRUCTIONS + midMatterHint,
		`## Role design method\n${await architectMethodText()}`,
		`## Installed Skill catalog\nFile presence establishes availability. Verify performance through execution.\n${JSON.stringify(await listRoleSkillCatalog())}`,
		`## Current business roles (${businessMembers.length})\n${rosterLines || "No business roles yet."}`,
		`## Recent team health evidence\n${healthDigest}`,
	].join("\n\n");
}

/** Parses an in-matter Role Architect turn output into clean prose + interactive inline proposal metadata. */
export async function buildArchitectMessageProposals(
	rawText: string,
	store: PersonalAgentStore,
	templatesById: Map<string, RoleTemplate>,
	options?: { promptText?: string; isMidMatterConsult?: boolean },
): Promise<{ replyText: string; roleProposals?: RoleProposalPayload }> {
	const existingMembers = store.listMembers();
	const isHealthcheck = /(?:体检|诊断|重叠|收窄|冗余|权限过宽|摩擦)/i.test(options?.promptText ?? "");
	const parsed = parseMetaArchitectResponse(rawText, existingMembers, {
		templatesById,
		isHealthcheck,
		healthEvidence: collectTeamHealthEvidence(store, templatesById),
	});
	await enrichBlueprintCapabilities(parsed);
	const hasStructured =
		parsed.followUpQuestions.length > 0 ||
		(parsed.healthFindings && parsed.healthFindings.length > 0) ||
		(parsed.roleAdjustments && parsed.roleAdjustments.length > 0) ||
		parsed.blueprints.length > 0 ||
		Boolean(parsed.recommendedFormation);
	if (!hasStructured) {
		return { replyText: parsed.reply };
	}
	return {
		replyText: parsed.reply,
		roleProposals: {
			status: "pending",
			followUpQuestions: parsed.followUpQuestions,
			...(parsed.healthFindings ? { healthFindings: parsed.healthFindings } : {}),
			...(parsed.roleAdjustments ? { roleAdjustments: parsed.roleAdjustments } : {}),
			blueprints: parsed.blueprints,
			...(parsed.recommendedFormation ? { recommendedFormation: parsed.recommendedFormation } : {}),
			...(options?.isMidMatterConsult ? { isMidMatterConsult: true } : {}),
		},
	};
}

/**
 * Conversational Meta-Bot (`dr-eggbot-v2` style Role Architect):
 * runs read-only without tools/extensions, interviews user preferences, audits team friction,
 * and proposes 1..N tightly-scoped role blueprints that require explicit user confirmation to materialize.
 */
export async function runMetaArchitectChat(
	deps: MetaArchitectDeps,
	input: MetaArchitectChatInput & { signal: AbortSignal },
): Promise<MetaArchitectChatResult> {
	if (input.messages.length === 0) {
		throw new Error("At least one user message is required");
	}
	const allMembers = deps.store.listMembers();
	const members = listBusinessMembers(deps.store, deps.templatesById);
	const primary =
		members.find((m) => m.isPrimaryContact) ?? members[0] ?? deps.store.getPrimaryContact() ?? allMembers[0];
	const workspace = input.workspaceId ? deps.store.getWorkspace(input.workspaceId) : null;
	const cwd = resolve(workspace?.repoPath ?? deps.defaultCwd);

	const rosterLines = members
		.map((m) => {
			const tpl = deps.templatesById.get(m.templateId) ?? deps.templatesById.get(m.id);
			const resp = truncateInline(tpl?.sections.responsibilitiesAndBoundaries ?? "", 160);
			const tools = tpl?.tools.length ? tpl.tools.join(", ") : "";
			const anti = tpl?.antiJobs?.length ? ` | Anti-Jobs: ${tpl.antiJobs.join("; ")}` : "";
			return `- ${m.id} | ${m.displayName} (${m.roleTitle}) | Tools: [${tools}] | Skills: [${tpl?.skills.join(", ") ?? ""}] | MCP (unverified): [${tpl?.mcpDependencies.join(", ") ?? ""}]${anti}${resp ? ` | Responsibilities: ${resp}` : ""}`;
		})
		.join("\n");

	const transcript = input.messages
		.slice(-12)
		.map((msg) => `${msg.role === "user" ? "User" : "Role Architect"}: ${truncateInline(msg.content, 1600)}`)
		.join("\n\n");

	const healthDigest = input.includeHealthcheck ? collectTeamFrictionDigest(deps.store, deps.templatesById) : "";

	const systemPrompt = `${ARCHITECT_SYSTEM_INSTRUCTIONS}\n\n## Role design method\n${await architectMethodText()}`;

	const prompt = [
		`## Installed Skill catalog\nFile presence establishes availability. Verify performance through execution.\n${JSON.stringify(await listRoleSkillCatalog())}`,
		`## Current team members (${members.length})\n${rosterLines || "No business roles yet."}`,
		workspace
			? `## Linked workspace\n- ${workspace.name} (${workspace.repoPath})`
			: "## Linked workspace\n- General workspace with no repository linked.",
		input.matterPrompt ? `## User's draft matter\n${truncateInline(input.matterPrompt, 1200)}` : "",
		healthDigest ? `## Recent team health evidence\n${healthDigest}` : "",
		`## Conversation history\n${transcript}`,
	]
		.filter(Boolean)
		.join("\n\n");

	const methodPaths = await resolveRoleSkills(BUILTIN_ROLE_ARCHITECT_TEMPLATE);
	const worker = deps.workerFactory({
		cwd,
		provider: primary?.provider ?? "kimi-coding",
		model: primary?.model ?? "kimi-for-coding",
		noSession: true,
		args: [
			"--no-extensions",
			"--no-skills",
			"--no-mcp",
			...methodPaths.flatMap((path) => ["--skill", path]),
			"--tools",
			"",
		],
		env: { PA_META_ARCHITECT_SYSTEM: systemPrompt },
	});
	const onAbortWorker = () => {
		void worker.abort?.().catch(() => {});
		void worker.stop().catch(() => {});
	};
	input.signal.addEventListener("abort", onAbortWorker, { once: true });

	let result: PromptRunResult;
	try {
		await worker.start();
		input.signal.throwIfAborted();
		result = await worker.runPromptAndWait(`${systemPrompt}\n\n---\n\n${prompt}`, {
			timeoutMs: input.timeoutMs ?? 120_000,
			signal: input.signal,
		});
	} finally {
		input.signal.removeEventListener("abort", onAbortWorker);
		await worker.stop().catch(() => {});
	}
	if (result.aborted || input.signal.aborted) {
		throw new Error("Role architect session was aborted");
	}
	const parsed = parseMetaArchitectResponse(result.assistantText, allMembers, {
		templatesById: deps.templatesById,
		isHealthcheck: Boolean(input.includeHealthcheck),
		healthEvidence: collectTeamHealthEvidence(deps.store, deps.templatesById),
	});
	await enrichBlueprintCapabilities(parsed);
	return {
		...parsed,
		usedHealthcheck: Boolean(input.includeHealthcheck),
	};
}
