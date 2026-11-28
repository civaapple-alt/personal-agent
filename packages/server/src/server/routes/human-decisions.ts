import { resolve } from "node:path";
import type { Hono } from "hono";
import {
	type DecisionRespondent,
	isCurrentHumanDecision,
	listCompletedHumanDecisions,
	readHumanDecision,
} from "../../orchestrator/human-decision.ts";
import {
	canAccessMatter,
	canDispatchAiInOrg,
	canManageOrganization,
	canParticipateInMatter,
	canTargetMatterAi,
} from "../acl.ts";
import { isSuperAdminActor, requireActiveActor, toDispatchAuthor } from "../auth.ts";
import { HttpRequestError } from "../http.ts";
import { type ApiRouterEnv, parseJsonBody } from "../router.ts";
import { auditActorAction } from "./context.ts";
import { checkUserDispatchQuota, hasUserDispatchQuotaAvailable, settleMatterObserverPass } from "./matter-messages.ts";
import { ensureOrgEnabledAiRequest } from "./matter-roster.ts";

/** Register routes for human decision responses, reassignments, and resumptions. */
export function registerHumanDecisionRoutes(app: Hono<ApiRouterEnv>): void {
	app.post("/api/matters/:matterId/messages/:messageId/human-decision", async (c) => {
		const ctx = c.var.routeCtx;
		const { store } = ctx;
		const req = c.var.nodeReq!;
		const res = c.var.nodeRes!;
		const actor = c.var.actor;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const body = await parseJsonBody(c);
		const matterId = c.req.param("matterId");
		const messageId = c.req.param("messageId");
		const matter = store.getMatter(matterId);
		if (!matter || !canAccessMatter(store, actor, matter)) {
			throw new HttpRequestError(404, "事项不存在或无权查看");
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
			throw new HttpRequestError(404, "找不到这条待决定记录");
		}
		const messages = store.listMessages(matter.id, "user");
		const sourceIndex = messages.findIndex(({ id }) => id === messageId);
		const boundWorkspace = matter.workspaceId ? store.getWorkspace(matter.workspaceId) : null;
		const current =
			message.metadata?.repoPath === resolve(boundWorkspace?.repoPath ?? ctx.orchestrator.getDefaultCwd()) &&
			isCurrentHumanDecision(message, decision, matter, messages.slice(sourceIndex + 1));
		if (!current || body.revision !== decision.revision) {
			throw new HttpRequestError(409, "此决定已有更新，请刷新后处理");
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
				throw new HttpRequestError(403, "请选择可以参与此事项的用户");
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
				throw new HttpRequestError(409, "该决定已处理");
			}
			auditActorAction(ctx, req, actor, {
				action: "matter.decision.assign",
				targetType: "message",
				targetId: messageId,
				orgId: matter.orgId,
				detail: { assignedUserId: assignee.id, revision: decision.revision + 1 },
			});
			publishUpdate(updated);
			return c.json({ message: updated, resumed: false });
		}

		if (body.action !== "answer" && body.action !== "resume") {
			throw new HttpRequestError(400, "无效的决定操作");
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
					prompt: `对决定「${questions}」的答复（${answeredBy.name}）：\n${answer}${handoff}`,
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
				throw new HttpRequestError(403, "你没有续跑这项工作的权限");
			}
			if (decision.status !== "answered") {
				throw new HttpRequestError(409, "请先提交答案");
			}
			const resumed = await tryResume(decision.answer, decision.answeredBy, true);
			if (resumed === null) return c.body(null);
			return c.json({ message, resumed });
		}
		if (!canAnswer) {
			throw new HttpRequestError(403, "请由卡片上指定的答复人提交");
		}
		const answer = typeof body.answer === "string" ? body.answer.trim() : "";
		if (!answer || answer.length > 4000) {
			throw new HttpRequestError(400, "请输入 1–4000 字的答案");
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
			throw new HttpRequestError(409, "该决定已有人答复，已保留先提交的答案");
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
		if (resumed === null) return c.body(null);
		return c.json({ message: updated, resumed });
	});
}
