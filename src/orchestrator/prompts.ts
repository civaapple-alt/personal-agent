import { isArchitectRoleTemplate } from "../roles/role-architect.ts";
import type { RoleTemplate } from "../roles/types.ts";
import { type PersonalAgentStore, resolveEffectiveGitIdentity } from "../storage/repositories.ts";
import type {
	Deliverable,
	Matter,
	MatterMessage,
	MemberMemory,
	Organization,
	TeamMember,
	WorkspaceLink,
} from "../storage/types.ts";
import { messageMatchesContext, selectMatterContext } from "./matter-context.ts";
import { PUBLICATION_REVIEW_GUIDANCE } from "./publication-review.ts";
import {
	MEMORY_CATEGORY_PROMPT_LABELS,
	OBSERVER_SILENT_SENTINEL,
	type ProgressSnapshot,
	truncateInline,
} from "./types.ts";

export function parseSnapshotFromMetadata(metadata: Record<string, unknown> | null): ProgressSnapshot | null {
	const raw = metadata?.progressSnapshot;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const rec = raw as Record<string, unknown>;
	if (typeof rec.stage !== "string" || typeof rec.label !== "string") return null;
	if (rec.outcome !== "failed" && rec.outcome !== "aborted") return null;
	return rec as unknown as ProgressSnapshot;
}

export function buildInterruptionResumeBrief(input: {
	store: PersonalAgentStore;
	matterId: string;
	workspaceId: string | null;
	orgId?: string | null;
	repoPath: string;
	messages: MatterMessage[];
	afterCursor: number;
	excludeIds: Set<string>;
}): string {
	const inScope = (msg: MatterMessage) => !input.excludeIds.has(msg.id) && messageMatchesContext(msg, input);
	const recentScoped = input.messages
		.slice(input.afterCursor)
		.filter((msg) => inScope(msg) && !msg.metadata?.observerIntervention);
	const lastOutcome = [...recentScoped].reverse().find((msg) => msg.senderType !== "user");
	if (!lastOutcome) return "";
	const isFailed = lastOutcome.metadata?.failed === true;
	const isAborted = lastOutcome.metadata?.aborted === true;
	if (!isFailed && !isAborted) return "";

	const snapshot = parseSnapshotFromMetadata(lastOutcome.metadata);
	const errorDetail = typeof lastOutcome.metadata?.error === "string" ? lastOutcome.metadata.error : "";
	const cancelReason = typeof lastOutcome.metadata?.cancelReason === "string" ? lastOutcome.metadata.cancelReason : "";
	const lines: string[] = ["## 上次中断状态简报（用于基于断点快速续跑）"];

	if (isFailed) {
		lines.push(
			`- 中断原因：执行异常未完成${errorDetail ? `（${truncateInline(errorDetail, 120)}）` : ""}${snapshot ? `，停滞前已运行 ${snapshot.elapsedSeconds}s` : ""}`,
		);
	} else {
		const reasonText = cancelReason === "shutdown" ? "服务重启/关闭中止" : "用户手动停止";
		lines.push(`- 中断原因：${reasonText}${snapshot ? `，停止前已运行 ${snapshot.elapsedSeconds}s` : ""}`);
	}

	if (snapshot) {
		lines.push(`- 停滞阶段：${snapshot.stage}（${truncateInline(snapshot.label, 96)}）`);
		if (snapshot.activeDelegations && snapshot.activeDelegations.length > 0) {
			lines.push(
				`- 中断时仍在协同的岗位：${snapshot.activeDelegations.map((entry) => `${entry.memberName}（${entry.stageLabel}）`).join("、")}`,
			);
		}
		if (snapshot.recentLogs && snapshot.recentLogs.length > 0) {
			lines.push("- 中断前最近执行轨迹：");
			for (const entry of snapshot.recentLogs) {
				lines.push(`  - ${entry.memberName}：${truncateInline(entry.summary, 96)}`);
			}
		}
	}

	const scopedAll = input.messages.filter((msg) => inScope(msg));
	const scopedOutcomeIdx = scopedAll.lastIndexOf(lastOutcome);
	const turnUserStart =
		scopedOutcomeIdx >= 0
			? [...scopedAll.slice(0, scopedOutcomeIdx)].reverse().find((msg) => msg.senderType === "user")
			: undefined;
	const collabMessages = selectMatterContext({
		...input,
		messages: input.store.listMessages(input.matterId),
		deliverables: [],
	}).messages.filter((msg) => msg.channel === "internal_collab");
	const responseByReqId = new Map<string, MatterMessage>();
	for (const msg of collabMessages) {
		const reqId = typeof msg.metadata?.requestMessageId === "string" ? msg.metadata.requestMessageId : null;
		if (reqId) responseByReqId.set(reqId, msg);
	}
	const turnDelegations = collabMessages.filter(
		(msg) =>
			msg.senderType === "member" &&
			typeof msg.metadata?.toMemberId === "string" &&
			(!turnUserStart || msg.createdAt >= turnUserStart.createdAt) &&
			msg.createdAt <= lastOutcome.createdAt,
	);
	if (turnDelegations.length > 0) {
		lines.push("- 上轮内部委托情况：");
		for (const req of turnDelegations.slice(-6)) {
			const toId = String(req.metadata?.toMemberId ?? "");
			const toName = input.store.getMember(toId)?.displayName ?? toId;
			const resp = responseByReqId.get(req.id);
			const statusLabel = resp
				? resp.metadata?.failed === true || resp.senderType === "system"
					? "未完成/中断"
					: "已完成"
				: "未返回/中断";
			const taskSnippet = truncateInline(req.content.replace(/^@[^:：]+[:：]\s*/, ""), 64);
			lines.push(`  - ${toName}【${statusLabel}】：${taskSnippet}`);
		}
	}

	lines.push(
		"- 续跑指引：你与已接入协同岗位的原有 Pi 会话均已自动恢复；请优先核查上述断点与现场文件/进程状态，直接衔接未完成工作，避免重复已完成步骤。",
	);
	return lines.join("\n");
}

