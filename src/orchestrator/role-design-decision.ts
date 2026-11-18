import { assessRoleCapabilities, listScopedSkillCatalog } from "../roles/capabilities.ts";
import {
	buildRoleDesignDraft,
	isArchitectRoleTemplate,
	normalizeRoleVerificationPlan,
	type RoleArchitectDraft,
	type RoleDesignBriefInput,
	type RoleInteractionStyle,
	type RoleVerificationPlan,
	type RoleWorkspaceScope,
	slugifyRoleId,
} from "../roles/role-architect.ts";
import { allowedSkillScopesForRole, buildScopedRoleId, validateNewSkillDrafts } from "../roles/role-package-store.ts";
import type { NewSkillDraft, RoleScope, RoleTemplate } from "../roles/types.ts";
import type { TeamMember } from "../storage/types.ts";
import { runTypedPiDecision } from "./pi-decision.ts";
import { truncateInline, type WorkerFactory } from "./types.ts";

const VALID_STYLES = new Set<RoleInteractionStyle>(["lead_direct", "consult_specialist", "risk_observer", "mixed"]);
const VALID_SCOPES = new Set<RoleWorkspaceScope>(["no_repo_docs", "read_only_repo", "read_write_code"]);

export interface RoleDesignDecisionPayload {
	id: string;
	name: string;
	title: string;
	oneJob: string;
	antiJobs: string[];
	quietWhen: string;
	keywords: string[];
	skills: string[];
	newSkills?: NewSkillDraft[];
	interactionStyle: RoleInteractionStyle;
	workspaceScope: RoleWorkspaceScope;
	communicationStyle: string;
	workflowRules?: string;
	verificationPlan: string | RoleVerificationPlan;
	designRationale: string;
}

/** Validates structured JSON from the Pi role designer against strict schema, installed skills, and ID constraints. */
export function validateRoleDesignDecision(
	raw: Record<string, unknown>,
	context: {
		explicit: RoleDesignBriefInput;
		existingMemberIds: string[];
		installedSkills: Set<string>;
	},
): RoleDesignDecisionPayload | null {
	const nameRaw = context.explicit.roleName?.trim() || (typeof raw.name === "string" ? raw.name.trim() : "");
	const titleRaw = context.explicit.roleTitle?.trim() || (typeof raw.title === "string" ? raw.title.trim() : "");
	const oneJobRaw =
		typeof raw.oneJob === "string" && raw.oneJob.trim() ? raw.oneJob.trim() : context.explicit.oneJob.trim();
	if (!nameRaw || !titleRaw || !oneJobRaw) return null;

	// Reject oversized sentence-like names when the caller did not force one.
	const cleanName = nameRaw.slice(0, 16);
	const roleScope: RoleScope = context.explicit.roleScope ?? "global";
	const rawId = context.explicit.roleId?.trim() || (typeof raw.id === "string" ? raw.id.trim() : "");
	const id =
		roleScope === "global"
			? slugifyRoleId(rawId || titleRaw, [...context.existingMemberIds, "role-architect"])
			: buildScopedRoleId({
					baseId: rawId || titleRaw,
					roleScope,
					ownerOrgId: context.explicit.ownerOrgId,
					ownerUserId: context.explicit.ownerUserId,
					existingIds: new Set([...context.existingMemberIds, "role-architect"]),
					allowCollisionSuffix: true,
				});

	const rawAntiJobs = Array.isArray(raw.antiJobs)
		? raw.antiJobs.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean)
		: [];
	const mergedAntiJobs = Array.from(new Set([...(context.explicit.antiJobs ?? []), ...rawAntiJobs.slice(0, 6)]));
	if (mergedAntiJobs.length === 0) return null;

	const quietWhen =
		context.explicit.quietWhen?.trim() ||
		(typeof raw.quietWhen === "string" ? raw.quietWhen.trim() : "") ||
		"职责范围之外且无明确风险增量时保持简短或静默";

	const rawKeywords = Array.isArray(raw.keywords)
		? raw.keywords.map((s) => (typeof s === "string" ? s.trim() : "")).filter((s) => s.length >= 2 && s.length <= 24)
		: [];
	const keywords = Array.from(new Set([...(context.explicit.keywords ?? []), ...rawKeywords])).slice(0, 8);
	if (keywords.length === 0) return null;

	const rawSkills = Array.isArray(raw.skills)
		? raw.skills.map((s) => (typeof s === "string" ? s.trim() : "")).filter((s) => context.installedSkills.has(s))
		: [];
	const skills = Array.from(new Set([...(context.explicit.skills ?? []), ...rawSkills.slice(0, 4)]));

	const styleRaw = typeof raw.interactionStyle === "string" ? raw.interactionStyle.trim() : "";
	const interactionStyle =
		context.explicit.interactionStyle ??
		(VALID_STYLES.has(styleRaw as RoleInteractionStyle) ? (styleRaw as RoleInteractionStyle) : "mixed");

	const scopeRaw = typeof raw.workspaceScope === "string" ? raw.workspaceScope.trim() : "";
	const workspaceScope =
		context.explicit.workspaceScope ??
		(VALID_SCOPES.has(scopeRaw as RoleWorkspaceScope) ? (scopeRaw as RoleWorkspaceScope) : "read_only_repo");

	const communicationStyle =
		context.explicit.communicationStyle?.trim() ||
		(typeof raw.communicationStyle === "string" ? raw.communicationStyle.trim() : "") ||
		"先给结论与依据，再附必要边界说明。";
	const workflowRules =
		context.explicit.workflowRules?.trim() ||
		(typeof raw.workflowRules === "string" && raw.workflowRules.trim() ? raw.workflowRules.trim() : undefined);

	const verificationPlan =
		normalizeRoleVerificationPlan(context.explicit.verificationPlan) ||
		(raw.verificationPlan && typeof raw.verificationPlan === "object"
			? normalizeRoleVerificationPlan(raw.verificationPlan)
			: undefined);
	if (!verificationPlan) return null;

	const designRationale =
		typeof raw.designRationale === "string" && raw.designRationale.trim()
			? raw.designRationale.trim()
			: "由 Pi 角色设计模型结合团队分工与最小权限原则生成。";

	let newSkills: NewSkillDraft[] | undefined;
	if (Array.isArray(raw.newSkills) && raw.newSkills.length > 0) {
		try {
			const validated = validateNewSkillDrafts(raw.newSkills, {
				roleScope,
				allowedScopes: allowedSkillScopesForRole(roleScope, roleScope === "global"),
			});
			if (validated.length > 0) newSkills = validated;
		} catch {
			// Ignore malformed model-generated newSkills and allow rule fallback draft to propose a clean SOP.
		}
	}

	return {
		id,
		name: cleanName,
		title: titleRaw,
		oneJob: oneJobRaw,
		antiJobs: mergedAntiJobs,
		quietWhen,
		keywords,
		skills,
		...(newSkills ? { newSkills } : {}),
		interactionStyle,
		workspaceScope,
		communicationStyle,
		...(workflowRules ? { workflowRules } : {}),
		verificationPlan,
		designRationale,
	};
}

