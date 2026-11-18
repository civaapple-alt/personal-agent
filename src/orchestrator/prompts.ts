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
	const lines: string[] = ["## Previous interruption and resume brief"];

	if (isFailed) {
		lines.push(
			`- Interruption reason: The run failed${errorDetail ? ` (${truncateInline(errorDetail, 120)})` : ""}${snapshot ? ` after ${snapshot.elapsedSeconds}s` : ""}.`,
		);
	} else {
		const reasonText = cancelReason === "shutdown" ? "Service shutdown or restart" : "Stopped by the user";
		lines.push(`- Interruption reason: ${reasonText}${snapshot ? ` after ${snapshot.elapsedSeconds}s` : ""}.`);
	}

	if (snapshot) {
		lines.push(`- Stage at interruption: ${snapshot.stage} (${truncateInline(snapshot.label, 96)})`);
		if (snapshot.activeDelegations && snapshot.activeDelegations.length > 0) {
			lines.push(
				`- Active delegations at interruption: ${snapshot.activeDelegations.map((entry) => `${entry.memberName} (${entry.stageLabel})`).join(", ")}`,
			);
		}
		if (snapshot.recentLogs && snapshot.recentLogs.length > 0) {
			lines.push("- Recent actions before interruption:");
			for (const entry of snapshot.recentLogs) {
				lines.push(`  - ${entry.memberName}: ${truncateInline(entry.summary, 96)}`);
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
		lines.push("- Delegations from the previous turn:");
		for (const req of turnDelegations.slice(-6)) {
			const toId = String(req.metadata?.toMemberId ?? "");
			const toName = input.store.getMember(toId)?.displayName ?? toId;
			const resp = responseByReqId.get(req.id);
			const statusLabel = resp
				? resp.metadata?.failed === true || resp.senderType === "system"
					? "Incomplete or interrupted"
					: "Completed"
				: "No result returned";
			const taskSnippet = truncateInline(req.content.replace(/^@[^:：]+[:：]\s*/, ""), 64);
			lines.push(`  - ${toName} [${statusLabel}]: ${taskSnippet}`);
		}
	}

	lines.push(
		"- Resume the unfinished work in the existing Pi sessions. First verify the interruption point and the current file and process state. Reuse completed work.",
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
				? "[Team discussion]"
				: message.metadata?.mode === "ai_request"
					? "[Teammate request]"
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
	const rawFiles = Array.isArray(message.metadata?.files) ? message.metadata.files : [];
	const trimmed = message.content.trim();
	const parts: string[] = [];
	if (trimmed) parts.push(trimmed);
	if (rawImages.length > 0) parts.push(`[Image attachments: ${rawImages.length}]`);
	if (rawFiles.length > 0) {
		const labels = rawFiles
			.map((entry) => {
				if (!entry || typeof entry !== "object") return null;
				const rec = entry as Record<string, unknown>;
				const name = typeof rec.name === "string" ? rec.name : "attachment";
				const lineCount = typeof rec.lineCount === "number" ? `${rec.lineCount} lines` : "";
				const preview =
					typeof rec.previewText === "string" && rec.previewText ? ` — ${rec.previewText.slice(0, 120)}` : "";
				return `${name}${lineCount ? ` (${lineCount})` : ""}${preview}`;
			})
			.filter((item): item is string => Boolean(item));
		if (labels.length > 0) parts.push(`[Attached files: ${labels.join("; ")}]`);
	}
	return parts.length > 0 ? parts.join("\n") : message.content;
}

export function buildObserverTaskPrompt(input: {
	leadMember: TeamMember;
	userPrompt: string;
	leadReply: string;
	imageCount?: number;
	fileSummaries?: string[];
}): string {
	const trimmedUser = input.userPrompt.trim();
	const fileCount = input.fileSummaries?.length ?? 0;
	const attachmentLines = [
		input.imageCount ? `[Image attachments: ${input.imageCount}]` : "",
		fileCount > 0 ? `[Attached files: ${input.fileSummaries!.join("; ")}]` : "",
	]
		.filter(Boolean)
		.join("\n");
	const userPart = trimmedUser
		? `${truncateInline(trimmedUser, 2000)}${attachmentLines ? `\n${attachmentLines}` : ""}`
		: attachmentLines || "[The user provided attachments without text.]";
	const leadPart = input.leadReply.trim().slice(0, 6000);
	return [
		"Review this turn from your area of expertise and decide whether to speak.",
		"",
		`[User message]\n${userPart}`,
		"",
		`[Latest reply from lead ${input.leadMember.displayName} (${input.leadMember.roleTitle})]\n${leadPart}`,
		"",
		`Address the user directly with a concise, specific comment if you find a material risk or omission or have a correction the user needs now. Otherwise, return only ${OBSERVER_SILENT_SENTINEL}.`,
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
		if (input.matter.title) parts.push(`Matter title: ${truncateInline(input.matter.title, 120)}`);
		if (input.matter.summary) parts.push(`Progress summary: ${truncateInline(input.matter.summary, 280)}`);
		if (input.deliverables.length > 0) {
			const latestByTitle = new Map<string, Deliverable>();
			for (const item of input.deliverables) {
				const prev = latestByTitle.get(item.title);
				if (!prev || item.version > prev.version) latestByTitle.set(item.title, item);
			}
			const list = [...latestByTitle.values()].map((d) => `${d.title} (V${d.version})`).join(", ");
			if (list) parts.push(`Archived deliverables: ${truncateInline(list, 240)}`);
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
		parts.push(`Recent conversation excerpts:\n${kept.join("\n")}`);
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
		`- Member: \`${input.member.id}\` (${input.member.displayName} · ${input.member.roleTitle})`,
		organization
			? `- Organization: ${organization.name}${organization.description ? ` (${organization.description})` : ""}`
			: null,
		`- Git author (role identity): ${gitIdentity.gitName} <${gitIdentity.gitEmail}>`,
		repoGitUser
			? `- Git committer (repository user): ${repoGitUser.name} <${repoGitUser.email}>. The environment sets GIT_AUTHOR_* and GIT_COMMITTER_* separately. Keep the global and repository Git configuration intact.`
			: `- Git author and committer: ${gitIdentity.gitName} <${gitIdentity.gitEmail}>. The environment sets GIT_AUTHOR_* and GIT_COMMITTER_*. Keep the global Git configuration intact.`,
		input.member.identitySummary ? `- Role background and expertise: ${input.member.identitySummary}` : null,
	].filter(Boolean);
	const sections: string[] = [
		`You are ${input.member.displayName} (${input.member.roleTitle}) on the Personal Agent team.`,
		"Use the language of the user's request for replies and deliverables unless the user asks for another language. If given a transcript, take the language from the human user's message. Preserve identifiers, commands, and file paths verbatim. Follow any required output format.",
		`## Role and organization identity\n${identityLines.join("\n")}`,
	];

	if (input.template) {
		if (input.template.sections.responsibilitiesAndBoundaries) {
			sections.push(`## Responsibilities and boundaries\n${input.template.sections.responsibilitiesAndBoundaries}`);
		}
		if (input.template.antiJobs && input.template.antiJobs.length > 0) {
			sections.push(`## Anti-Jobs\n${input.template.antiJobs.map((rule) => `- ${rule}`).join("\n")}`);
		}
		if (input.template.sections.skillsAndMethods) {
			sections.push(`## Skills and methods\n${input.template.sections.skillsAndMethods}`);
		}
		if (input.template.sections.toolsAndEnvironment) {
			sections.push(`## Tools and environment\n${input.template.sections.toolsAndEnvironment}`);
		}
		if (input.template.sections.collaborationConventions) {
			sections.push(`## Collaboration and communication\n${input.template.sections.collaborationConventions}`);
		}
		if (input.template.sections.deliveryAndVerification) {
			sections.push(`## Delivery and verification\n${input.template.sections.deliveryAndVerification}`);
		}
	}

	if (input.memories.length > 0) {
		const formatMemoryLine = (m: MemberMemory): string => {
			const tag = m.status === "verified" ? `verified · ${m.scope}` : `unverified · ${m.scope}`;
			const catPrefix =
				m.category && m.category !== "general"
					? `[${MEMORY_CATEGORY_PROMPT_LABELS[m.category] ?? m.category}] `
					: "";
			const suffix =
				m.status === "candidate"
					? " (Unverified. If current work shows this is incorrect or needs revision, use propose_experience to propose a replacement.)"
					: "";
			return `- [${m.id} | ${tag}] ${catPrefix}${m.content}${suffix}`;
		};
		const groups: Array<{ title: string; items: MemberMemory[] }> = [
			{
				title: "### Role-wide experience (role_general, shared across organizations and repositories)",
				items: input.memories.filter((m) => m.scope === "role_general"),
			},
			{
				title: organization
					? `### Organization experience (company_private · ${organization.name}, shared across its repositories)`
					: "### Organization or team experience (company_private)",
				items: input.memories.filter((m) => m.scope === "company_private"),
			},
			{
				title: input.workspace
					? `### Current repository experience (project_private · ${input.workspace.name})`
					: "### Current repository experience (project_private)",
				items: input.memories.filter((m) => m.scope === "project_private"),
			},
		];
		const memoryBlocks = groups
			.filter((group) => group.items.length > 0)
			.map((group) => `${group.title}\n${group.items.map(formatMemoryLine).join("\n")}`)
			.join("\n\n");
		sections.push(`## Scoped memories\n${memoryBlocks}`);
	}

	if (input.workspace) {
		sections.push(
			`## Target workspace\n- Project: ${input.workspace.name}\n- Local path: ${input.workspace.repoPath}\n- Default branch: ${input.workspace.defaultBranch}\n- Use the actual files and Git state in this workspace as the source of truth for the repository.`,
		);
	}

	if (mode === "internal") {
		sections.push(
			"## Internal delegation\nGive the requester evidence-backed findings, risks, and conclusions from your role. The lead integrates your findings and decides what to publish.",
		);
	} else if (mode === "observer") {
		sections.push(
			`## Observer participation\nYou are observing a discussion between the lead and the user.\n- Speak directly to the user only when you identify a material risk, feasibility conflict, missing prerequisite, or important recommendation the lead missed. Keep your comment concise and evidence-backed.\n- If the lead has addressed the issue, the turn is routine, or you have nothing material to add, return exactly ${OBSERVER_SILENT_SENTINEL}.\n- Leave formal publication and team delegation to the lead.`,
		);
	}

	const isArchitect = isArchitectRoleTemplate(input.template ?? { id: input.member.id });
	sections.push(
		`## Current team\n${input.teamMembers.map((member) => `- ${member.id}: ${member.displayName} (${member.roleTitle})`).join("\n")}`,
	);
	if (input.extraGuidance) {
		sections.push(input.extraGuidance);
	}
	if (mode !== "observer" && !isArchitect) {
		const isSoloMatter = mode === "lead" && input.teamMembers.length <= 1;
		const collabLine = isSoloMatter
			? "This is a solo matter. Verify the facts and complete the work within your role without internal delegation. If the request exceeds your remit or needs an unavailable role, explain the gap and suggest what expertise is needed."
			: "Advance the task within your role. When specialist work is needed, call delegate_to_member with the goal, relevant facts, and constraints. Integrate the specialist's evidence into the result. Keep routine coordination internal. Ask the user only when information or a business decision is missing.";
		sections.push(
			[
				"## Collaboration and publication",
				collabLine,
				"Only the lead can call publish_deliverable. Publish a reviewable milestone, a version requested by the user, or a material revision. Provide the complete document, actual file, or service URL. Keep the title stable across versions.",
				"Write a one- to three-sentence changeNote with the conclusion, key changes, and evidence. In a document, start with the key points, develop the body in sections, and end with a short account of the checks, results, and remaining limits. Leave full logs in the conversation or workspace.",
				"Keep routine replies, clarifications, progress, and minor adjustments in the conversation. Base publication on the significance of the work. Publication alone requires no extra approval. Complete the necessary verification in the same turn.",
				"Use propose_experience with the appropriate category and scope for a reusable efficiency improvement, troubleshooting method, collaboration agreement, or project rule. Treat the entry as an unverified candidate.",
			].join("\n"),
		);
	}
	if (mode === "lead" && !isArchitect) sections.push(PUBLICATION_REVIEW_GUIDANCE);
	if (mode === "lead" && !isArchitect)
		sections.push(
			"## Document publication source\nFor a document saved in the workspace, call publish_deliverable with sourcePath alone so the host can read the final text. Use content only for documents without a source file. If the source changes after registration, register the final file under the same title before finishing.",
		);
	if (input.taskPrompt) sections.push(`## Current task\n${input.taskPrompt}`);
	return sections.join("\n\n");
}