export function formatMessageHistorySpeaker(message: MatterMessage): string {
	if (message.senderType === "user") {
		const authorName =
			typeof message.metadata?.authorName === "string" && message.metadata.authorName.trim()
				? message.metadata.authorName.trim()
				: null;
		const authorRole =
			typeof message.metadata?.authorRole === "string" && message.metadata.authorRole.trim()
				? message.metadata.authorRole.trim()
				: null;
		const modeTag =
			message.metadata?.mode === "discussion"
				? "[团队讨论]"
				: message.metadata?.mode === "ai_request"
					? "[同事提请]"
					: "";
		if (authorName) {
			const rolePart = authorRole ? ` (${authorRole})` : "";
			return modeTag ? `${modeTag} ${authorName}${rolePart}` : `${authorName}${rolePart}`;
		}
		if (modeTag) return `${modeTag} user/${message.senderId}`;
	}
	return `${message.senderType}/${message.senderId}`;
}

export function formatMessageHistoryContent(message: MatterMessage): string {
	const rawImages = Array.isArray(message.metadata?.images) ? message.metadata.images : [];
	const trimmed = message.content.trim();
	if (rawImages.length === 0) return message.content;
	const badge = `[附带 ${rawImages.length} 张图片]`;
	return trimmed ? `${trimmed}\n${badge}` : badge;
}

