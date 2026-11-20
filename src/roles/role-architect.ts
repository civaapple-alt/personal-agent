import { buildScopedRoleId, slugifySkillName, validateNewSkillDrafts } from "./role-package-store.ts";
import { formatRoleTemplateBody, serializeRoleTemplateMarkdown } from "./template-loader.ts";
import type { NewSkillDraft, RoleCapabilityReport, RoleScope, RoleTemplate } from "./types.ts";

export type RoleInteractionStyle = "lead_direct" | "consult_specialist" | "risk_observer" | "mixed";
export type RoleWorkspaceScope = "read_write_code" | "read_only_repo" | "no_repo_docs";

export interface RoleVerificationPlan {
	task: string;
	successCriteria: string;
	boundaryCheck: string;
}

/** Accept either concise prose or a complete structured plan; never stringify unknown objects. */
export function normalizeRoleVerificationPlan(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (
		!value ||
		typeof value !== "object" ||
		!("task" in value) ||
		!("successCriteria" in value) ||
		!("boundaryCheck" in value)
	)
		return undefined;
	if (
		typeof value.task !== "string" ||
		typeof value.successCriteria !== "string" ||
		typeof value.boundaryCheck !== "string" ||
		!value.task.trim() ||
		!value.successCriteria.trim() ||
		!value.boundaryCheck.trim()
	)
		return undefined;
	return `验证任务：${value.task.trim()}\n通过条件：${value.successCriteria.trim()}\n边界检查：${value.boundaryCheck.trim()}`;
}

export interface RoleDesignBriefInput {
	oneJob: string;
	antiJobs?: string[];
	quietWhen?: string;
	interactionStyle?: RoleInteractionStyle;
	workspaceScope?: RoleWorkspaceScope;
	roleScope?: RoleScope;
	ownerOrgId?: string | null;
	ownerUserId?: string | null;
	roleId?: string;
	roleName?: string;
	roleTitle?: string;
	keywords?: string[];
	workflowRules?: string;
	constraints?: string;
	skills?: string[];
	mcpDependencies?: string[];
	suggestedNewSkills?: NewSkillDraft[];
	communicationStyle?: string;
	verificationPlan?: string | RoleVerificationPlan;
	isPrimaryContact?: boolean;
	existingMemberIds?: string[];
}

export interface RoleArchitectDraft {
	template: RoleTemplate;
	markdown: string;
	antiJobs: string[];
	toolSummary: string;
	recommendedParticipation: RoleInteractionStyle;
	designNotes: string[];
	newSkills?: NewSkillDraft[];
	capabilityReport?: RoleCapabilityReport;
	verificationPlanState: "specified" | "missing";
	designSource?: "rules" | "model";
}

const VALID_ROLE_TOOLS = new Set(["read", "edit", "write", "bash", "mcp"]);

/** Normalize explicit tool lists so roles only keep declared, valid runtime capabilities. */
export function normalizeRoleTools(tools: string[] | undefined): string[] {
	if (!Array.isArray(tools)) return ["read"];
	const result: string[] = [];
	for (const raw of tools) {
		const normalized = String(raw).trim().toLowerCase();
		if (VALID_ROLE_TOOLS.has(normalized) && !result.includes(normalized)) {
			result.push(normalized);
		}
	}
	return result;
}

/** Derives a collision-safe kebab-case role ID from title or slug text. */
export function slugifyRoleId(rawTitle: string, existingIds: string[]): string {
	const base =
		rawTitle
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "custom-specialist";
	const taken = new Set(existingIds);
	if (!taken.has(base)) return base;
	let index = 2;
	while (taken.has(`${base}-${index}`)) index += 1;
	return `${base}-${index}`;
}

