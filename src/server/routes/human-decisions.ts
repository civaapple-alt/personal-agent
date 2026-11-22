import { resolve } from "node:path";
import {
	type DecisionRespondent,
	isCurrentHumanDecision,
	listCompletedHumanDecisions,
	readHumanDecision,
} from "../../orchestrator/human-decision.ts";
import { messageMatchesContext } from "../../orchestrator/matter-context.ts";
import {
	canAccessMatter,
	canDispatchAiInOrg,
	canManageOrganization,
	canParticipateInMatter,
	canTargetMatterAi,
} from "../acl.ts";
import { isSuperAdminActor, requireActiveActor, toDispatchAuthor } from "../auth.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";
import { loadStoredFilesFromRefs, loadStoredImagesFromRefs } from "../uploads.ts";
import { auditActorAction, type RouteRequest, type ServerRouteContext } from "./context.ts";
import { checkUserDispatchQuota, hasUserDispatchQuotaAvailable, settleMatterObserverPass } from "./matter-messages.ts";
import { ensureOrgEnabledAiRequest } from "./matter-roster.ts";

export async function handleHumanDecisionRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const match = r.pathname.match(/^\/api\/matters\/([^/]+)\/messages\/([^/]+)\/human-decision$/);
	if (r.method !== "POST" || !match) return false;
	const { req, res, actor } = r;
	const { store } = ctx;
	if (!requireActiveActor(res, actor)) return true;
	const body = await readJsonBody(req);
	const matterId = decodeURIComponent(match[1]!);
	const messageId = decodeURIComponent(match[2]!);
	const matter = store.getMatter(matterId);
	if (!matter || !canAccessMatter(store, actor, matter)) {
		sendError(res, 404, "事项不存在或无权查看");
		return true;
	}
	const message = store.getMessage(messageId);
	const decision = readHumanDecision(message?.metadata);
	if (
		!decision ||
		!message ||
		message.matterId !== matter.id ||
		message.senderType !== "member" ||
		message.channel !== "user"
	) {
		sendError(res, 404, "找不到这条待决定记录");
		return true;
	}
	const messages = store.listMessages(matter.id, "user");
	const sourceIndex = messages.findIndex(({ id }) => id === messageId);
	const boundWorkspace = matter.workspaceId ? store.getWorkspace(matter.workspaceId) : null;
	const current =
		message.metadata?.repoPath === resolve(boundWorkspace?.repoPath ?? ctx.orchestrator.getDefaultCwd()) &&
		isCurrentHumanDecision(message, decision, matter, messages.slice(sourceIndex + 1));
	if (!current || body.revision !== decision.revision) {
		sendError(res, 409, "此决定已有更新，请刷新后处理");
		return true;
	}
	const userId = actor.user?.id ?? null;
	const isDecisionManager =
		isSuperAdminActor(actor) ||
		actor.authKind === "loopback" ||
		(matter.createdByUserId != null && userId === matter.createdByUserId) ||
		canManageOrganization(store, actor, matter.orgId);
	const canParticipate = canParticipateInMatter(store, actor, matter);
	const name = actor.user?.displayName ?? actor.collaborator.name;
	const publishUpdate = (updated: NonNullable<ReturnType<typeof store.getMessage>>) =>
		ctx.broadcast("matter_message", { matterId, message: updated, matter }, { matterId });

	if (body.action === "assign") {
		const assigneeId = typeof body.assignedUserId === "string" ? body.assignedUserId : "";
		const assignee = store.getUserById(assigneeId);
		if (
			!canParticipate ||
			!isDecisionManager ||
			!assignee ||
			(assignee.id !== matter.createdByUserId && !matter.collaboratorIds.includes(assignee.id)) ||
			!canParticipateInMatter(
				store,
				{ user: assignee, authKind: "session", viaToken: false, collaborator: actor.collaborator },
				matter,
			)
		) {
			sendError(res, 403, "请选择可以参与此事项的用户");
			return true;
		}
		const updated =
			decision.status === "pending" &&
			store.transitionHumanDecision(messageId, decision.revision, {
				...decision,
				assignedUserId: assignee.id,
				assignedName: assignee.displayName,
				revision: decision.revision + 1,
			});
		if (!updated) {
			sendError(res, 409, "该决定已处理");
			return true;
		}
		auditActorAction(ctx, req, actor, {
			action: "matter.decision.assign",
			targetType: "message",
			targetId: messageId,
			orgId: matter.orgId,
			detail: { assignedUserId: assignee.id, revision: decision.revision + 1 },
		});
		publishUpdate(updated);
		sendJson(res, 200, { message: updated, resumed: false });
		return true;
	}

	if (body.action !== "answer" && body.action !== "resume") {
		sendError(res, 400, "无效的决定操作");
		return true;
	}
	const canAnswer =
		canParticipate &&
		(decision.assignedUserId
			? userId === decision.assignedUserId &&
				(userId === matter.createdByUserId || matter.collaboratorIds.includes(userId) || isDecisionManager)
			: isDecisionManager);
	const canResume =
		canParticipate && (canAnswer || isDecisionManager) && canDispatchAiInOrg(store, actor, matter.orgId);
	const tryResume = async (answer: string, answeredBy: DecisionRespondent, explicit = false) => {
		const needsExecutionConfirmation = decision.kind === "execution_confirmation";
		const discussionOnly = needsExecutionConfirmation && answer === "先讨论";
		const keepMatterLead = Boolean(message.metadata?.conversationRouted);
		if (
			!canResume ||
			(keepMatterLead &&
				matter.aiMemberIds !== null &&
				!matter.aiMemberIds.includes(message.senderId) &&
				message.senderId !== matter.leadMemberId) ||
			listCompletedHumanDecisions(messages).has(messageId)
		) {
			return false;
		}
		if (explicit) {
			if (!ensureOrgEnabledAiRequest(res, ctx, actor, matter.orgId, message.senderId, [])) return null;
		} else if (!canTargetMatterAi(store, actor, matter.orgId, message.senderId)) return false;
		const questions = decision.requests.map(({ question }) => question).join("\n");
		const assignment = decision.source ? store.getMessage(decision.source.messageId) : null;
		const handoff =
			decision.source && assignment?.matterId === matterId && assignment.channel === "internal_collab"
				? `\n来源委托 #${decision.source.assignmentNumber}（${decision.source.memberId}）。若该委托仍需继续，请以确认结果补齐原任务后交回该协作者。\n原委托：${assignment.content.slice(0, 4000)}`
				: "";
		const sourceId = message.metadata?.sourceUserMessageId;
		const sourceMsg = needsExecutionConfirmation && typeof sourceId === "string" ? store.getMessage(sourceId) : null;
		if (
			needsExecutionConfirmation &&
			(!sourceMsg ||
				sourceMsg.matterId !== matterId ||
				sourceMsg.senderType !== "user" ||
				sourceMsg.metadata?.mode !== "conversation" ||
				!messageMatchesContext(sourceMsg, {
					orgId: matter.orgId ?? null,
					workspaceId: matter.workspaceId,
					repoPath: resolve(boundWorkspace?.repoPath ?? ctx.orchestrator.getDefaultCwd()),
				}))
		)
			return false;
		const images = sourceMsg
			? await loadStoredImagesFromRefs(sourceMsg.metadata?.images, ctx.uploadsDir, ctx.memoryUploads)
			: [];
		const files = sourceMsg
			? await loadStoredFilesFromRefs(sourceMsg.metadata?.files, ctx.uploadsDir, ctx.memoryUploads)
			: [];
		if (
			(Array.isArray(sourceMsg?.metadata?.images) && images.length !== sourceMsg.metadata.images.length) ||
			(Array.isArray(sourceMsg?.metadata?.files) && files.length !== sourceMsg.metadata.files.length)
		)
			return false;
		await settleMatterObserverPass(ctx, matterId);
		const latestMatter = store.getMatter(matterId);
		const currentActor = actor.user ? { ...actor, user: store.getUserById(actor.user.id) } : actor;
		if (
			!latestMatter ||
			latestMatter.orgId !== matter.orgId ||
			latestMatter.workspaceId !== matter.workspaceId ||
			(actor.user && !currentActor.user) ||
			!canParticipateInMatter(store, currentActor, latestMatter) ||
			!canDispatchAiInOrg(store, currentActor, latestMatter.orgId) ||
			!canTargetMatterAi(store, currentActor, latestMatter.orgId, message.senderId) ||
			(keepMatterLead &&
				latestMatter.aiMemberIds !== null &&
				!latestMatter.aiMemberIds.includes(message.senderId) &&
				message.senderId !== latestMatter.leadMemberId)
		)
			return false;
		if (
			ctx.activeRuns.has(matterId) ||
			ctx.orchestrator.isMatterRunning(matterId) ||
			listCompletedHumanDecisions(store.listMessages(matterId, "user")).has(messageId)
		)
			return false;
		if (explicit) {
			if (!checkUserDispatchQuota(ctx, currentActor, res)) return null;
		} else if (!hasUserDispatchQuotaAvailable(ctx, currentActor)) return false;

		ctx.runDispatchInBackground(
			{
				matterId,
				interactionMode: discussionOnly ? "discussion" : undefined,
				prompt: sourceMsg
					? `${discussionOnly ? "用户选择先讨论，请给出建议和可行方案。" : "用户已确认开始执行以下原始请求。"}\n${sourceMsg.content}`
					: `对决定「${questions}」的答复（${answeredBy.name}）：\n${answer}${handoff}`,
				images,
				files,
				keepMatterLead,
				preferredMemberId: message.senderId,
				workspaceId: matter.workspaceId ?? undefined,
				orgId: matter.orgId,
				decisionResponse: { sourceMessageId: messageId, text: answer, respondent: answeredBy },
				startedByUserId: userId,
				author: toDispatchAuthor(actor.collaborator),
			},
			actor,
		);
		return true;
	};

	if (body.action === "resume") {
		if (!canResume) {
			sendError(res, 403, "你没有续跑这项工作的权限");
			return true;
		}
		if (decision.status !== "answered") {
			sendError(res, 409, "请先提交答案");
			return true;
		}
		const resumed = await tryResume(decision.answer, decision.answeredBy, true);
		if (resumed !== null) sendJson(res, 200, { message, resumed });
		return true;
	}
	if (!canAnswer) {
		sendError(res, 403, "请由卡片上指定的答复人提交");
		return true;
	}
	const answer = typeof body.answer === "string" ? body.answer.trim() : "";
	if (decision.kind === "execution_confirmation" && answer !== "开始执行" && answer !== "先讨论") {
		sendError(res, 400, "请选择「开始执行」或「先讨论」");
		return true;
	}
	if (!answer || answer.length > 4000) {
		sendError(res, 400, "请输入 1–4000 字的答案");
		return true;
	}
	const answeredBy = { userId, name, at: new Date().toISOString() };
	const updated =
		decision.status === "pending" &&
		store.transitionHumanDecision(messageId, decision.revision, {
			...decision,
			status: "answered",
			answer,
			answeredBy,
		});
	if (!updated) {
		sendError(res, 409, "该决定已有人答复，已保留先提交的答案");
		return true;
	}
	auditActorAction(ctx, req, actor, {
		action: "matter.decision.answer",
		targetType: "message",
		targetId: messageId,
		orgId: matter.orgId,
		detail: { revision: decision.revision },
	});
	publishUpdate(updated);
	const resumed = await tryResume(answer, answeredBy);
	if (resumed !== null) sendJson(res, 200, { message: updated, resumed });
	return true;
}
