import type { MetaArchitectMessage } from "../../orchestrator/meta-architect.ts";
import { PiDecisionError } from "../../orchestrator/pi-decision.ts";
import { assessRoleCapabilities, validateSkillReference } from "../../roles/capabilities.ts";
import {
	buildRoleDesignDraft,
	normalizeRoleVerificationPlan,
	type RoleInteractionStyle,
	type RoleWorkspaceScope,
} from "../../roles/role-architect.ts";
import {
	canAccessOrganization,
	canAccessWorkspace,
	canActorUseMember,
	canManageOrganization,
	isViewerInAllOrgsOrTarget,
	resolveActorAccessibleOrgIds,
} from "../acl.ts";
import { isSuperAdminActor, requireActiveActor } from "../auth.ts";
import { HttpRequestError, readJsonBody, responseCancellation, sendError, sendJson } from "../http.ts";
import type { RouteRequest, ServerRouteContext } from "./context.ts";

import { resolveMemberTargetScope } from "./role-packages.ts";

/** Run role design and architect chats. */
export async function handleRoleDesignRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const { store, orchestrator } = ctx;
	const { req, res, method, pathname, actor } = r;

	if (method === "POST" && pathname === "/api/members/architect/chat") {
		if (!requireActiveActor(res, actor)) return true;
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
		const workspace = workspaceId ? store.getWorkspace(workspaceId) : null;
		if (workspaceId && !workspace) {
			sendError(res, 404, `Workspace not found: ${workspaceId}`);
			return true;
		}
		if (workspace && !canAccessWorkspace(store, actor, workspace)) {
			sendError(res, 403, "无权访问所选项目仓库");
			return true;
		}
		const explicitOrgId = typeof body.orgId === "string" && body.orgId.trim().length > 0 ? body.orgId.trim() : null;
		if (explicitOrgId && !store.getOrganization(explicitOrgId)) {
			sendError(res, 404, `Organization not found: ${explicitOrgId}`);
			return true;
		}
		const effectiveOrgId = explicitOrgId ?? workspace?.orgId ?? null;
		if (effectiveOrgId && !canAccessOrganization(store, actor, effectiveOrgId)) {
			sendError(res, 403, "无权访问所选组织");
			return true;
		}
		if (
			(actor.authKind === "legacy_token" && actor.collaborator.permissionRole !== "owner") ||
			isViewerInAllOrgsOrTarget(store, actor, effectiveOrgId)
		) {
			sendError(res, 403, "只读成员或访客口令不支持调用角色架构师");
			return true;
		}
		const targetScope = resolveMemberTargetScope(ctx, actor, body, effectiveOrgId);
		const canRunOrgHealthcheck =
			isSuperAdminActor(actor) ||
			(effectiveOrgId
				? canManageOrganization(store, actor, effectiveOrgId)
				: Boolean(
						actor.user &&
							store
								.listUserOrganizations(actor.user.id)
								.some((org) => org.orgRole === "org_owner" || org.orgRole === "org_admin"),
					));
		const cancellation = responseCancellation(res);
		try {
			const result = await orchestrator.chatWithRoleArchitect({
				messages,
				matterPrompt: typeof body.matterPrompt === "string" ? body.matterPrompt.trim() || undefined : undefined,
				workspaceId,
				orgId: targetScope.ownerOrgId ?? effectiveOrgId,
				targetRoleScope: targetScope.roleScope,
				actorUserId: actor.user?.id ?? null,
				allowedOrgIds: resolveActorAccessibleOrgIds(store, actor),
				isSuperAdmin: isSuperAdminActor(actor),
				includeHealthcheck: body.includeHealthcheck === true && canRunOrgHealthcheck,
				signal: cancellation.signal,
			});
			if (res.destroyed || cancellation.signal.aborted) return true;
			sendJson(res, 200, result);
		} finally {
			cancellation.dispose();
		}
		return true;
	}

	if (method === "POST" && pathname === "/api/members/design") {
		if (!requireActiveActor(res, actor)) return true;
		const body = await readJsonBody(req);
		const targetScope = resolveMemberTargetScope(ctx, actor, body);
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
		const skills = Array.isArray(body.skills)
			? body.skills.filter((value): value is string => typeof value === "string")
			: [];
		for (const s of skills) {
			try {
				validateSkillReference(s);
			} catch (error) {
				throw new HttpRequestError(400, error instanceof Error ? error.message : String(error));
			}
		}
		const visibleExistingIds = store
			.listMembers()
			.filter((m) => canActorUseMember(store, actor, m))
			.map((m) => m.id);
		const mode = body.mode === "model" || body.useModel === true ? "model" : "rules";
		const designInput = {
			oneJob,
			roleId: typeof body.roleId === "string" ? body.roleId : undefined,
			roleScope: targetScope.roleScope,
			ownerOrgId: targetScope.ownerOrgId,
			ownerUserId: targetScope.ownerUserId,
			antiJobs,
			quietWhen: typeof body.quietWhen === "string" ? body.quietWhen : undefined,
			interactionStyle,
			workspaceScope,
			roleName: typeof body.roleName === "string" ? body.roleName : undefined,
			roleTitle: typeof body.roleTitle === "string" ? body.roleTitle : undefined,
			keywords,
			workflowRules: typeof body.workflowRules === "string" ? body.workflowRules : undefined,
			constraints: typeof body.constraints === "string" ? body.constraints : undefined,
			skills,
			mcpDependencies: Array.isArray(body.mcpDependencies)
				? body.mcpDependencies.filter((value): value is string => typeof value === "string")
				: [],
			communicationStyle: typeof body.communicationStyle === "string" ? body.communicationStyle : undefined,
			verificationPlan: normalizeRoleVerificationPlan(body.verificationPlan),
			isPrimaryContact: targetScope.roleScope === "global" && body.isPrimaryContact === true,
			existingMemberIds: visibleExistingIds,
		};
		if (mode === "model") {
			const cancellation = responseCancellation(res);
			try {
				const draft = await orchestrator.designRoleWithModel({
					...designInput,
					allowedOrgIds: resolveActorAccessibleOrgIds(store, actor),
					signal: cancellation.signal,
				});
				if (res.destroyed || cancellation.signal.aborted) return true;
				sendJson(res, 200, draft);
			} catch (err) {
				if (res.destroyed || cancellation.signal.aborted) return true;
				if (err instanceof PiDecisionError) {
					sendError(res, err.kind === "aborted" ? 499 : 502, err.message);
					return true;
				}
				sendError(res, 502, err instanceof Error ? err.message : String(err));
			} finally {
				cancellation.dispose();
			}
			return true;
		}
		const draft = buildRoleDesignDraft(designInput);
		sendJson(res, 200, {
			...draft,
			designSource: "rules",
			capabilityReport: await assessRoleCapabilities(draft.template, { skillsDir: ctx.skillsDir }),
		});
		return true;
	}

	return false;
}