function deriveRoleNameAndTitle(input: RoleDesignBriefInput): { name: string; title: string } {
	const trimmedName = input.roleName?.trim();
	const trimmedTitle = input.roleTitle?.trim();
	if (trimmedName && trimmedTitle) {
		return {
			name: trimmedName.length > 16 && /[\u4e00-\u9fff]/.test(trimmedTitle) ? trimmedTitle : trimmedName,
			title: trimmedTitle,
		};
	}

	const job = input.oneJob.trim();
	const inferredName =
		trimmedName ||
		(trimmedTitle && trimmedTitle.length <= 14 ? trimmedTitle : "") ||
		job.replace(/[。；，,.!！?？(（].*$/, "").slice(0, 12) ||
		"专项顾问";
	if (trimmedTitle) return { name: inferredName, title: trimmedTitle };

	const rawText = `${job} ${inferredName}`;
	const asciiWords = rawText
		.toLowerCase()
		.match(/[a-z][a-z0-9-]{1,24}/g)
		?.slice(0, 3);
	const domainTitle = /(?:部署|上线|发布|ci|cd)/i.test(rawText)
		? "Release Ops"
		: /(?:运维|监控|排障|告警)/i.test(rawText)
			? "Ops Engineer"
			: /(?:法务|合同|合规|隐私)/i.test(rawText)
				? "Compliance Reviewer"
				: /(?:交互|视觉|设计|ui|ux)/i.test(rawText)
					? "Design Specialist"
					: /(?:财务|预算|税务|成本)/i.test(rawText)
						? "Finance Analyst"
						: /(?:客服|售后|工单)/i.test(rawText)
							? "Support Specialist"
							: null;
	const styleSuffix =
		input.interactionStyle === "risk_observer"
			? "Reviewer"
			: input.interactionStyle === "consult_specialist"
				? "Specialist"
				: "Specialist";
	const fallbackTitle =
		domainTitle ?? (asciiWords?.length ? `${asciiWords.join("-")} ${styleSuffix}` : `Workflow ${styleSuffix}`);
	return { name: inferredName, title: fallbackTitle };
}

function extractKeywordsFromText(parts: Array<string | undefined>, explicit: string[] = []): string[] {
	const result: string[] = [];
	const pushUnique = (raw: string) => {
		const token = raw.trim();
		if (token.length < 2 || token.length > 24) return;
		if (!result.some((existing) => existing.toLowerCase() === token.toLowerCase())) {
			result.push(token);
		}
	};

	for (const item of explicit) pushUnique(item);
	for (const part of parts) {
		if (!part) continue;
		for (const chunk of part.split(/[\n,，、;；。:：/（）()]+/)) {
			const clean = chunk.trim();
			if (clean.length >= 2 && clean.length <= 12) {
				pushUnique(clean);
			}
			const latin = clean.match(/[a-zA-Z][a-zA-Z0-9_-]{2,20}/g) ?? [];
			for (const word of latin) pushUnique(word.toLowerCase());
		}
	}
	return result.slice(0, 10);
}

function resolveToolsForScope(scope: RoleWorkspaceScope): { tools: string[]; summary: string } {
	switch (scope) {
		case "read_write_code":
			return {
				tools: ["read", "edit", "write", "bash"],
				summary: "工作区读写与命令校验（read / edit / write / bash）",
			};
		case "read_only_repo":
			return {
				tools: ["read"],
				summary: "仅只读查看工作区与文档（read，不修改代码、不执行命令）",
			};
		case "no_repo_docs":
			return {
				tools: [],
				summary: "纯分析与文本协同（无文件系统与命令工具）",
			};
	}
}

function buildDefaultAntiJobs(input: {
	interactionStyle: RoleInteractionStyle;
	workspaceScope: RoleWorkspaceScope;
	explicitAntiJobs: string[];
	quietWhen?: string;
}): string[] {
	const list: string[] = [];
	const pushItem = (raw: string) => {
		const cleaned = raw.replace(/^[-*]\s*/, "").trim();
		if (!cleaned) return;
		if (!list.includes(cleaned)) list.push(cleaned);
	};

	for (const item of input.explicitAntiJobs) pushItem(item);
	if (input.workspaceScope !== "read_write_code") {
		pushItem("不直接修改工作区代码或执行命令行变更");
	}
	if (input.interactionStyle === "consult_specialist") {
		pushItem("仅响应内部协同咨询并向主负责人提供专业判断，不直接向用户对外发布成果");
	} else if (input.interactionStyle === "risk_observer") {
		pushItem("只做关键风险、前提冲突与遗漏把关，不越权替代主负责人展开完整方案或修改代码");
	}
	if (input.quietWhen?.trim()) {
		pushItem(`静默原则：${input.quietWhen.trim()}`);
	} else if (input.interactionStyle === "risk_observer") {
		pushItem("静默原则：无实质风险或关键补充时保持安静（输出 [SILENT]），不客套附和");
	} else {
		pushItem("无实质依据或超出职责范围时直接说明边界，不凭记忆猜测");
	}
	return list;
}

export function buildDefaultSuggestedSkillDraft(input: {
	roleId: string;
	name: string;
	title: string;
	oneJob: string;
	antiJobs: string[];
	workflowRules?: string;
	verificationPlan?: string;
}): NewSkillDraft {
	const rawSlug = input.roleId.replace(/^(?:org|usr)-[a-f0-9]{8}-/, "");
	const skillName = slugifySkillName(`${rawSlug || "role"}-playbook`);
	const cleanJob = input.oneJob.replace(/[\r\n]+/g, " ").trim();
	const description = `${input.title} specialized SOP & checklist: ${cleanJob.slice(0, 180)}`;
	const bodyLines = [
		`# ${input.name} (${input.title}) Playbook`,
		"",
		"## When to Use",
		`- Apply whenever acting as ${input.name} on: ${cleanJob}`,
		"",
		"## Core Procedure",
		"1. Confirm task scope and check workspace/context facts before proposing conclusions.",
		input.workflowRules?.trim()
			? `2. Follow workflow gate: ${input.workflowRules.trim()}`
			: "2. Structure output with verdict, evidence, and explicit caveats.",
		...(input.verificationPlan
			? ["3. Verify deliverables against:", `   ${input.verificationPlan.replace(/\n/g, " | ")}`]
			: ["3. Cite concrete observations or command results before finishing."]),
		"",
		"## Boundaries (Anti-Jobs)",
		...(input.antiJobs.length > 0
			? input.antiJobs.map((rule) => `- ${rule}`)
			: ["- Stay strictly within assigned domain scope."]),
	];
	return {
		name: skillName,
		description: description.slice(0, 300),
		body: bodyLines.join("\n"),
		storageScope: "role_local",
	};
}

/**
 * Generates a tightly-scoped, minimal-tool role definition inspired by `dr-eggbot-v2`:
 * one clear job, explicit anti-jobs, quiet rules, and zero leftover tools.
 */
export function buildRoleDesignDraft(input: RoleDesignBriefInput): RoleArchitectDraft {
	const oneJob = input.oneJob.trim();
	if (!oneJob) {
		throw new Error("oneJob is required to design a role");
	}
	const roleScope: RoleScope = input.roleScope ?? "global";
	const ownerOrgId = roleScope === "org" ? input.ownerOrgId?.trim() || null : null;
	const ownerUserId = roleScope === "personal" ? input.ownerUserId?.trim() || null : null;
	const interactionStyle: RoleInteractionStyle = input.interactionStyle ?? "mixed";
	const workspaceScope: RoleWorkspaceScope = input.workspaceScope ?? "read_only_repo";
	const { name, title } = deriveRoleNameAndTitle(input);
	const rawSlug = input.roleId?.trim() || title;
	const existingSet = new Set(input.existingMemberIds ?? []);
	const id =
		roleScope === "global"
			? slugifyRoleId(rawSlug, input.existingMemberIds ?? [])
			: buildScopedRoleId({
					baseId: rawSlug,
					roleScope,
					ownerOrgId,
					ownerUserId,
					existingIds: existingSet,
					allowCollisionSuffix: true,
				});
	const { tools, summary: toolSummary } = resolveToolsForScope(workspaceScope);
	const antiJobs = buildDefaultAntiJobs({
		interactionStyle,
		workspaceScope,
		explicitAntiJobs: input.antiJobs ?? [],
		quietWhen: input.quietWhen,
	});
	const keywords = extractKeywordsFromText([name, title, oneJob, input.workflowRules], input.keywords ?? []);

	const responsibilitiesLines = [
		`- **核心唯一职责**：${oneJob}`,
		...antiJobs.map((item) => `- **不做 / 边界**：${item}`),
	];
	const methodLines = [
		"1. 只围绕当前职责范围核对事实与上下文，不发散到无关岗位工作。",
		input.workflowRules?.trim()
			? `2. 严格遵循团队流程约束：${input.workflowRules.trim()}`
			: "2. 先给结论与依据，再列可执行建议或风险边界，避免空泛套话。",
	];
	const toolSection =
		workspaceScope === "no_repo_docs"
			? "- 纯分析与文稿协作，不挂载文件编辑与终端工具。"
			: workspaceScope === "read_only_repo"
				? "- 仅使用只读文档与代码核查能力（`read`），确保事实可溯源。"
				: "- 具备工作区读写与命令验证能力（`read` / `edit` / `write` / `bash`），改动须附实际运行验证。";
	const baseCollabSection =
		interactionStyle === "risk_observer"
			? "- 默认作为关键风险旁听审视者列席；仅当发现明显冲突或遗漏时简洁插话，其余时刻保持安静。"
			: interactionStyle === "consult_specialist"
				? "- 作为内部专才接受主负责人按需咨询，内部讨论留痕并把可验证判断交给主负责人整合。"
				: interactionStyle === "lead_direct"
					? "- 可作为事项主负责人承接需求，在明确边界内推进并在关键业务取舍处向人确认。"
					: "- 既可独立担任事项主责推进并在关键节点向人确认，也可作为内部协同或旁听成员按事项需要参与。";
	const collabSection = [
		baseCollabSection,
		input.communicationStyle?.trim() ? `- 沟通方式：${input.communicationStyle.trim()}` : "",
	]
		.filter(Boolean)
		.join("\n");
	const explicitPlan = normalizeRoleVerificationPlan(input.verificationPlan);
	const verificationPlan = explicitPlan || input.constraints?.trim();
	const deliverySection = verificationPlan
		? `- 交付与验收要求：${verificationPlan}${explicitPlan && input.constraints?.trim() ? `\n- 额外约束：${input.constraints.trim()}` : ""}`
		: interactionStyle === "lead_direct"
			? "- 形成明确阶段结果时通过正式成果归档，附简练 `changeNote` 与核查依据；普通讨论不归档。"
			: interactionStyle === "mixed"
				? "- 给出有依据的结构化核查或执行结果；在具体事项中担任主责且产出阶段成果时再正式归档。"
				: "- 返回结构化专业意见、核查依据与风险清单，不代替主负责人自行签发正式成果。";

	const sections = {
		responsibilitiesAndBoundaries: responsibilitiesLines.join("\n"),
		skillsAndMethods: methodLines.join("\n"),
		toolsAndEnvironment: toolSection,
		collaborationConventions: collabSection,
		deliveryAndVerification: deliverySection,
	};

	const template: RoleTemplate = {
		id,
		name,
		title,
		roleScope,
		...(ownerOrgId ? { ownerOrgId } : {}),
		...(ownerUserId ? { ownerUserId } : {}),
		version: "1.0.0",
		shareable: roleScope === "global",

		isPrimaryContact: roleScope === "global" && Boolean(input.isPrimaryContact),
		keywords,
		tools,
		skills: [...new Set((input.skills ?? []).map((name) => name.trim()).filter(Boolean))],
		mcpDependencies: [...new Set((input.mcpDependencies ?? []).map((name) => name.trim()).filter(Boolean))],
		antiJobs,
		sections,
		rawBody: formatRoleTemplateBody(sections),
	};

	const validatedNewSkills =
		input.suggestedNewSkills !== undefined
			? validateNewSkillDrafts(input.suggestedNewSkills)
			: [
					buildDefaultSuggestedSkillDraft({
						roleId: id,
						name,
						title,
						oneJob,
						antiJobs,
						workflowRules: input.workflowRules,
						verificationPlan,
					}),
				];

	const designNotes = [
		`已收敛为单核心职责：${oneJob}`,
		`已配置 ${antiJobs.length} 条明确不做边界（Anti-Jobs），避免职责膨胀`,
		`最小权限工具集：${tools.length > 0 ? tools.join(", ") : "无工具（纯文本协同）"}`,
	];

	return {
		template,
		verificationPlanState: verificationPlan ? "specified" : "missing",
		markdown: serializeRoleTemplateMarkdown(template),
		antiJobs,
		toolSummary,
		recommendedParticipation: interactionStyle,
		designNotes,
		newSkills: validatedNewSkills,
	};
}

export interface RoleTemplatePatch {
	tools?: string[];
	addAntiJobs?: string[];
	workflowNote?: string;
}

/**
 * Applies explicit least-privilege tool narrowing or Anti-Job boundary updates to an existing RoleTemplate
 * while preserving unrelated sections and instructions.
 */
export function applyRoleTemplatePatch(template: RoleTemplate, patch: RoleTemplatePatch): RoleTemplate {
	const nextTools = patch.tools !== undefined ? normalizeRoleTools(patch.tools) : [...template.tools];
	const nextAntiJobs = [...(template.antiJobs ?? [])];
	let nextResp = template.sections.responsibilitiesAndBoundaries.trim();

	for (const rawRule of patch.addAntiJobs ?? []) {
		const rule = rawRule.replace(/^[-*]\s*/, "").trim();
		if (!rule) continue;
		if (!nextAntiJobs.includes(rule)) nextAntiJobs.push(rule);
		if (!nextResp.includes(rule)) {
			nextResp = `${nextResp}${nextResp ? "\n" : ""}- **不做 / 边界**：${rule}`;
		}
	}

	let nextConventions = template.sections.collaborationConventions.trim();
	const workflowNote = patch.workflowNote?.trim();
	if (workflowNote && !nextConventions.includes(workflowNote)) {
		nextConventions = `${nextConventions}${nextConventions ? "\n" : ""}- ${workflowNote}`;
	}

	const nextSections = {
		...template.sections,
		responsibilitiesAndBoundaries: nextResp,
		collaborationConventions: nextConventions,
	};

	return {
		...template,
		tools: nextTools,
		...(nextAntiJobs.length > 0 ? { antiJobs: nextAntiJobs } : {}),
		sections: nextSections,
		rawBody: formatRoleTemplateBody(nextSections),
	};
}

/** Reserved role/member ID for the built-in Meta-Bot Role Architect. */
export const ROLE_ARCHITECT_MEMBER_ID = "role-architect";

/** True when a role template or member identity represents the Meta-Bot Role Architect. */
export function isArchitectRoleTemplate(template: Pick<RoleTemplate, "id" | "roleKind"> | null | undefined): boolean {
	return Boolean(template && (template.roleKind === "architect" || template.id === ROLE_ARCHITECT_MEMBER_ID));
}

const ARCHITECT_SECTIONS = {
	responsibilitiesAndBoundaries: [
		"- Help the team owner assign AI roles to a real workflow, fill responsibility gaps, and identify where responsibilities or permissions need narrowing.",
		"- Propose additions and adjustments as structured proposals for the owner to select and confirm. Keep workspace code and role files outside your direct control.",
		"- Base proposals on the actual workflow. If invited into an active matter, confine your work to role planning and collaboration diagnosis. Formal business deliverables remain with the lead.",
	].join("\n"),
	skillsAndMethods: [
		"- Assign one core outcome per role. Specify actions outside its remit, grant only necessary tools, and define when it should remain silent.",
		"- Ask only about gaps that affect responsibilities, capabilities, or outcomes. When the goal is clear, propose a plan using existing members and installed methods where possible.",
	].join("\n"),
	toolsAndEnvironment:
		"- Use the team configuration and recent collaboration evidence supplied by the host for planning and diagnosis. The role has no code-writing or shell tools.",
	collaborationConventions: [
		"- Discuss team design and health in a dedicated matter, or help an existing matter fill a gap or narrow a role's scope when invited.",
		"- Return changes as proposals the owner can confirm. Leave role edits and routine business dispatch to the existing workflow.",
	].join("\n"),
	deliveryAndVerification:
		"- Return a concise conclusion and selectable role drafts with methods, communication rules, Skills, dependencies, and a concrete verification task. Verify capability through execution. Cite actual cases in health findings and state when evidence is missing.",
};

/** Built-in Meta-Bot Role Architect template registered in workbench runtime (never auto-routed for business work). */
export const BUILTIN_ROLE_ARCHITECT_TEMPLATE: RoleTemplate = {
	id: ROLE_ARCHITECT_MEMBER_ID,
	name: "Role Architect",
	title: "Role Architect",
	roleKind: "architect",
	version: "1.1.1",
	shareable: true,

	isPrimaryContact: false,
	keywords: ["角色架构师", "角色", "建队", "分工", "工作流", "体检", "权限", "精简", "补人", "边界", "architect"],
	tools: [],
	skills: ["role-design"],
	mcpDependencies: [],
	antiJobs: [
		"Do not edit workspace code or role files directly. The owner must confirm additions and adjustments",
		"Do not use generic industry presets or add roles without evidence of a gap",
		"Do not take over normal business routing or routine observation",
	],
	sections: ARCHITECT_SECTIONS,
	rawBody: formatRoleTemplateBody(ARCHITECT_SECTIONS),
};
