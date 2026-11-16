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
