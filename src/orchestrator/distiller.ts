import { resolve } from "node:path";
import type { PromptRunResult } from "../rpc/pi-rpc-worker.ts";
import { normalizeMemoryCategory, type PersonalAgentStore } from "../storage/repositories.ts";
import type { Matter, MemoryCategory, MemoryScope, TeamMember } from "../storage/types.ts";
import { selectMatterContext } from "./matter-context.ts";
import { applyWorkerModel, resolveConfiguredModel } from "./model-selection.ts";
import { parseSnapshotFromMetadata } from "./prompts.ts";
import {
	type DistillExperiencesInput,
	type DistillExperiencesResult,
	type ExperienceDraft,
	truncateInline,
	type WorkerFactory,
} from "./types.ts";

interface ParsedDistillationPayload {
	summary: string;
	candidates: Array<{
		memberId?: string;
		scope: MemoryScope;
		category: MemoryCategory;
		content: string;
		rationale: string;
		supersedesMemoryId?: string;
	}>;
}

export function parseDistillationPayload(rawText: string): ParsedDistillationPayload {
	const cleaned = rawText
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start === -1 || end <= start) {
		throw new Error("Distillation response did not contain a JSON object");
	}
	const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
	if (!parsed || typeof parsed !== "object") {
		throw new Error("Invalid distillation JSON payload");
	}
	const record = parsed as Record<string, unknown>;
	const summary = typeof record.summary === "string" ? record.summary.trim() : "";
	const rawCandidates = Array.isArray(record.candidates) ? record.candidates : [];
	const candidates: ParsedDistillationPayload["candidates"] = [];
	for (const item of rawCandidates.slice(0, 8)) {
		if (!item || typeof item !== "object") continue;
		const entry = item as Record<string, unknown>;
		const memberId = typeof entry.memberId === "string" && entry.memberId.trim() ? entry.memberId.trim() : undefined;
		const scope = entry.scope;
		const category = normalizeMemoryCategory(entry.category);
		const content = typeof entry.content === "string" ? entry.content.trim() : "";
		const rationale = typeof entry.rationale === "string" ? entry.rationale.trim() : "";
		const supersedesMemoryId =
			typeof entry.supersedesMemoryId === "string" && entry.supersedesMemoryId.trim()
				? entry.supersedesMemoryId.trim()
				: undefined;
		if ((scope === "role_general" || scope === "company_private" || scope === "project_private") && content) {
			candidates.push({
				memberId,
				scope,
				category,
				content: content.slice(0, 1200),
				rationale: rationale.slice(0, 1200),
				supersedesMemoryId,
			});
		}
	}
	return { summary, candidates };
}

export interface DistillerDeps {
	store: PersonalAgentStore;
	defaultCwd: string;
	workerFactory: WorkerFactory;
	requireMatter: (matterId: string) => Matter;
	routeMemberForRequest: (prompt: string, preferredMemberId?: string) => TeamMember;
}

export class DistillationMemberAccessError extends Error {
	constructor() {
		super("无权使用该角色提炼经验");
	}
}