/**
 * Generates a tightly-scoped, capability-aware role blueprint using an isolated typed Pi LLM decision call,
 * reusing existing skills catalog and existing roster context while preserving deterministic Markdown structure.
 */
export async function designRoleDraftWithModel(
	deps: {
		defaultCwd: string;
		skillsDir?: string;
		workerFactory: WorkerFactory;
		members: TeamMember[];
		templatesByRoleId: Map<string, RoleTemplate>;
	},
	input: RoleDesignBriefInput & { timeoutMs?: number; signal: AbortSignal },
): Promise<RoleArchitectDraft> {
	const oneJob = input.oneJob.trim();
	if (!oneJob) {
		throw new Error("oneJob is required to design a role");
	}
	const businessMembers = deps.members.filter(
		(m) =>
			!isArchitectRoleTemplate(
				deps.templatesByRoleId.get(m.templateId) ?? deps.templatesByRoleId.get(m.id) ?? { id: m.id },
			),
	);
	const primary = businessMembers.find((m) => m.isPrimaryContact) ?? businessMembers[0] ?? deps.members[0] ?? null;

	const skillCatalog = await listScopedSkillCatalog({
		skillsDir: deps.skillsDir,
		roleScope: input.roleScope,
		ownerOrgId: input.ownerOrgId,
		ownerUserId: input.ownerUserId,
	});
	const installedSkills = new Set(skillCatalog.map((s) => s.name));
	const rosterSummary = businessMembers
		.map((m) => {
			const tpl = deps.templatesByRoleId.get(m.templateId) ?? deps.templatesByRoleId.get(m.id);
			const resp = truncateInline(tpl?.sections.responsibilitiesAndBoundaries ?? "", 120);
			return `- ${m.id} | ${m.displayName} (${m.roleTitle})${resp ? `: ${resp}` : ""}`;
		})
		.join("\n");

	const roleScope = input.roleScope ?? "global";
	const allowedNewSkillScopes = allowedSkillScopesForRole(roleScope, roleScope === "global").join(" | ");

	const systemPrompt = [
		"你是 Personal Agent 的 **AI 角色设计决策引擎（Typed Role Designer）**。",
		"根据用户提供的岗位需求，输出严格符合最小权限与单核心职责原则的角色结构化设计方案。",
		"",
		"## 设计准则",
		"1. **One Job & Explicit Anti-Jobs**：`oneJob` 提炼为清晰单一句；`antiJobs` 写 2~4 条明确不做边界（防止与现有成员重叠或越权改代码/拍板）。",
		"2. Use a short English display name unless the user supplies a name. Use a short English title and a unique lowercase kebab-case ID.",
		"3. **技能仅选已安装目录**：`skills` 只能从以下已安装技能 ID 中挑选确有帮助的项，不得编造名称。",
		"4. **可选新建 Skill 草案 (`newSkills`)**：若现有目录缺少该岗位的专属方法或清单，可在 `newSkills` 中附带 1 条待用户确认后才落盘的新 Skill 草案（勿直接填入 `skills`）；默认 `storageScope` 为 `role_local`。",
		"5. **完整验证计划**：`verificationPlan` 必须包含具体小任务 `task`、可观察通过条件 `successCriteria` 与越界校验 `boundaryCheck`。",
		"",
		"## 严格输出格式（仅返回合法 JSON 对象，勿附带多余正文）",
		JSON.stringify(
			{
				id: "release-ops",
				name: "Release Ops Specialist",
				title: "Release Ops Specialist",
				oneJob: "一句话明确核心职责",
				antiJobs: ["不做边界1", "不做边界2"],
				quietWhen: "无相关风险或不在职责范围内时保持安静",
				keywords: ["关键词1", "关键词2", "关键词3"],
				skills: ["仅填下方已安装技能 ID 或 []"],
				newSkills: [
					{
						name: "release-checklist",
						description: "One-line trigger description for the proposed skill",
						body: "# Release Checklist\\n\\n1. Concrete step\\n2. Boundary check",
						storageScope: allowedNewSkillScopes,
					},
				],
				interactionStyle: "lead_direct | consult_specialist | risk_observer | mixed",
				workspaceScope: "no_repo_docs | read_only_repo | read_write_code",
				communicationStyle: "简短明确的团队沟通风格约定",
				workflowRules: "团队协作与交接规则（可选）",
				verificationPlan: {
					task: "具体最小验证任务",
					successCriteria: "可核查的通过标准",
					boundaryCheck: "如何检验未越权修改或越界决策",
				},
				designRationale: "一句说明职责定位与工具范围取舍理由",
			},
			null,
			2,
		),
	].join("\n");

	const userPrompt = [
		`## 已有团队成员（避免 ID 与职责冲突）\n${rosterSummary || "（暂无）"}`,
		`## 已安装 Skills 目录\n${JSON.stringify(skillCatalog)}`,
		`## 用户指定配置（优先保留；未安装的显式依赖仅标记缺失，不擅自删除或安装）\n${JSON.stringify({
			roleId: input.roleId,
			skills: input.skills,
			mcpDependencies: input.mcpDependencies,
			quietWhen: input.quietWhen,
			communicationStyle: input.communicationStyle,
			constraints: input.constraints,
			verificationPlan: input.verificationPlan,
		})}`,
		[
			"## 用户创建请求",
			`- 核心职责输入: ${oneJob}`,
			input.roleName?.trim() ? `- 指定显示名: ${input.roleName.trim()}` : "",
			input.roleTitle?.trim() ? `- 指定英文头衔: ${input.roleTitle.trim()}` : "",
			input.workspaceScope ? `- 用户指定工具范围: ${input.workspaceScope}` : "",
			input.interactionStyle ? `- 用户指定协作站位: ${input.interactionStyle}` : "",
			input.antiJobs?.length ? `- 用户勾选不做边界: ${input.antiJobs.join("；")}` : "",
			input.workflowRules?.trim() ? `- 用户团队协作规则: ${input.workflowRules.trim()}` : "",
			input.keywords?.length ? `- 用户提供关键词: ${input.keywords.join(", ")}` : "",
		]
			.filter(Boolean)
			.join("\n"),
	].join("\n\n");

	const { decision } = await runTypedPiDecision(
		{
			cwd: deps.defaultCwd,
			provider: primary?.provider ?? "kimi-coding",
			model: primary?.model ?? "kimi-for-coding",
			workerFactory: deps.workerFactory,
		},
		{
			name: "role_design_decision",
			systemPrompt,
			userPrompt,
			tools: [],
			thinkingLevel: "low",
			validate: (raw) =>
				validateRoleDesignDecision(raw, {
					explicit: input,
					existingMemberIds: deps.members.map((m) => m.id),
					installedSkills,
				}),
		},
		{
			timeoutMs: input.timeoutMs ?? 60_000,
			signal: input.signal,
		},
	);

	const draft = buildRoleDesignDraft({
		roleId: decision.id,
		roleName: decision.name,
		roleTitle: decision.title,
		oneJob: decision.oneJob,
		antiJobs: decision.antiJobs,
		quietWhen: decision.quietWhen,
		interactionStyle: decision.interactionStyle,
		workspaceScope: decision.workspaceScope,
		roleScope: input.roleScope,
		ownerOrgId: input.ownerOrgId,
		ownerUserId: input.ownerUserId,
		keywords: decision.keywords,
		workflowRules: decision.workflowRules,
		skills: decision.skills,
		...(decision.newSkills ? { suggestedNewSkills: decision.newSkills } : {}),
		mcpDependencies: input.mcpDependencies,
		communicationStyle: decision.communicationStyle,
		verificationPlan: decision.verificationPlan,
		constraints: input.constraints,
		isPrimaryContact: input.isPrimaryContact,
		existingMemberIds: deps.members.map((m) => m.id),
	});

	return {
		...draft,
		capabilityReport: await assessRoleCapabilities(draft.template, { skillsDir: deps.skillsDir }),
		designNotes: [decision.designRationale, ...draft.designNotes.slice(1)],
		designSource: "model",
	};
}
