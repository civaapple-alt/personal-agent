import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MetaArchitectMessage } from "../../orchestrator/meta-architect.ts";
import {
	applyRoleTemplatePatch,
	buildRoleDesignDraft,
	normalizeRoleTools,
	type RoleInteractionStyle,
	type RoleTemplatePatch,
	type RoleWorkspaceScope,
} from "../../roles/role-architect.ts";
import { parseRoleTemplateMarkdown, serializeRoleTemplateMarkdown } from "../../roles/template-loader.ts";
import type { RoleTemplate } from "../../roles/types.ts";
import type { ThinkingLevel } from "../../rpc/types.ts";
import { normalizeMemoryCategory } from "../../storage/repositories.ts";
import type { FeedbackRating, MemoryCategory, MemoryScope, MemoryStatus, TeamMember } from "../../storage/types.ts";
import { requireOwner } from "../auth.ts";
import { HttpRequestError, readJsonBody, responseCancellation, sendError, sendJson } from "../http.ts";
import {
	broadcastDistilledMemories,
	MEMORY_CATEGORIES,
	type RouteRequest,
	type ServerRouteContext,
} from "./context.ts";

async function materializeMemberFromBody(ctx: ServerRouteContext, body: Record<string, unknown>): Promise<TeamMember> {
	const { store, orchestrator, rolesDir } = ctx;
	const name = typeof body.name === "string" ? body.name.trim() : "";
	const title = typeof body.title === "string" ? body.title.trim() : "";
	if (!name || !title) {
		throw new HttpRequestError(400, "name and title are required");
	}
	const responsibilities =
		typeof body.responsibilities === "string" && body.responsibilities.trim().length > 0
			? body.responsibilities.trim()
			: `- 承担 ${name} 的核心岗位职责与交付产出。`;
	const existingIds = new Set(store.listMembers().map((m) => m.id));
	let rawId =
		typeof body.id === "string" && body.id.trim().length > 0
			? body.id.trim()
			: title
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-|-$/g, "") || `role-${Date.now()}`;
	if (!body.id && existingIds.has(rawId)) {
		let idx = 2;
		while (existingIds.has(`${rawId}-${idx}`)) idx += 1;
		rawId = `${rawId}-${idx}`;
	}
	const keywords = Array.isArray(body.keywords)
		? body.keywords.map(String).filter(Boolean)
		: typeof body.keywords === "string"
			? body.keywords
					.split(/[,，\s]+/)
					.map((s) => s.trim())
					.filter(Boolean)
			: [];
	const skills = Array.isArray(body.skills) ? body.skills.map(String).filter(Boolean) : [];
	const tools = normalizeRoleTools(Array.isArray(body.tools) ? body.tools.map(String) : undefined);
	const antiJobs = Array.isArray(body.antiJobs) ? body.antiJobs.map(String).filter(Boolean) : [];
	const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "kimi-for-coding";
	const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : "kimi-coding";
	const thinkingLevel = (typeof body.thinkingLevel === "string" ? body.thinkingLevel : "high") as ThinkingLevel;
	const isPrimaryContact = body.isPrimaryContact === true;
	const customSections =
		body.sections && typeof body.sections === "object" ? (body.sections as Record<string, unknown>) : {};
	const skillsAndMethods =
		typeof customSections.skillsAndMethods === "string" && customSections.skillsAndMethods.trim()
			? customSections.skillsAndMethods.trim()
			: "- 围绕明确问题开展调研或核查，交付可验证的结果。";
	const toolsAndEnvironment =
		typeof customSections.toolsAndEnvironment === "string" && customSections.toolsAndEnvironment.trim()
			? customSections.toolsAndEnvironment.trim()
			: tools.length === 0
				? "- 纯分析与文稿协同，不挂载文件编辑与终端工具。"
				: `- 使用已声明的最小必要工具（${tools.join(", ")}）。`;
	const collaborationConventions =
		typeof customSections.collaborationConventions === "string" && customSections.collaborationConventions.trim()
			? customSections.collaborationConventions.trim()
			: "- 平时静默推进，关键节点请用户确认，内部协作留痕。";
	const deliveryAndVerification =
		typeof customSections.deliveryAndVerification === "string" && customSections.deliveryAndVerification.trim()
			? customSections.deliveryAndVerification.trim()
			: "- 产出结构化说明或可执行验证结果。";

	const rawBody = [
		"## 职责与边界",
		responsibilities,
		"",
		"## 技能与工作方法",
		skillsAndMethods,
		"",
		"## 工具与环境依赖",
		toolsAndEnvironment,
		"",
		"## 协作和沟通约定",
		collaborationConventions,
		"",
		"## 交付与验证方式",
		deliveryAndVerification,
	].join("\n");

	const template: RoleTemplate = {
		id: rawId,
		name,
		title,
		version: "1.0.0",
		shareable: true,
		defaultProvider: provider,
		defaultModel: model,
		thinkingLevel,
		isPrimaryContact,
		keywords,
		tools,
		skills,
		mcpDependencies: [],
		...(antiJobs.length > 0 ? { antiJobs } : {}),
		sections: {
			responsibilitiesAndBoundaries: responsibilities,
			skillsAndMethods,
			toolsAndEnvironment,
			collaborationConventions,
			deliveryAndVerification,
		},
		rawBody,
	};

	if (rolesDir) {
		await mkdir(rolesDir, { recursive: true });
		await writeFile(join(rolesDir, `${rawId}.md`), serializeRoleTemplateMarkdown(template), "utf8");
	}

	const registered = orchestrator.registerRoleTemplate(template);
	return typeof body.gitName === "string" ||
		typeof body.gitEmail === "string" ||
		typeof body.identitySummary === "string"
		? store.updateMemberIdentity(registered.id, {
				gitName: typeof body.gitName === "string" ? body.gitName : undefined,
				gitEmail: typeof body.gitEmail === "string" ? body.gitEmail : undefined,
				identitySummary: typeof body.identitySummary === "string" ? body.identitySummary : undefined,
			})
		: registered;
}