export function buildObserverTaskPrompt(input: {
	leadMember: TeamMember;
	userPrompt: string;
	leadReply: string;
	imageCount?: number;
}): string {
	const trimmedUser = input.userPrompt.trim();
	const userPart = trimmedUser
		? `${truncateInline(trimmedUser, 2000)}${input.imageCount ? `\n（用户同时附带了 ${input.imageCount} 张图片）` : ""}`
		: `（用户发送了 ${input.imageCount ?? 1} 张图片，未附带额外文字）`;
	const leadPart = input.leadReply.trim().slice(0, 6000);
	return [
		"请从你的本职岗位视角快速审视本轮讨论，判断是否需要主动插话补充：",
		"",
		`【用户发言】\n${userPart}`,
		"",
		`【主负责人 ${input.leadMember.displayName}（${input.leadMember.roleTitle}）的最新回复】\n${leadPart}`,
		"",
		`如果有重要风险、关键遗漏或必须提前纠正/补充的专业建议，请直接面向用户给出简洁具体的发言；如果已妥当或暂无需要补充的实质内容，请仅回复 ${OBSERVER_SILENT_SENTINEL}。`,
	].join("\n");
}

export function buildObserverContextDigest(input: {
	matter: Matter | null;
	deliverables: Deliverable[];
	history: MatterMessage[];
	includeMatterHeader: boolean;
}): string {
	const parts: string[] = [];
	if (input.includeMatterHeader && input.matter) {
		if (input.matter.title) parts.push(`事项主题：${truncateInline(input.matter.title, 120)}`);
		if (input.matter.summary) parts.push(`阶段摘要：${truncateInline(input.matter.summary, 280)}`);
		if (input.deliverables.length > 0) {
			const latestByTitle = new Map<string, Deliverable>();
			for (const item of input.deliverables) {
				const prev = latestByTitle.get(item.title);
				if (!prev || item.version > prev.version) latestByTitle.set(item.title, item);
			}
			const list = [...latestByTitle.values()].map((d) => `${d.title} (V${d.version})`).join("、");
			if (list) parts.push(`已归档成果：${truncateInline(list, 240)}`);
		}
	}
	if (input.history.length > 0) {
		const lines = input.history
			.slice(-16)
			.map(
				(message) =>
					`- ${formatMessageHistorySpeaker(message)}: ${truncateInline(formatMessageHistoryContent(message), 400)}`,
			);
		const headerLen = parts.join("\n").length;
		const remainingBudget = Math.max(1200, 6000 - headerLen - 32);
		const kept: string[] = [];
		let used = 0;
		for (let i = lines.length - 1; i >= 0; i -= 1) {
			const line = lines[i]!;
			if (used + line.length + 1 > remainingBudget && kept.length > 0) break;
			kept.unshift(line);
			used += line.length + 1;
		}
		parts.push(`此前最近对话摘录：\n${kept.join("\n")}`);
	}
	return parts.join("\n");
}