/** Run isolated multi-role RSI experience reflection over a matter / deliverable / feedback. */
export async function performDistillationPass(
	deps: DistillerDeps,
	input: DistillExperiencesInput & { signal: AbortSignal },
): Promise<DistillExperiencesResult> {
	const matter = deps.requireMatter(input.matterId);
	const workspace = matter.workspaceId ? deps.store.getWorkspace(matter.workspaceId) : null;
	const cwd = resolve(workspace?.repoPath ?? deps.defaultCwd);
	const activeOrgId = workspace ? workspace.orgId : (matter.orgId ?? null);
	const scoped = selectMatterContext({
		orgId: activeOrgId,
		workspaceId: workspace?.id ?? null,
		repoPath: cwd,
		messages: deps.store.listMessages(matter.id),
		deliverables: deps.store.listDeliverables(matter.id),
	});
	const deliverable = input.deliverableId
		? (scoped.deliverables.find((item) => item.id === input.deliverableId) ?? null)
		: (scoped.deliverables[0] ?? null);
	if (input.deliverableId && !deliverable)
		throw new Error("Deliverable does not have provenance in the current workspace");
	const targetMemberId = input.memberId ?? deliverable?.memberId ?? matter.leadMemberId ?? undefined;
	const member = deps.routeMemberForRequest(matter.title, targetMemberId);
	const canReviewMember = input.canReviewMember ?? (() => true);
	if (!canReviewMember(member)) throw new DistillationMemberAccessError();
	const publicationIndex = input.deliverableId
		? scoped.messages.findIndex(
				(message) =>
					Array.isArray(message.metadata?.deliverableIds) &&
					message.metadata.deliverableIds.includes(input.deliverableId),
			)
		: -1;
	const evidence = publicationIndex >= 0 ? scoped.messages.slice(0, publicationIndex + 1) : scoped.messages;
	const allUserMessages = evidence.filter((message) => message.channel === "user");
	const allCollabMessages = evidence.filter((message) => message.channel === "internal_collab");
	const allNoticeMessages = evidence.filter((message) => message.channel === "notice");
	const singleOnly = input.scopeMode === "single" || (Boolean(input.memberId) && input.scopeMode !== "team");
	const participantIds = new Set<string>([member.id]);
	if (!singleOnly) {
		for (const msg of allUserMessages) {
			if (msg.senderType === "member") participantIds.add(msg.senderId);
		}
		for (const msg of allCollabMessages) {
			if (msg.senderType === "member") participantIds.add(msg.senderId);
			if (typeof msg.metadata?.toMemberId === "string" && msg.metadata.toMemberId) {
				participantIds.add(msg.metadata.toMemberId);
			}
		}
	}
	const participatingMembers = [...participantIds]
		.map((id) => deps.store.getMember(id))
		.filter((m): m is TeamMember => m !== null && canReviewMember(m));
	const participantSet = new Set(participatingMembers.map((m) => m.id));

	const existingMemoryLines: string[] = [];
	for (const pMember of participatingMembers) {
		const mems = deps.store.listRelevantMemories(pMember.id, workspace?.id ?? null, { orgId: activeOrgId });
		for (const mem of mems) {
			existingMemoryLines.push(
				`- [${mem.id} | ${pMember.id} (${pMember.displayName}) | ${mem.status} | ${mem.scope} | ${mem.category}] ${mem.content}`,
			);
		}
	}

	// Keep user inputs, observer interventions, failure snapshots, and latest replies within bounded budget.
	const selectedUserMessages =
		allUserMessages.length <= 18 ? allUserMessages : [...allUserMessages.slice(0, 6), ...allUserMessages.slice(-12)];
	const userTrajectory = selectedUserMessages
		.map((msg) => {
			const tag =
				msg.metadata?.observerIntervention === true
					? `${msg.senderId} (旁听补充)`
					: msg.metadata?.failed === true
						? "系统异常/中断"
						: msg.metadata?.aborted === true
							? `${msg.senderId} (已中止)`
							: `${msg.senderType}/${msg.senderId}`;
			const snap = parseSnapshotFromMetadata(msg.metadata);
			const snapNote = snap
				? ` [停于 ${snap.stage}/${snap.elapsedSeconds}s：${truncateInline(snap.label, 80)}${
						snap.recentLogs?.length
							? `；轨迹=${snap.recentLogs.map((l) => `${l.memberName}:${l.summary}`).join(" | ")}`
							: ""
					}]`
				: "";
			return `- ${tag}: ${truncateInline(msg.content, 420)}${snapNote}`;
		})
		.join("\n")
		.slice(0, 6500);

	const collabLines = allCollabMessages
		.slice(-24)
		.map((msg) => {
			const actor = deps.store.getMember(msg.senderId)?.displayName ?? msg.senderId;
			const failedFlag = msg.metadata?.failed === true ? "（未完成/失败）" : "";
			return `- [${msg.senderId}/${actor}]${failedFlag}: ${truncateInline(msg.content, 420)}`;
		})
		.join("\n")
		.slice(0, 6500);

	const failureNotices = allNoticeMessages
		.filter((entry) => {
			try {
				const parsed = JSON.parse(entry.content) as { method?: string; isError?: boolean };
				return parsed.method === "error" || parsed.isError === true;
			} catch {
				return false;
			}
		})
		.slice(-10)
		.map((entry) => `- ${entry.senderId}: ${truncateInline(entry.content, 240)}`)
		.join("\n");

	const feedbackText = (input.feedback ?? deliverable?.feedback ?? "").trim();
	const feedbackRating = input.rating ?? deliverable?.feedbackRating ?? null;
	const teamMode = participatingMembers.length > 1;
	const prompt = [
		teamMode
			? `你正在执行一次多岗位团队协作 RSI 经验复盘。请站在实际参与本事项的所有角色视角，从全流程中提炼真正有价值、可跨任务复用的方法论与规范。`
			: `你当前担任【${member.displayName} (${member.roleTitle})】，请对刚完成的工作与用户反馈执行一次简洁的 RSI 经验提炼反思。`,
		"",
		teamMode
			? `## 参与本次协作的岗位列表（请为每条经验填写最合适的归属 memberId）\n${participatingMembers
					.map((m) => `- \`${m.id}\`：${m.displayName}（${m.roleTitle}）`)
					.join("\n")}`
			: `## 目标岗位\n- \`${member.id}\`：${member.displayName}（${member.roleTitle}）`,
		"",
		"## 反思维度与原则",
		"1. 重点覆盖多维工作经验，不要只写表面“进度跟踪”流水账：",
		"   - `efficiency`（提效方法）：如何缩短耗时、前置轻量烟测、合理选择模型/方案、避免无效长跑或重复检查；",
		"   - `troubleshooting`（问题排障）：遇到报错、超时、数据异常或指标反常时，研发/测试/PM 是如何一步步定位根因并验证修复的；",
		"   - `collaboration`（高效协同）：主负责人与研发、测试、市场或旁听席之间的分工边界、交接输入要求、减少返工的配合方式；",
		"   - `user_correction`（用户纠偏）：用户中途叫停、修正口径或明确指出的禁忌；",
		"   - `domain_constraint`（项目规范）：当前仓库/产品的硬约束、架构前提与验收口径。",
		teamMode
			? `2. 归属精确：将研发排查/工程优化归入研发对应 \`memberId\`，将测试策略/回归经验归入测试对应 \`memberId\`，将需求收口/产品决策归入产品对应 \`memberId\`（可生成 0~6 条；若无明显新规律则返回空数组 []）。`
			: "2. 仅提炼确有依据、可复用的规律或约束（0~3 条）；若无新经验，candidates 返回空数组 []。",
		"3. 严格区分作用域 `scope`：",
		"   - `role_general`：跨组织/跨项目通用的岗位方法、分析清单或排障/协同习惯（不含某组织或某仓库私有路径、名称与密钥）。",
		workspace
			? [
					workspace.orgId
						? `   - \`company_private\`：绑定所属组织（\`${deps.store.getOrganization(workspace.orgId)?.name ?? workspace.orgId}\`）的跨仓库组织规范、共同流程或长期记忆；`
						: `   - \`company_private\`：绑定当前项目方/团队（${workspace.name}）的组织经验或流程约束；`,
					`   - \`project_private\`：绑定当前仓库「${workspace.name}」的具体业务规则、代码架构约束或验收口径。`,
				].join("\n")
			: matter.orgId
				? `   - \`company_private\`：绑定当前组织（\`${deps.store.getOrganization(matter.orgId)?.name ?? matter.orgId}\`）的组织规范与跨仓库记忆；未绑定仓库，请勿输出 \`project_private\`。`
				: "   - 当前事项未绑定项目工作区与组织，请仅输出 `role_general`。",
		"4. 若当前证据明确推翻或修正了下方同成员的已有经验，请填写 `supersedesMemoryId`。",
		"5. 仅返回严格 JSON（不要附加解释文字），格式：",
		`{"summary":"一句话说明复盘范围与提炼依据","candidates":[{"memberId":"${member.id}","category":"efficiency|troubleshooting|collaboration|user_correction|domain_constraint","scope":"role_general|company_private|project_private","content":"...","rationale":"...","supersedesMemoryId":"可选"}]}`,
		"",
		`## 当前事项\n- 编号：${matter.id}\n- 仓库：${workspace ? `${workspace.name} (${workspace.repoPath})` : "未绑定仓库"}`,
		deliverable
			? [
					"## 关联交付成果",
					`- 标题：${deliverable.title} (V${deliverable.version}, ${deliverable.type})`,
					deliverable.summary ? `- 变更摘要：${deliverable.summary}` : "",
					`- 内容摘录：${deliverable.contentOrPath.slice(0, 3000)}`,
				]
					.filter(Boolean)
					.join("\n")
			: "",
		feedbackText || feedbackRating
			? `## 用户验收反馈\n- 评价：${feedbackRating ?? "未评级"}\n- 意见：${feedbackText || "（无文字意见）"}`
			: "",
		existingMemoryLines.length > 0
			? `## 参与岗位当前已存在经验（供去重或推翻修正）\n${existingMemoryLines.join("\n")}`
			: "## 当前已存在经验\n（暂无）",
		userTrajectory ? `## 主对话、用户纠偏与中断快照轨迹\n${userTrajectory}` : "",
		collabLines ? `## 团队内部委托与排障协作记录\n${collabLines}` : "",
		failureNotices ? `## 执行过程中捕捉到的报错/异常工具调用\n${failureNotices}` : "",
	]
		.filter(Boolean)
		.join("\n\n");

	const selection = resolveConfiguredModel(deps.store, activeOrgId, member.id);
	const worker = deps.workerFactory({
		cwd,
		provider: selection?.provider,
		model: selection?.model,
		noSession: true,
		args: ["--no-approve", "--no-extensions", "--no-skills", "--no-mcp", "--no-context-files", "--tools", ""],
	});
	const onAbortWorker = () => {
		void worker.abort?.().catch(() => {});
		void worker.stop().catch(() => {});
	};
	input.signal.addEventListener("abort", onAbortWorker, { once: true });

	let result: PromptRunResult;
	try {
		await worker.start();
		if (selection) await applyWorkerModel(worker, selection);
		if (input.signal.aborted) {
			throw new Error("Experience distillation was aborted");
		}
		result = await worker.runPromptAndWait(prompt, {
			timeoutMs: input.timeoutMs ?? 120_000,
			signal: input.signal,
		});
	} finally {
		input.signal.removeEventListener("abort", onAbortWorker);
		await worker.stop().catch(() => {});
	}
	if (result.aborted || input.signal.aborted) {
		throw new Error("Experience distillation was aborted");
	}
	const currentMatter = deps.requireMatter(matter.id);
	const currentWorkspace = workspace ? deps.store.getWorkspace(workspace.id) : null;
	if ((workspace ? currentWorkspace?.orgId : currentMatter.orgId) !== activeOrgId)
		throw new Error("Organization changed during experience distillation");
	if (
		currentMatter.workspaceId !== matter.workspaceId ||
		(workspace && deps.store.getWorkspace(workspace.id)?.repoPath !== workspace.repoPath)
	)
		throw new Error("Workspace changed during experience distillation");
	input.signal?.throwIfAborted();
	const payload = parseDistillationPayload(result.assistantText);
	const candidates: ExperienceDraft[] = [];
	let skippedDuplicates = 0;

	for (const candidate of payload.candidates) {
		if (candidate.scope === "project_private" && !workspace) continue;
		if (candidate.scope === "company_private" && !workspace && !activeOrgId) continue;
		if (candidate.memberId && !participantSet.has(candidate.memberId)) continue;
		const resolvedMember = singleOnly ? member : deps.store.getMember(candidate.memberId ?? member.id)!;
		const orgId = candidate.scope === "company_private" ? activeOrgId : null;
		const targetWorkspaceId = candidate.scope === "role_general" ? null : orgId ? null : (workspace?.id ?? null);
		const dup = deps.store.findActiveDuplicateMemory(
			resolvedMember.id,
			candidate.scope,
			targetWorkspaceId,
			candidate.content,
			orgId,
		);
		if (dup) {
			skippedDuplicates += 1;
			continue;
		}
		let validSupersedes: string | null = null;
		if (candidate.supersedesMemoryId) {
			const oldMem = deps.store.getMemory(candidate.supersedesMemoryId);
			if (
				oldMem &&
				oldMem.memberId === resolvedMember.id &&
				oldMem.scope === candidate.scope &&
				oldMem.orgId === orgId &&
				oldMem.workspaceId === targetWorkspaceId
			) {
				validSupersedes = oldMem.id;
			}
		}
		candidates.push({
			memberId: resolvedMember.id,
			scope: candidate.scope,
			category: candidate.category,
			orgId,
			workspaceId: targetWorkspaceId,
			content: candidate.content,
			rationale: candidate.rationale || payload.summary,
			sourceMatterId: matter.id,
			sourceDeliverableId: deliverable?.id ?? null,
			status: "candidate",
			verified: false,
			supersedesMemoryId: validSupersedes,
		});
	}

	const saved = deps.store.recordTurnOutcome({ deliverables: [], candidates, applicationIds: [] });
	const createdMemories = saved.memories;
	skippedDuplicates += saved.skippedDuplicates;

	deps.store.appendMessage({
		matterId: matter.id,
		channel: "notice",
		senderType: "system",
		senderId: member.id,
		content: JSON.stringify({
			method: "rsi_distilled",
			deliverableId: deliverable?.id ?? null,
			createdCount: createdMemories.length,
			skippedDuplicates,
			participatingMemberIds: participatingMembers.map((m) => m.id),
			summary: payload.summary,
			memoryIds: createdMemories.map((m) => m.id),
		}),
	});

	return {
		matter,
		member,
		deliverable,
		createdMemories,
		skippedDuplicates,
		summary: payload.summary,
		participatingMemberIds: participatingMembers.map((m) => m.id),
	};
}