/** Handle AI team members, role architect Meta-Bot, role template import/export, memories, and RSI distillation. */
export async function handleTeamMemoryRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const { store, orchestrator, rolesDir, broadcast } = ctx;
	const { req, res, method, pathname, actor } = r;

	if (method === "POST" && pathname === "/api/members/architect/chat") {
		if (!requireOwner(res, actor)) return true;
		const body = await readJsonBody(req);
		const rawMessages = Array.isArray(body.messages) ? body.messages : [];
		const messages: MetaArchitectMessage[] = rawMessages
			.map((item) => {
				if (!item || typeof item !== "object") return null;
				const rec = item as Record<string, unknown>;
				const role = rec.role === "assistant" ? "assistant" : rec.role === "user" ? "user" : null;
				const content = typeof rec.content === "string" ? rec.content.trim() : "";
				return role && content ? { role, content } : null;
			})
			.filter((m): m is MetaArchitectMessage => m !== null);
		if (messages.length === 0) {
			sendError(res, 400, "messages array with at least one message is required");
			return true;
		}
		const workspaceId =
			typeof body.workspaceId === "string" && body.workspaceId.trim().length > 0 ? body.workspaceId.trim() : null;
		if (workspaceId && !store.getWorkspace(workspaceId)) {
			sendError(res, 404, `Workspace not found: ${workspaceId}`);
			return true;
		}
		const cancellation = responseCancellation(res);
		try {
			const result = await orchestrator.chatWithRoleArchitect({
				messages,
				matterPrompt: typeof body.matterPrompt === "string" ? body.matterPrompt.trim() || undefined : undefined,
				workspaceId,
				includeHealthcheck: body.includeHealthcheck === true,
				signal: cancellation.signal,
			});
			if (res.destroyed || cancellation.signal.aborted) return true;
			sendJson(res, 200, result);
		} finally {
			cancellation.dispose();
		}
		return true;
	}

	if (method === "POST" && pathname === "/api/members/batch") {
		if (!requireOwner(res, actor)) return true;
		const body = await readJsonBody(req);
		const rawList = Array.isArray(body.members) ? body.members : [];
		if (rawList.length === 0 || rawList.length > 8) {
			sendError(res, 400, "members must be an array of 1 to 8 role payloads");
			return true;
		}
		const payloads: Record<string, unknown>[] = [];
		for (const item of rawList) {
			if (!item || typeof item !== "object" || Array.isArray(item)) {
				sendError(res, 400, "Each item in members must be an object");
				return true;
			}
			const rec = item as Record<string, unknown>;
			const name = typeof rec.name === "string" ? rec.name.trim() : "";
			const title = typeof rec.title === "string" ? rec.title.trim() : "";
			if (!name || !title) {
				sendError(res, 400, "Each member requires non-empty name and title");
				return true;
			}
			payloads.push(rec);
		}
		const created: TeamMember[] = [];
		for (const payload of payloads) {
			created.push(await materializeMemberFromBody(ctx, payload));
		}
		broadcast("team_updated", { memberIds: created.map((m) => m.id) });
		sendJson(res, 201, { members: created });
		return true;
	}

	if (method === "POST" && pathname === "/api/members/adjustments/apply") {
		if (!requireOwner(res, actor)) return true;
		const body = await readJsonBody(req);
		const rawList = Array.isArray(body.adjustments) ? body.adjustments : [];
		if (rawList.length === 0 || rawList.length > 8) {
			sendError(res, 400, "adjustments must be an array of 1 to 8 role updates");
			return true;
		}
		const planned: Array<{ prev: RoleTemplate; next: RoleTemplate }> = [];
		for (const item of rawList) {
			if (!item || typeof item !== "object" || Array.isArray(item)) {
				sendError(res, 400, "Each item in adjustments must be an object");
				return true;
			}
			const rec = item as Record<string, unknown>;
			const memberId = typeof rec.memberId === "string" ? rec.memberId.trim() : "";
			const member = memberId ? store.getMember(memberId) : null;
			if (!member) {
				sendError(res, memberId ? 404 : 400, memberId ? `Member not found: ${memberId}` : "memberId is required");
				return true;
			}
			const prev = orchestrator.getTemplateForMember(member);
			if (!prev) {
				sendError(res, 404, `Role template not found for member: ${memberId}`);
				return true;
			}
			const patch: RoleTemplatePatch = {
				...(Array.isArray(rec.tools) ? { tools: rec.tools.map(String) } : {}),
				...(Array.isArray(rec.addAntiJobs) ? { addAntiJobs: rec.addAntiJobs.map(String).filter(Boolean) } : {}),
				...(typeof rec.workflowNote === "string" && rec.workflowNote.trim()
					? { workflowNote: rec.workflowNote.trim() }
					: {}),
			};
			if (
				patch.tools === undefined &&
				(!patch.addAntiJobs || patch.addAntiJobs.length === 0) &&
				!patch.workflowNote
			) {
				sendError(res, 400, `Adjustment for ${memberId} has no changes to apply`);
				return true;
			}
			planned.push({ prev, next: applyRoleTemplatePatch(prev, patch) });
		}
		const updatedMembers: TeamMember[] = [];
		for (const { next } of planned) {
			if (rolesDir) {
				await mkdir(rolesDir, { recursive: true });
				await writeFile(join(rolesDir, `${next.id}.md`), serializeRoleTemplateMarkdown(next), "utf8");
			}
			updatedMembers.push(orchestrator.registerRoleTemplate(next));
		}
		broadcast("team_updated", { memberIds: updatedMembers.map((m) => m.id) });
		sendJson(res, 200, { members: updatedMembers });
		return true;
	}

	if (method === "POST" && pathname === "/api/members/design") {
		if (!requireOwner(res, actor)) return true;
		const body = await readJsonBody(req);
		const oneJob = typeof body.oneJob === "string" ? body.oneJob.trim() : "";
		if (!oneJob) {
			sendError(res, 400, "oneJob is required");
			return true;
		}
		const antiJobs = Array.isArray(body.antiJobs)
			? body.antiJobs.map(String).filter(Boolean)
			: typeof body.antiJobs === "string"
				? body.antiJobs
						.split(/[\n;；]+/)
						.map((s) => s.trim())
						.filter(Boolean)
				: undefined;
		const keywords = Array.isArray(body.keywords) ? body.keywords.map(String).filter(Boolean) : undefined;
		const interactionStyle =
			body.interactionStyle === "lead_direct" ||
			body.interactionStyle === "consult_specialist" ||
			body.interactionStyle === "risk_observer" ||
			body.interactionStyle === "mixed"
				? (body.interactionStyle as RoleInteractionStyle)
				: undefined;
		const workspaceScope =
			body.workspaceScope === "read_write_code" ||
			body.workspaceScope === "read_only_repo" ||
			body.workspaceScope === "no_repo_docs"
				? (body.workspaceScope as RoleWorkspaceScope)
				: undefined;
		const draft = buildRoleDesignDraft({
			oneJob,
			antiJobs,
			quietWhen: typeof body.quietWhen === "string" ? body.quietWhen : undefined,
			interactionStyle,
			workspaceScope,
			roleName: typeof body.roleName === "string" ? body.roleName : undefined,
			roleTitle: typeof body.roleTitle === "string" ? body.roleTitle : undefined,
			keywords,
			workflowRules: typeof body.workflowRules === "string" ? body.workflowRules : undefined,
			constraints: typeof body.constraints === "string" ? body.constraints : undefined,
			isPrimaryContact: body.isPrimaryContact === true,
			existingMemberIds: store.listMembers().map((m) => m.id),
		});
		sendJson(res, 200, draft);
		return true;
	}

	if (method === "POST" && pathname === "/api/members") {
		if (!requireOwner(res, actor)) return true;
		const body = await readJsonBody(req);
		const member = await materializeMemberFromBody(ctx, body);
		broadcast("team_updated", { memberId: member.id });
		sendJson(res, 201, { member });
		return true;
	}

	const memberPatchMatch = pathname.match(/^\/api\/members\/([^/]+)$/);
	if (method === "PATCH" && memberPatchMatch) {
		if (!requireOwner(res, actor)) return true;
		const memberId = decodeURIComponent(memberPatchMatch[1]!);
		if (!store.getMember(memberId)) {
			sendError(res, 404, `Member not found: ${memberId}`);
			return true;
		}
		const body = await readJsonBody(req);
		const member = store.updateMemberIdentity(memberId, {
			displayName: typeof body.displayName === "string" ? body.displayName : undefined,
			roleTitle: typeof body.roleTitle === "string" ? body.roleTitle : undefined,
			gitName: typeof body.gitName === "string" ? body.gitName : undefined,
			gitEmail: typeof body.gitEmail === "string" ? body.gitEmail : undefined,
			identitySummary: typeof body.identitySummary === "string" ? body.identitySummary : undefined,
		});
		broadcast("team_updated", { memberId: member.id });
		sendJson(res, 200, { member });
		return true;
	}

	const memberPrimaryMatch = pathname.match(/^\/api\/members\/([^/]+)\/primary$/);
	if (method === "POST" && memberPrimaryMatch) {
		if (!requireOwner(res, actor)) return true;
		const memberId = decodeURIComponent(memberPrimaryMatch[1]!);
		const member = store.setPrimaryContact(memberId);
		broadcast("team_updated", { memberId: member.id });
		sendJson(res, 200, { member });
		return true;
	}

	const memberExportMatch = pathname.match(/^\/api\/members\/([^/]+)\/export$/);
	if (method === "GET" && memberExportMatch) {
		const memberId = decodeURIComponent(memberExportMatch[1]!);
		const member = store.getMember(memberId);
		if (!member) {
			sendError(res, 404, `Member not found: ${memberId}`);
			return true;
		}
		const template = orchestrator.getTemplateForMember(member);
		if (!template) {
			sendError(res, 404, `Role template not found for member: ${memberId}`);
			return true;
		}
		const markdown = serializeRoleTemplateMarkdown(template);
		sendJson(res, 200, { id: template.id, filename: `${template.id}.md`, markdown });
		return true;
	}

	if (method === "POST" && pathname === "/api/members/import") {
		if (!requireOwner(res, actor)) return true;
		const body = await readJsonBody(req);
		const markdown = typeof body.markdown === "string" ? body.markdown : "";
		if (!markdown.trim()) {
			sendError(res, 400, "markdown is required");
			return true;
		}
		const parsed = parseRoleTemplateMarkdown(markdown);
		if (rolesDir) {
			await mkdir(rolesDir, { recursive: true });
			await writeFile(join(rolesDir, `${parsed.id}.md`), serializeRoleTemplateMarkdown(parsed), "utf8");
		}
		const member = orchestrator.registerRoleTemplate(parsed);
		broadcast("team_updated", { memberId: member.id });
		sendJson(res, 201, { member });
		return true;
	}

	if (method === "POST" && pathname === "/api/memories") {
		if (!requireOwner(res, actor)) return true;
		const body = await readJsonBody(req);
		const memberId = typeof body.memberId === "string" ? body.memberId.trim() : "";
		const content = typeof body.content === "string" ? body.content.trim() : "";
		const scope = (typeof body.scope === "string" ? body.scope : "role_general") as MemoryScope;
		if (!memberId || !content) {
			sendError(res, 400, "memberId and content are required");
			return true;
		}
		if (!store.getMember(memberId)) {
			sendError(res, 404, `Member not found: ${memberId}`);
			return true;
		}
		if (scope !== "role_general" && scope !== "company_private" && scope !== "project_private") {
			sendError(res, 400, `Unsupported memory scope: ${scope}`);
			return true;
		}
		const category =
			body.category === undefined
				? "general"
				: typeof body.category === "string" && MEMORY_CATEGORIES.has(body.category as MemoryCategory)
					? normalizeMemoryCategory(body.category)
					: null;
		if (!category) {
			sendError(res, 400, `Unsupported memory category: ${String(body.category)}`);
			return true;
		}
		const orgId =
			scope === "company_private" && typeof body.orgId === "string" && body.orgId.trim() ? body.orgId.trim() : null;
		if (orgId && !store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		const workspaceId =
			scope === "role_general" || orgId
				? null
				: typeof body.workspaceId === "string" && body.workspaceId
					? body.workspaceId
					: null;
		if (workspaceId && !store.getWorkspace(workspaceId)) {
			sendError(res, 404, `Workspace not found: ${workspaceId}`);
			return true;
		}
		const rawStatus = body.status;
		const status: MemoryStatus =
			rawStatus === "candidate" || rawStatus === "verified" || rawStatus === "rejected" || rawStatus === "superseded"
				? rawStatus
				: body.verified === false
					? "candidate"
					: "verified";
		const memory = store.addMemory({
			memberId,
			scope,
			category,
			orgId,
			workspaceId,
			content,
			rationale: typeof body.rationale === "string" ? body.rationale.trim() : "",
			sourceMatterId: typeof body.sourceMatterId === "string" && body.sourceMatterId ? body.sourceMatterId : null,
			sourceDeliverableId:
				typeof body.sourceDeliverableId === "string" && body.sourceDeliverableId ? body.sourceDeliverableId : null,
			status,
			verified: status === "verified",
			supersedesMemoryId:
				typeof body.supersedesMemoryId === "string" && body.supersedesMemoryId ? body.supersedesMemoryId : null,
		});
		broadcast("memory_updated", { memberId, memory });
		sendJson(res, 201, { memory });
		return true;
	}

	const memoryAppsMatch = pathname.match(/^\/api\/memories\/([^/]+)\/applications$/);
	if (method === "GET" && memoryAppsMatch) {
		const memoryId = decodeURIComponent(memoryAppsMatch[1]!);
		const memory = store.getMemory(memoryId);
		if (!memory) {
			sendError(res, 404, `Memory not found: ${memoryId}`);
			return true;
		}
		sendJson(res, 200, { memory, applications: store.listMemoryApplications(memoryId) });
		return true;
	}

	const memoryEvalMatch = pathname.match(/^\/api\/memories\/([^/]+)\/evaluate$/);
	if (method === "POST" && memoryEvalMatch) {
		if (!requireOwner(res, actor)) return true;
		const memoryId = decodeURIComponent(memoryEvalMatch[1]!);
		const existing = store.getMemory(memoryId);
		if (!existing) {
			sendError(res, 404, `Memory not found: ${memoryId}`);
			return true;
		}
		const body = await readJsonBody(req);
		if (body.outcome !== "positive" && body.outcome !== "negative") {
			sendError(res, 400, "outcome must be positive or negative");
			return true;
		}
		const memory = store.evaluateMemory({
			memoryId,
			outcome: body.outcome === "positive" ? "feedback_positive" : "feedback_negative",
			matterId: typeof body.matterId === "string" && body.matterId ? body.matterId : existing.sourceMatterId,
			memberId: existing.memberId,
			note: typeof body.note === "string" ? body.note.trim() : "",
		});
		broadcast("memory_updated", { memberId: memory.memberId, memory });
		sendJson(res, 200, { memory });
		return true;
	}

	const memoryPatchMatch = pathname.match(/^\/api\/memories\/([^/]+)$/);
	if (method === "PATCH" && memoryPatchMatch) {
		if (!requireOwner(res, actor)) return true;
		const memoryId = decodeURIComponent(memoryPatchMatch[1]!);
		const existing = store.getMemory(memoryId);
		if (!existing) {
			sendError(res, 404, `Memory not found: ${memoryId}`);
			return true;
		}
		const body = await readJsonBody(req);
		const memberId = typeof body.memberId === "string" && body.memberId.trim() ? body.memberId.trim() : undefined;
		if (memberId && !store.getMember(memberId)) {
			sendError(res, 404, `Member not found: ${memberId}`);
			return true;
		}
		const scope = typeof body.scope === "string" ? (body.scope as MemoryScope) : undefined;
		if (scope && scope !== "role_general" && scope !== "company_private" && scope !== "project_private") {
			sendError(res, 400, `Unsupported memory scope: ${scope}`);
			return true;
		}
		const category =
			body.category === undefined
				? undefined
				: typeof body.category === "string" && MEMORY_CATEGORIES.has(body.category as MemoryCategory)
					? (body.category as MemoryCategory)
					: null;
		if (category === null) {
			sendError(res, 400, `Unsupported memory category: ${String(body.category)}`);
			return true;
		}
		const orgId =
			body.orgId === null
				? null
				: typeof body.orgId === "string" && body.orgId.trim()
					? body.orgId.trim()
					: undefined;
		if (orgId && !store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		const workspaceId =
			body.workspaceId === null
				? null
				: typeof body.workspaceId === "string" && body.workspaceId
					? body.workspaceId
					: undefined;
		if (workspaceId && !store.getWorkspace(workspaceId)) {
			sendError(res, 404, `Workspace not found: ${workspaceId}`);
			return true;
		}
		const status = typeof body.status === "string" ? (body.status as MemoryStatus) : undefined;
		if (
			status &&
			status !== "candidate" &&
			status !== "verified" &&
			status !== "rejected" &&
			status !== "superseded"
		) {
			sendError(res, 400, `Unsupported memory status: ${status}`);
			return true;
		}
		const memory = store.updateMemory(memoryId, {
			memberId,
			content: typeof body.content === "string" ? body.content : undefined,
			scope,
			category,
			orgId,
			workspaceId,
			status,
			rationale: typeof body.rationale === "string" ? body.rationale : undefined,
			supersedesMemoryId:
				body.supersedesMemoryId === null
					? null
					: typeof body.supersedesMemoryId === "string"
						? body.supersedesMemoryId
						: undefined,
		});
		if (existing.memberId !== memory.memberId) {
			broadcast("memory_updated", { memberId: existing.memberId, memory });
		}
		broadcast("memory_updated", { memberId: memory.memberId, memory });
		sendJson(res, 200, { memory });
		return true;
	}

	if (method === "POST" && pathname === "/api/rsi/distill/abort") {
		if (!requireOwner(res, actor)) return true;
		const body = await readJsonBody(req);
		const matterId = typeof body.matterId === "string" ? body.matterId.trim() : "";
		if (!matterId) {
			sendError(res, 400, "matterId is required");
			return true;
		}
		const aborted = orchestrator.abortDistillation(matterId);
		sendJson(res, 200, { ok: true, aborted });
		return true;
	}

	if (method === "POST" && pathname === "/api/rsi/distill") {
		if (!requireOwner(res, actor)) return true;
		const body = await readJsonBody(req);
		const matterId = typeof body.matterId === "string" ? body.matterId.trim() : "";
		if (!matterId) {
			sendError(res, 400, "matterId is required");
			return true;
		}
		const deliverableId =
			typeof body.deliverableId === "string" && body.deliverableId.trim() ? body.deliverableId.trim() : undefined;
		const memberId = typeof body.memberId === "string" && body.memberId.trim() ? body.memberId.trim() : undefined;
		const feedback = typeof body.feedback === "string" && body.feedback.trim() ? body.feedback.trim() : undefined;
		const rating: FeedbackRating | undefined =
			body.rating === "positive" || body.rating === "negative" || body.rating === "neutral"
				? body.rating
				: undefined;
		const scopeMode = body.scopeMode === "single" || body.scopeMode === "team" ? body.scopeMode : undefined;
		const cancellation = responseCancellation(res);
		try {
			const result = await orchestrator.distillExperiences({
				matterId,
				deliverableId,
				memberId,
				feedback,
				rating,
				scopeMode,
				signal: cancellation.signal,
			});
			broadcastDistilledMemories(broadcast, result.member.id, result.createdMemories);
			sendJson(res, 200, { ok: true, ...result });
		} catch (err) {
			if (
				cancellation.signal.aborted ||
				(err instanceof Error && err.message === "Experience distillation was aborted")
			) {
				if (!res.writableEnded && !res.destroyed) {
					sendJson(res, 200, {
						ok: false,
						aborted: true,
						createdMemories: [],
						skippedDuplicates: 0,
						summary: "已取消 AI 经验复盘",
					});
				}
				return true;
			}
			throw err;
		} finally {
			cancellation.dispose();
		}
		return true;
	}

	return false;
}
