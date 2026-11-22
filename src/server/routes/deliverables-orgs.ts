import type { FeedbackRating, WorkspaceVisibility } from "../../storage/types.ts";
import {
	canAccessDeliverable,
	canAccessMatter,
	canAccessOrganization,
	canAccessSpace,
	canAccessWorkspace,
	canActorAccessMemory,
	canActorUseMember,
	canManageOrganization,
	canParticipateInMatter,
	isGlobalUnscopedActor,
	requireOrgAdmin,
	validateLocalWorkspaceBindingPath,
} from "../acl.ts";
import { isSuperAdminActor, requireActiveActor, requireOwner, requireSuperAdmin } from "../auth.ts";
import { cloneGitWorkspaceIntoOrgRoot, resolveOrgWorkspacesDir } from "../git-clone.ts";
import { readJsonBody, responseCancellation, sendError, sendJson } from "../http.ts";
import {
	auditActorAction,
	broadcastMemoryUpdates,
	formatWorkspaceForActor,
	type RouteRequest,
	type ServerRouteContext,
} from "./context.ts";

function workspaceHasActiveTurn(ctx: ServerRouteContext, workspaceId: string): boolean {
	return ctx.store
		.listMatters()
		.some((matter) => matter.workspaceId === workspaceId && ctx.orchestrator.isMatterRunning(matter.id));
}

function parseUserIdList(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((s) => s.trim());
}