/** Compose effective worker prompt combining role rules, scoped memories, workspace constraints, and task. */
export function buildMemberSystemPrompt(input: {
	member: TeamMember;
	template?: RoleTemplate;
	memories: MemberMemory[];
	workspace: WorkspaceLink | null;
	organization?: Organization | null;
	repoGitUser?: { name: string; email: string } | null;
	taskPrompt?: string;
	isInternalDelegation?: boolean;
	sessionMode?: "lead" | "internal" | "observer";
	teamMembers: TeamMember[];
	extraGuidance?: string;
}): string {
	const mode = input.sessionMode ?? (input.isInternalDelegation ? "internal" : "lead");
	const organization = input.organization ?? null;
	const gitIdentity = resolveEffectiveGitIdentity(input.member, organization);
	const repoGitUser = input.repoGitUser;
	const identityLines = [
		`- 成员标识：\`${input.member.id}\`（${input.member.displayName} · ${input.member.roleTitle}）`,
		organization
			? `- 所属组织：${organization.name}${organization.description ? `（${organization.description}）` : ""}`
			: null,
		`- Git Author（角色署名）：${gitIdentity.gitName} <${gitIdentity.gitEmail}>`,
		repoGitUser
			? `- Git Committer（真实用户保留）：${repoGitUser.name} <${repoGitUser.email}>（执行环境已分别注入 GIT_AUTHOR_* 与 GIT_COMMITTER_*，提交时将区分角色作者并保留真实提交者，请勿修改全局或仓库 Git 配置）`
			: `- Git 提交署名（Author / Committer）：${gitIdentity.gitName} <${gitIdentity.gitEmail}>（执行环境已自动注入 GIT_AUTHOR_* / GIT_COMMITTER_*，请勿修改全局 Git 配置）`,
		input.member.identitySummary ? `- 角色背景与专长：${input.member.identitySummary}` : null,
	].filter(Boolean);
	const sections: string[] = [
		`你当前担任 Personal Agent 团队中的【${input.member.displayName} (${input.member.roleTitle})】。`,
		`## 角色与组织身份（Role & Organization Identity）\n${identityLines.join("\n")}`,
	];

	if (input.template) {
		if (input.template.sections.responsibilitiesAndBoundaries) {
			sections.push(`## 岗位职责与边界\n${input.template.sections.responsibilitiesAndBoundaries}`);
		}
		if (input.template.antiJobs && input.template.antiJobs.length > 0) {
			sections.push(
				`## 明确不做清单（Anti-Jobs）\n${input.template.antiJobs.map((rule) => `- ${rule}`).join("\n")}`,
			);
		}
		if (input.template.sections.skillsAndMethods) {
			sections.push(`## 工作方法\n${input.template.sections.skillsAndMethods}`);
		}
		if (input.template.sections.toolsAndEnvironment) {
			sections.push(`## 工具与环境依赖\n${input.template.sections.toolsAndEnvironment}`);
		}
		if (input.template.sections.collaborationConventions) {
			sections.push(`## 协作和沟通约定\n${input.template.sections.collaborationConventions}`);
		}
		if (input.template.sections.deliveryAndVerification) {
			sections.push(`## 交付与验收标准\n${input.template.sections.deliveryAndVerification}`);
		}
	}

	if (input.memories.length > 0) {
		const formatMemoryLine = (m: MemberMemory): string => {
			const tag = m.status === "verified" ? `已验证 · ${m.scope}` : `待验证 · ${m.scope}`;
			const catPrefix =
				m.category && m.category !== "general"
					? `【${MEMORY_CATEGORY_PROMPT_LABELS[m.category] ?? m.category}】`
					: "";
			const suffix =
				m.status === "candidate"
					? "（待核实：若在当前工作中发现不成立或需修正，可调用 propose_experience 提出替代）"
					: "";
			return `- [${m.id} | ${tag}] ${catPrefix}${m.content}${suffix}`;
		};
		const groups: Array<{ title: string; items: MemberMemory[] }> = [
			{
				title: "### 岗位通用经验（role_general，跨组织与跨仓库通用）",
				items: input.memories.filter((m) => m.scope === "role_general"),
			},
			{
				title: organization
					? `### 组织经验与记忆（company_private · ${organization.name}，同组织跨仓库共享）`
					: "### 组织/团队经验与记忆（company_private）",
				items: input.memories.filter((m) => m.scope === "company_private"),
			},
			{
				title: input.workspace
					? `### 当前仓库经验与记忆（project_private · ${input.workspace.name}）`
					: "### 当前仓库经验与记忆（project_private）",
				items: input.memories.filter((m) => m.scope === "project_private"),
			},
		];
		const memoryBlocks = groups
			.filter((group) => group.items.length > 0)
			.map((group) => `${group.title}\n${group.items.map(formatMemoryLine).join("\n")}`)
			.join("\n\n");
		sections.push(`## 个人与组织积累经验（分作用域记忆）\n${memoryBlocks}`);
	}

	if (input.workspace) {
		sections.push(
			`## 目标工作区约束\n- 项目：${input.workspace.name}\n- 本地路径：${input.workspace.repoPath}\n- 默认分支：${input.workspace.defaultBranch}\n- 原则：仓库自身维护的信息，以目标工作区实际文件与 Git 状态为准。`,
		);
	}

	if (mode === "internal") {
		sections.push(
			"## 协作模式\n这是一次团队内部的角色委托协作。请从本职视角直接给出有依据的判断、风险与结论。结果返回委托者，由主要负责人整合和决定正式交付；你不直接向用户登记成果。",
		);
	} else if (mode === "observer") {
		sections.push(
			`## 旁听与主动发言规则\n你当前作为旁听同事列席主负责人与用户的实时讨论会议。\n- 仅当从你的本职专业视角发现关键技术/测试/业务风险、可行性冲突、重要前提遗漏，或能给出主负责人尚未覆盖的关键建议时，才直接面向用户发表简洁、有依据的补充。\n- 若主负责人已妥当回应、当前属于普通澄清/闲聊或无实质增量，请仅输出 ${OBSERVER_SILENT_SENTINEL}（不要客套、附和、复述或解释原因）。\n- 只有主负责人保留正式交付归档权，你不得代为调用 publish_deliverable，也不自行发起二次团队委托。`,
		);
	}

	const isArchitect = isArchitectRoleTemplate(input.template ?? { id: input.member.id });
	sections.push(
		`## 当前团队\n${input.teamMembers.map((member) => `- ${member.id}: ${member.displayName}，${member.roleTitle}`).join("\n")}`,
	);
	if (input.extraGuidance) {
		sections.push(input.extraGuidance);
	}
	if (mode !== "observer" && !isArchitect) {
		const isSoloMatter = mode === "lead" && input.teamMembers.length <= 1;
		const collabLine = isSoloMatter
			? "本事项采用「单兵专办」配置（仅你 1 位 AI 成员参与，不进行跨岗位内部委托）。请直接在本职边界内核查事实、独立推进并给出完整结论；若判断诉求明显超出自身岗位职责或缺少必要角色，请直说原因与建议补充的角色方向。"
			: "你负责持续推进本轮任务。需要其他岗位的专业工作时调用 delegate_to_member，提供目标、必要事实与约束，并将同事的依据整合为用户需要的结论。内部过程不向用户逐条汇报。只有缺少信息或业务判断时询问用户。不要仅声称已咨询。";
		sections.push(
			`## 自主协作与真实成果\n${collabLine}` +
				"\n只有负责用户交流的主成员在形成可审阅的阶段成果、用户指定版本或实质变化时，才调用 publish_deliverable。提供完整文档、实际文件或服务链接，标题保持稳定以形成版本。成果表达遵循「简练、有重点、有过程」：changeNote 控制在 1–3 句讲清本版结论、核心改动与关键依据；document 正文先给核心结论与重点清单，再分节写清主体内容，最后用精简的「交付过程与验证依据」小结交代关键核查、数据结论与遗留边界（不贴整段原始日志）。普通回复、需求澄清、过程进度和细小讨论调整只保留对话，不按回复长度或轮数决定交付，也不逐次要求用户批准归档。登记后必须在本轮完成必要验证。\n若在执行、排障或用户纠偏过程中总结出明确可复用的**效率突破、问题排障定位法、岗位协同契约或项目硬规范**（不只是进度记录），可调用 propose_experience 附带合适 category 与 scope 记录为待验证候选经验。",
		);
	}
	if (mode === "lead" && !isArchitect) sections.push(PUBLICATION_REVIEW_GUIDANCE);
	if (mode === "lead" && !isArchitect)
		sections.push(
			"## 文档发布来源\n文档已经保存为工作区文件时，publish_deliverable 必须传 sourcePath，由宿主读取最终正文；不要再次传 content 改写另一份。只有没有落盘文件的文档才直接传 content。来源文件登记后如有修改，完成前须重新登记同标题的最终文件。",
		);
	if (input.taskPrompt) sections.push(`## 当前任务\n${input.taskPrompt}`);
	return sections.join("\n\n");
}
