import { serializeRoleTemplateMarkdown } from "./template-loader.ts";
import type { RoleTemplate } from "./types.ts";

export type RoleInteractionStyle = "lead_direct" | "consult_specialist" | "risk_observer" | "mixed";
export type RoleWorkspaceScope = "read_write_code" | "read_only_repo" | "no_repo_docs";

export interface RoleDesignBriefInput {
	oneJob: string;
	antiJobs?: string[];
	quietWhen?: string;
	interactionStyle?: RoleInteractionStyle;
	workspaceScope?: RoleWorkspaceScope;
	roleName?: string;
	roleTitle?: string;
	keywords?: string[];
	workflowRules?: string;
	constraints?: string;
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

function slugifyRoleId(rawTitle: string, existingIds: string[]): string {
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
	if (trimmedName && trimmedTitle) return { name: trimmedName, title: trimmedTitle };

	const job = input.oneJob.trim();
	const inferredName = trimmedName || job.replace(/[。；，,.!！?？].*$/, "").slice(0, 14) || "专项顾问";
	if (trimmedTitle) return { name: inferredName, title: trimmedTitle };

	const asciiWords = `${job} ${inferredName}`
		.toLowerCase()
		.match(/[a-z][a-z0-9-]{1,24}/g)
		?.slice(0, 3);
	const styleSuffix =
		input.interactionStyle === "risk_observer"
			? "Reviewer"
			: input.interactionStyle === "consult_specialist"
				? "Specialist"
				: "Coordinator";
	const fallbackTitle = asciiWords?.length ? `${asciiWords.join("-")} ${styleSuffix}` : `Workflow ${styleSuffix}`;
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
	return list.slice(0, 8);
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
	const interactionStyle: RoleInteractionStyle = input.interactionStyle ?? "consult_specialist";
	const workspaceScope: RoleWorkspaceScope = input.workspaceScope ?? "read_only_repo";
	const { name, title } = deriveRoleNameAndTitle(input);
	const id = slugifyRoleId(title, input.existingMemberIds ?? []);
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
	const collabSection =
		interactionStyle === "risk_observer"
			? "- 默认作为关键风险旁听审视者列席；仅当发现明显冲突或遗漏时简洁插话，其余时刻保持安静。"
			: interactionStyle === "consult_specialist"
				? "- 作为内部专才接受主负责人按需咨询，内部讨论留痕并把可验证判断交给主负责人整合。"
				: "- 可作为事项主负责人承接需求，在明确边界内推进并在关键业务取舍处向人确认。";
	const deliverySection = input.constraints?.trim()
		? `- 交付与验收要求：${input.constraints.trim()}`
		: interactionStyle === "lead_direct"
			? "- 形成明确阶段结果时通过正式成果归档，附简练 `changeNote` 与核查依据；普通讨论不归档。"
			: "- 返回结构化专业意见、核查依据与风险清单，不代替主负责人自行签发正式成果。";

	const sections = {
		responsibilitiesAndBoundaries: responsibilitiesLines.join("\n"),
		skillsAndMethods: methodLines.join("\n"),
		toolsAndEnvironment: toolSection,
		collaborationConventions: collabSection,
		deliveryAndVerification: deliverySection,
	};

	const rawBody = [
		`## 职责与边界\n${sections.responsibilitiesAndBoundaries}`,
		`## 技能与工作方法\n${sections.skillsAndMethods}`,
		`## 工具与环境依赖\n${sections.toolsAndEnvironment}`,
		`## 协作和沟通约定\n${sections.collaborationConventions}`,
		`## 交付与验证方式\n${sections.deliveryAndVerification}`,
	].join("\n\n");

	const template: RoleTemplate = {
		id,
		name,
		title,
		version: "1.0.0",
		shareable: true,
		defaultProvider: "kimi-coding",
		defaultModel: "kimi-for-coding",
		thinkingLevel: "high",
		isPrimaryContact: Boolean(input.isPrimaryContact),
		keywords,
		tools,
		skills: [],
		mcpDependencies: [],
		antiJobs,
		sections,
		rawBody,
	};

	const designNotes = [
		`已收敛为单核心职责：${oneJob}`,
		`已配置 ${antiJobs.length} 条明确不做边界（Anti-Jobs），避免职责膨胀`,
		`最小权限工具集：${tools.length > 0 ? tools.join(", ") : "无工具（纯文本协同）"}`,
	];

	return {
		template,
		markdown: serializeRoleTemplateMarkdown(template),
		antiJobs,
		toolSummary,
		recommendedParticipation: interactionStyle,
		designNotes,
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

	const rawBody = [
		`## 职责与边界\n${nextSections.responsibilitiesAndBoundaries}`,
		`## 技能与工作方法\n${nextSections.skillsAndMethods}`,
		`## 工具与环境依赖\n${nextSections.toolsAndEnvironment}`,
		`## 协作和沟通约定\n${nextSections.collaborationConventions}`,
		`## 交付与验证方式\n${nextSections.deliveryAndVerification}`,
	]
		.filter((block) => !block.endsWith("\n"))
		.join("\n\n");

	return {
		...template,
		tools: nextTools,
		...(nextAntiJobs.length > 0 ? { antiJobs: nextAntiJobs } : {}),
		sections: nextSections,
		rawBody,
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
		"- **One Job（唯一核心职责）**：协助团队所有者围绕真实工作流规划 1~N 个专职 AI 角色分工、补齐岗位缺口，或做团队协作体检与权限/边界收窄建议。",
		"- **不做 / 边界**：不直接修改工作区代码或角色模板文件，所有新增或调整均先形成结构化提案，经团队所有者勾选确认后才落盘生效。",
		"- **不做 / 边界**：不套用泛行业预设，不替代业务主负责人直接对外发布正式成果；在事项中被中途请入时，仅围绕当前事项与团队协作提供角色规划或诊断。",
	].join("\n"),
	skillsAndMethods: [
		"- 坚持 One Job + Explicit Anti-Jobs + Least Privilege Tools（最小必要工具权限）+ Keep Silent When Useful。",
		"- 信息不足时先用 2~3 个关键问题厘清真实协作流程与人工确认节点，再产出最小可行角色或现有角色微调草案。",
	].join("\n"),
	toolsAndEnvironment:
		"- 纯规划与只读诊断角色：不挂载代码写工具与 bash，依托宿主注入的团队配置与近期协作体检摘要进行评估。",
	collaborationConventions: [
		"- 作为元角色可在专属对话事项中长期讨论建队与体检，也可在业务事项推进到任意阶段时被中途请入补人或收窄边界。",
		"- 所有建议均输出为可确认提案卡片，不擅自改写他人职责或接管日常业务派发。",
	].join("\n"),
	deliveryAndVerification: "- 输出精炼结论、必要追问短选项，以及可直接勾选创建/调整的结构化角色草案与建议阵型。",
};

/** Built-in Meta-Bot Role Architect template registered in workbench runtime (never auto-routed for business work). */
export const BUILTIN_ROLE_ARCHITECT_TEMPLATE: RoleTemplate = {
	id: ROLE_ARCHITECT_MEMBER_ID,
	name: "角色架构师",
	title: "Role Architect",
	roleKind: "architect",
	version: "1.0.0",
	shareable: true,
	defaultProvider: "kimi-coding",
	defaultModel: "kimi-for-coding",
	thinkingLevel: "high",
	isPrimaryContact: false,
	keywords: ["角色", "建队", "分工", "工作流", "体检", "权限", "精简", "补人", "边界", "architect"],
	tools: [],
	skills: [],
	mcpDependencies: [],
	antiJobs: [
		"不直接修改工作区代码或角色文件，所有新增或调整须由团队所有者勾选确认后生效",
		"不套用泛行业预设，不未经追问强行扩编多余角色",
		"不主动接管普通业务事项的自动路由与日常旁听",
	],
	sections: ARCHITECT_SECTIONS,
	rawBody: [
		`## 职责与边界\n${ARCHITECT_SECTIONS.responsibilitiesAndBoundaries}`,
		`## 技能与工作方法\n${ARCHITECT_SECTIONS.skillsAndMethods}`,
		`## 工具与环境依赖\n${ARCHITECT_SECTIONS.toolsAndEnvironment}`,
		`## 协作和沟通约定\n${ARCHITECT_SECTIONS.collaborationConventions}`,
		`## 交付与验证方式\n${ARCHITECT_SECTIONS.deliveryAndVerification}`,
	].join("\n\n"),
};