/** Handle deliverables feedback, self-serve organizations, cloned/local workspaces, and preview services. */
export async function handleDeliverableOrgPreviewRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const { store, orchestrator, previewManager, broadcast } = ctx;
	const { req, res, method, pathname, actor } = r;

	if (method === "GET" && pathname === "/api/deliverables") {
		if (!requireActiveActor(res, actor)) return true;
		const url = new URL(req.url ?? pathname, "http://127.0.0.1");
		const orgFilter = url.searchParams.get("orgId")?.trim() ?? "";
		const workspaceFilter = url.searchParams.get("workspaceId")?.trim() ?? "";
		const visibilityFilter = url.searchParams.get("visibility")?.trim() ?? "";

		if (orgFilter && orgFilter !== "__none__") {
			if (!store.getOrganization(orgFilter)) {
				sendError(res, 404, `Organization not found: ${orgFilter}`);
				return true;
			}
			if (!canAccessOrganization(store, actor, orgFilter)) {
				sendError(res, 403, "无权访问该组织的交付成果");
				return true;
			}
		}
		if (workspaceFilter && workspaceFilter !== "__none__") {
			const targetWs = store.getWorkspace(workspaceFilter);
			if (!targetWs) {
				sendError(res, 404, `Workspace not found: ${workspaceFilter}`);
				return true;
			}
			if (!canAccessWorkspace(store, actor, targetWs)) {
				sendError(res, 403, "无权访问该项目仓库的交付成果");
				return true;
			}
		}
		if (visibilityFilter && visibilityFilter !== "org" && visibilityFilter !== "private") {
			sendError(res, 400, "visibility filter must be org or private");
			return true;
		}

		const mattersById = new Map(store.listMatters().map((m) => [m.id, m]));
		const workspacesById = new Map(store.listWorkspaces().map((w) => [w.id, w]));
		const deliverables = store.listDeliverables().filter((deliv) => {
			if (!canAccessDeliverable(store, actor, deliv)) return false;
			const matter = mattersById.get(deliv.matterId) ?? null;
			const ws = matter?.workspaceId ? (workspacesById.get(matter.workspaceId) ?? null) : null;
			const effectiveOrgId = matter?.orgId ?? ws?.orgId ?? null;
			if (orgFilter === "__none__" && effectiveOrgId !== null) return false;
			if (orgFilter && orgFilter !== "__none__" && effectiveOrgId !== orgFilter) return false;
			if (workspaceFilter === "__none__" && (matter?.workspaceId ?? null) !== null) return false;
			if (workspaceFilter && workspaceFilter !== "__none__" && (matter?.workspaceId ?? null) !== workspaceFilter) {
				return false;
			}
			const effectiveVis = matter?.visibility ?? "org";
			if (visibilityFilter && effectiveVis !== visibilityFilter) return false;
			return true;
		});
		sendJson(res, 200, { deliverables });
		return true;
	}

	const deliverableDetailMatch = pathname.match(/^\/api\/deliverables\/([^/]+)$/);
	if (method === "GET" && deliverableDetailMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const deliverableId = decodeURIComponent(deliverableDetailMatch[1]!);
		const existing = store.getDeliverable(deliverableId);
		if (!existing) {
			sendError(res, 404, `Deliverable not found: ${deliverableId}`);
			return true;
		}
		if (!canAccessDeliverable(store, actor, existing)) {
			sendError(res, 403, "无权访问该交付成果");
			return true;
		}
		sendJson(res, 200, { deliverable: existing });
		return true;
	}

	const feedbackMatch = pathname.match(/^\/api\/deliverables\/([^/]+)\/feedback$/);
	if (method === "POST" && feedbackMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const deliverableId = decodeURIComponent(feedbackMatch[1]!);
		const existing = store.getDeliverable(deliverableId);
		if (!existing) {
			sendError(res, 404, `Deliverable not found: ${deliverableId}`);
			return true;
		}
		const parentMatter = store.getMatter(existing.matterId);
		if (
			parentMatter
				? !canParticipateInMatter(store, actor, parentMatter)
				: !(isGlobalUnscopedActor(actor) || isSuperAdminActor(actor))
		) {
			sendError(res, 403, "无权评价该事项成果");
			return true;
		}
		const body = await readJsonBody(req);
		const canAutoDistill =
			isGlobalUnscopedActor(actor) ||
			isSuperAdminActor(actor) ||
			canManageOrganization(store, actor, parentMatter?.orgId);
		if (body.autoDistill === true && !canAutoDistill) {
			sendError(res, 403, "仅组织管理员或系统管理员可在评价后触发自动经验提炼");
			return true;
		}
		const rawFeedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
		const isPrivileged = isSuperAdminActor(actor) || canManageOrganization(store, actor, parentMatter?.orgId);
		const feedback =
			rawFeedback && !isPrivileged
				? `[${actor.collaborator.name} (${actor.collaborator.roleTitle})]: ${rawFeedback}`
				: rawFeedback;
		const rawRating = body.rating;
		const rating: FeedbackRating | undefined =
			rawRating === "positive" || rawRating === "negative" || rawRating === "neutral" ? rawRating : undefined;
		if (!feedback && !rating) {
			sendError(res, 400, "feedback or rating is required");
			return true;
		}
		const { deliverable: updatedDeliverable, evaluatedMemories } = store.recordDeliverableFeedback(
			deliverableId,
			feedback || existing.feedback || "",
			rating,
		);
		const evaluatedMemoryIds = evaluatedMemories
			.filter((memory) => canActorAccessMemory(store, actor, memory))
			.map((memory) => memory.id);
		broadcastMemoryUpdates(broadcast, evaluatedMemories);
		let distilledMemories: unknown[] = [];
		let distillationError: string | undefined;
		if (body.autoDistill === true) {
			const cancellation = responseCancellation(res);
			try {
				const distilled = await orchestrator.distillExperiences({
					matterId: existing.matterId,
					deliverableId: existing.id,
					feedback,
					rating: rating ?? null,
					scopeMode: body.scopeMode === "single" || body.scopeMode === "team" ? body.scopeMode : undefined,
					signal: cancellation.signal,
					canReviewMember: (member) => canActorUseMember(store, actor, member),
					canReadSpace: (spaceId) => canAccessSpace(store, actor, store.spaces.getSpace(spaceId)),
				});
				distilledMemories = distilled.createdMemories.filter((memory) =>
					canActorAccessMemory(store, actor, memory),
				);
				broadcastMemoryUpdates(broadcast, distilled.createdMemories);
			} catch (error) {
				distillationError = error instanceof Error ? error.message : String(error);
			} finally {
				cancellation.dispose();
			}
		}
		broadcast(
			"deliverable_updated",
			{
				deliverableId,
				matterId: existing.matterId,
				feedback: updatedDeliverable?.feedback ?? feedback,
				rating: updatedDeliverable?.feedbackRating ?? null,
			},
			{ matterId: existing.matterId },
		);
		sendJson(res, 200, {
			ok: true,
			deliverableId,
			feedback: updatedDeliverable?.feedback ?? feedback,
			rating: updatedDeliverable?.feedbackRating ?? null,
			evaluatedMemoryIds,
			distilledMemories,
			distillationError,
		});
		return true;
	}

	if (method === "GET" && pathname === "/api/organizations") {
		if (!requireActiveActor(res, actor)) return true;
		const orgs = store.listOrganizations().filter((org) => canAccessOrganization(store, actor, org.id));
		sendJson(res, 200, { organizations: orgs });
		return true;
	}

	if (method === "POST" && pathname === "/api/organizations") {
		if (!requireActiveActor(res, actor)) return true;
		if (actor.authKind === "legacy_token" && actor.collaborator.permissionRole !== "owner") {
			sendError(res, 403, "仅所有者或正式注册用户可创建组织");
			return true;
		}
		const body = await readJsonBody(req);
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!name) {
			sendError(res, 400, "name is required");
			return true;
		}
		if (actor.authKind === "session" && actor.user && !isSuperAdminActor(actor)) {
			const owned = store.countOwnedOrganizations(actor.user.id);
			if (owned >= actor.user.maxOrgs) {
				sendError(res, 403, `当前账号最多可创建 ${actor.user.maxOrgs} 个组织，如需扩容请联系超级管理员`);
				return true;
			}
		}
		const settings = store.getPlatformSettings(ctx.defaultWorkspacesRoot);
		const isDefaultFlag =
			isSuperAdminActor(actor) && typeof body.isDefault === "boolean" ? body.isDefault : undefined;
		const organization = store.upsertOrganization({
			id: typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined,
			name,
			gitEmailDomain: typeof body.gitEmailDomain === "string" ? body.gitEmailDomain : "",
			useRoleGitIdentity: typeof body.useRoleGitIdentity === "boolean" ? body.useRoleGitIdentity : false,
			description: typeof body.description === "string" ? body.description : "",
			isDefault: isDefaultFlag,
			createdByUserId: actor.user?.id ?? null,
		});
		const workspacesDir = resolveOrgWorkspacesDir(settings.workspacesRoot, organization);
		const orgWithDir = store.upsertOrganization({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			gitEmailDomain: organization.gitEmailDomain,
			useRoleGitIdentity: organization.useRoleGitIdentity,
			description: organization.description,
			isDefault: organization.isDefault,
			workspacesDir,
		});
		if (actor.user) {
			store.upsertOrgMember({
				orgId: orgWithDir.id,
				userId: actor.user.id,
				orgRole: "org_owner",
				roleTitle: "组织所有者",
			});
		}
		if (Array.isArray(body.aiMemberIds)) {
			const enabledSet = new Set(parseUserIdList(body.aiMemberIds));
			const allMembers = store
				.listMembers()
				.filter((m) => m.roleScope === "global" || (m.roleScope === "org" && m.ownerOrgId === orgWithDir.id));
			const primaryId =
				typeof body.primaryAiMemberId === "string" && enabledSet.has(body.primaryAiMemberId)
					? body.primaryAiMemberId
					: null;
			const configs = allMembers.map((m) => ({
				memberId: m.id,
				enabled: enabledSet.has(m.id),
				isPrimaryContact: primaryId ? m.id === primaryId : Boolean(m.isPrimaryContact && enabledSet.has(m.id)),
			}));
			if (configs.some((c) => c.enabled)) {
				store.setOrgAiRolesBatch(orgWithDir.id, configs);
			}
		}
		auditActorAction(ctx, req, actor, {
			action: "org.create",
			targetType: "organization",
			targetId: orgWithDir.id,
			orgId: orgWithDir.id,
			detail: { name: orgWithDir.name },
		});
		broadcast("organization_updated", { organization: orgWithDir }, { orgId: orgWithDir.id });
		sendJson(res, 201, { organization: orgWithDir });
		return true;
	}

	const orgDefaultMatch = pathname.match(/^\/api\/organizations\/([^/]+)\/default$/);
	if (method === "POST" && orgDefaultMatch) {
		if (!requireOwner(res, actor)) return true;
		const orgId = decodeURIComponent(orgDefaultMatch[1]!);
		if (!store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		const organization = store.setDefaultOrganization(orgId);
		broadcast("organization_updated", { organization }, { orgId: organization.id });
		sendJson(res, 200, { organization });
		return true;
	}

	const orgPatchMatch = pathname.match(/^\/api\/organizations\/([^/]+)$/);
	if (method === "PATCH" && orgPatchMatch) {
		const orgId = decodeURIComponent(orgPatchMatch[1]!);
		if (!store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		if (!requireOrgAdmin(res, store, actor, orgId)) return true;
		const body = await readJsonBody(req);
		const isDefaultUpdate =
			typeof body.isDefault === "boolean" && isSuperAdminActor(actor) ? body.isDefault : undefined;
		const organization = store.updateOrganization(orgId, {
			name: typeof body.name === "string" ? body.name : undefined,
			gitEmailDomain: typeof body.gitEmailDomain === "string" ? body.gitEmailDomain : undefined,
			useRoleGitIdentity: typeof body.useRoleGitIdentity === "boolean" ? body.useRoleGitIdentity : undefined,
			description: typeof body.description === "string" ? body.description : undefined,
			isDefault: isDefaultUpdate,
		});
		auditActorAction(ctx, req, actor, {
			action: "org.update",
			targetType: "organization",
			targetId: orgId,
			orgId,
		});
		broadcast("organization_updated", { organization }, { orgId });
		sendJson(res, 200, { organization });
		return true;
	}

	if (method === "POST" && pathname === "/api/workspaces") {
		if (!requireActiveActor(res, actor)) return true;
		if (actor.authKind === "legacy_token" && actor.collaborator.permissionRole !== "owner") {
			sendError(res, 403, "仅所有者或组织管理员可登记项目仓库");
			return true;
		}
		const body = await readJsonBody(req);
		const name = typeof body.name === "string" ? body.name.trim() : "";
		const rawCloneUrl = typeof body.cloneUrl === "string" ? body.cloneUrl.trim() : "";
		const rawRepoPath = typeof body.repoPath === "string" ? body.repoPath.trim() : "";
		const requestedSourceType =
			body.sourceType === "clone" || body.sourceType === "cloned" || rawCloneUrl ? "clone" : "local";
		if (!name) {
			sendError(res, 400, "项目名称不能为空");
			return true;
		}
		if (requestedSourceType === "local" && !rawRepoPath) {
			sendError(res, 400, "name and repoPath are required");
			return true;
		}
		let orgId: string | null | undefined =
			body.orgId === null
				? null
				: typeof body.orgId === "string" && body.orgId.trim()
					? body.orgId.trim()
					: undefined;
		if (orgId && !store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		if (orgId === undefined) {
			if (actor.authKind === "session" && actor.user && !isSuperAdminActor(actor)) {
				const userOrgs = store.listUserOrganizations(actor.user.id);
				orgId = userOrgs.find((o) => o.orgRole === "org_owner" || o.orgRole === "org_admin")?.id ?? null;
			} else {
				const fallbackOrg = store.getDefaultOrganization() ?? store.ensureDefaultOrganization();
				orgId = fallbackOrg.id;
			}
		}
		if (orgId === null) {
			if (!isSuperAdminActor(actor)) {
				sendError(res, 403, "非超级管理员必须将项目绑定到有管理权限的组织");
				return true;
			}
		} else if (!canManageOrganization(store, actor, orgId)) {
			sendError(res, 403, "仅组织所有者或管理员可在该组织内登记或克隆项目");
			return true;
		}

		const settings = store.getPlatformSettings(ctx.defaultWorkspacesRoot);
		const targetOrg = orgId ? store.getOrganization(orgId) : null;
		const visibility: WorkspaceVisibility = body.visibility === "restricted" ? "restricted" : "org";
		const allowedUserIds = parseUserIdList(body.allowedUserIds);
		if (visibility === "restricted" && actor.user && !allowedUserIds.includes(actor.user.id)) {
			allowedUserIds.push(actor.user.id);
		}

		let resolvedRepoPath = rawRepoPath;
		let defaultBranch =
			typeof body.defaultBranch === "string" && body.defaultBranch.trim() ? body.defaultBranch.trim() : "main";
		let sourceType: "local" | "cloned" = "local";
		let cloneUrl: string | null = null;

		if (requestedSourceType === "clone") {
			if (!targetOrg) {
				sendError(res, 400, "从 Git 地址克隆仓库前必须选定目标组织");
				return true;
			}
			const cloned = await cloneGitWorkspaceIntoOrgRoot({
				workspacesRoot: settings.workspacesRoot,
				org: targetOrg,
				name,
				cloneUrl: rawCloneUrl,
				branch: typeof body.defaultBranch === "string" ? body.defaultBranch : undefined,
			});
			resolvedRepoPath = cloned.repoPath;
			defaultBranch = cloned.detectedBranch;
			sourceType = "cloned";
			cloneUrl = rawCloneUrl;
		} else {
			if (!isGlobalUnscopedActor(actor)) {
				try {
					resolvedRepoPath = validateLocalWorkspaceBindingPath({
						rawPath: rawRepoPath,
						settings,
						actor,
						dataDir: ctx.dataDir,
					});
				} catch (err) {
					sendError(res, 403, err instanceof Error ? err.message : String(err));
					return true;
				}
			}
		}

		const existingWorkspace = store.listWorkspaces().find((ws) => ws.repoPath === resolvedRepoPath);
		if (existingWorkspace) {
			if (!canManageOrganization(store, actor, existingWorkspace.orgId) && !isSuperAdminActor(actor)) {
				sendError(res, 403, "无权覆盖已登记的项目仓库");
				return true;
			}
			if (existingWorkspace.orgId !== orgId && workspaceHasActiveTurn(ctx, existingWorkspace.id)) {
				sendError(res, 409, "Stop active workspace turns before changing its organization");
				return true;
			}
		}
		const savedWs = store.upsertWorkspace({
			orgId,
			name,
			repoPath: resolvedRepoPath,
			defaultBranch,
			description: typeof body.description === "string" ? body.description : "",
			sourceType,
			cloneUrl,
			visibility,
			allowedUserIds,
		});
		const ws = formatWorkspaceForActor(store, savedWs, actor);
		auditActorAction(ctx, req, actor, {
			action: sourceType === "cloned" ? "workspace.clone" : "workspace.create_local",
			targetType: "workspace",
			targetId: ws.id,
			orgId: ws.orgId,
			detail: { name: ws.name, sourceType, visibility },
		});
		broadcast("workspace_updated", { id: ws.id, orgId: ws.orgId }, { workspaceId: ws.id });
		sendJson(res, 201, { workspace: ws });
		return true;
	}

	const wsPatchMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
	if (method === "PATCH" && wsPatchMatch) {
		const workspaceId = decodeURIComponent(wsPatchMatch[1]!);
		const body = await readJsonBody(req);
		const existingWs = store.getWorkspace(workspaceId);
		if (!existingWs) {
			sendError(res, 404, `Workspace not found: ${workspaceId}`);
			return true;
		}
		if (!requireOrgAdmin(res, store, actor, existingWs.orgId)) return true;
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
		if (orgId === null && !isSuperAdminActor(actor)) {
			sendError(res, 403, "非超级管理员不能将项目设为无组织状态");
			return true;
		}
		if (orgId !== undefined && orgId !== null && !canManageOrganization(store, actor, orgId)) {
			sendError(res, 403, "无权把项目移入未管理的组织");
			return true;
		}
		if (orgId !== undefined && orgId !== existingWs.orgId && workspaceHasActiveTurn(ctx, workspaceId)) {
			sendError(res, 409, "Stop active workspace turns before changing its organization");
			return true;
		}
		const nextVisibility: WorkspaceVisibility | undefined =
			body.visibility === "restricted" ? "restricted" : body.visibility === "org" ? "org" : undefined;
		const updated = store.updateWorkspace(workspaceId, {
			orgId,
			name: typeof body.name === "string" ? body.name : undefined,
			defaultBranch: typeof body.defaultBranch === "string" ? body.defaultBranch : undefined,
			description: typeof body.description === "string" ? body.description : undefined,
			visibility: nextVisibility,
			allowedUserIds: Array.isArray(body.allowedUserIds) ? parseUserIdList(body.allowedUserIds) : undefined,
		});
		const ws = formatWorkspaceForActor(store, updated, actor);
		auditActorAction(ctx, req, actor, {
			action: "workspace.update",
			targetType: "workspace",
			targetId: ws.id,
			orgId: ws.orgId,
			detail: { visibility: ws.visibility ?? "org" },
		});
		broadcast("workspace_updated", { id: ws.id, orgId: ws.orgId }, { workspaceId: ws.id });
		sendJson(res, 200, { workspace: ws });
		return true;
	}

	if (method === "GET" && pathname === "/api/previews") {
		if (!requireActiveActor(res, actor)) return true;
		const isAdmin = isSuperAdminActor(actor);
		const previews = previewManager.listPreviews().filter((preview) => {
			if (!preview.deliverableId) return isAdmin;
			const deliv = store.getDeliverable(preview.deliverableId);
			const matter = deliv ? store.getMatter(deliv.matterId) : null;
			return matter ? canAccessMatter(store, actor, matter) : isAdmin;
		});
		sendJson(res, 200, { previews });
		return true;
	}

	if (method === "POST" && pathname === "/api/previews") {
		if (!requireActiveActor(res, actor)) return true;
		const body = await readJsonBody(req);
		const title = typeof body.title === "string" ? body.title.trim() : "独立预览服务";
		const deliverableId = typeof body.deliverableId === "string" ? body.deliverableId : null;

		if (typeof body.url === "string" && body.url.trim().length > 0) {
			if (!isSuperAdminActor(actor)) {
				const deliv = deliverableId ? store.getDeliverable(deliverableId) : null;
				const matter = deliv ? store.getMatter(deliv.matterId) : null;
				if (!matter || !canManageOrganization(store, actor, matter.orgId)) {
					sendError(res, 403, "仅所有者（Owner）或对应组织管理员可登记预览链接");
					return true;
				}
			}
			const info = previewManager.registerExternalPreview({
				title,
				url: body.url.trim(),
				deliverableId,
			});
			broadcast("preview_updated", info);
			sendJson(res, 201, { preview: info });
			return true;
		}

		if (!requireSuperAdmin(res, actor)) return true;
		const command = typeof body.command === "string" ? body.command.trim() : "";
		if (!command) {
			sendError(res, 400, "command or url is required");
			return true;
		}
		const args = Array.isArray(body.args) ? body.args.map(String) : [];
		const cwd = typeof body.cwd === "string" && body.cwd.length > 0 ? body.cwd : process.cwd();
		const port = typeof body.port === "number" ? body.port : undefined;

		const info = await previewManager.startCommandPreview({
			title,
			command,
			args,
			cwd,
			port,
			deliverableId,
		});
		auditActorAction(ctx, req, actor, {
			action: "preview.start_command",
			targetType: "preview",
			targetId: info.id,
			detail: { title, command },
		});
		broadcast("preview_updated", info);
		sendJson(res, 201, { preview: info });
		return true;
	}

	const previewStopMatch = pathname.match(/^\/api\/previews\/([^/]+)\/stop$/);
	if (method === "POST" && previewStopMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const previewId = decodeURIComponent(previewStopMatch[1]!);
		const existingPreview = previewManager.listPreviews().find((item) => item.id === previewId);
		if (!existingPreview) {
			sendError(res, 404, `Preview not found: ${previewId}`);
			return true;
		}
		if (!(isGlobalUnscopedActor(actor) || isSuperAdminActor(actor))) {
			const linkedDeliv = existingPreview.deliverableId ? store.getDeliverable(existingPreview.deliverableId) : null;
			const linkedMatter = linkedDeliv ? store.getMatter(linkedDeliv.matterId) : null;
			if (
				!linkedMatter ||
				!canAccessMatter(store, actor, linkedMatter) ||
				!canManageOrganization(store, actor, linkedMatter.orgId)
			) {
				sendError(res, 403, "仅所有者或对应组织管理员可停止该预览服务");
				return true;
			}
		}
		const info = await previewManager.stopPreview(previewId);
		if (!info) {
			sendError(res, 404, `Preview not found: ${previewId}`);
			return true;
		}
		broadcast("preview_updated", info);
		sendJson(res, 200, { preview: info });
		return true;
	}

	return false;
}
