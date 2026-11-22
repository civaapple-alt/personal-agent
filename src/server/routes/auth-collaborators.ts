import { buildRuntimeOverview } from "../../orchestrator/runtime-info.ts";
import { isThinkingLevel } from "../../rpc/model-selection.ts";
import { DEFAULT_OWNER_COLLABORATOR_ID, toPublicCollaborator, toPublicUser } from "../../storage/repositories.ts";
import type { CollaboratorRole, OrgMemberRole } from "../../storage/types.ts";
import {
	canAccessMatter,
	canAccessOrganization,
	canAccessWorkspace,
	canActorUseMember,
	canManageOrganization,
	getActorOrgRole,
	requireOrgAccess,
	requireOrgAdmin,
} from "../acl.ts";
import { isSuperAdminActor, requireActiveActor, requireOwner } from "../auth.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";
import {
	auditActorAction,
	formatScopedMemoryMap,
	formatWorkspaceForActor,
	type RouteRequest,
	type ServerRouteContext,
} from "./context.ts";
import { validateModelSelection } from "./model-settings.ts";

function parseOrgMemberRole(raw: unknown): OrgMemberRole | null {
	if (raw === "org_owner" || raw === "org_admin" || raw === "org_member" || raw === "org_viewer") {
		return raw;
	}
	return null;
}

/** Handle `/api/bootstrap`, `/api/runtime`, legacy `/api/collaborators*`, and per-org member/invite/AI-role routes. */
export async function handleBootstrapAndCollaboratorRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const { store, orchestrator, dialogBroker, previewManager, activeRuns, broadcast, revokeTokenSessions } = ctx;
	const { req, res, method, pathname, actor } = r;

	if (method === "GET" && pathname === "/api/bootstrap") {
		if (!requireActiveActor(res, actor)) return true;
		const liveTemplates = orchestrator.listTemplates();
		const settings = store.getPlatformSettings(ctx.defaultWorkspacesRoot);
		const allCollaborators = store.listCollaborators();
		const scopedOrgs = store
			.listOrganizations()
			.filter((org) => canAccessOrganization(store, actor, org.id))
			.map((org) => ({
				...org,
				orgRole: getActorOrgRole(store, actor, org.id) ?? "org_member",
			}));
		const scopedWorkspaces = store
			.listWorkspaces()
			.filter((ws) => canAccessWorkspace(store, actor, ws))
			.map((ws) => formatWorkspaceForActor(store, ws, actor));
		const scopedMatters = store.listMatters().filter((matter) => canAccessMatter(store, actor, matter));
		const allowedMatterIds = new Set(scopedMatters.map((m) => m.id));
		const scopedDeliverables = store.listDeliverables().filter((d) => allowedMatterIds.has(d.matterId));
		const scopedPendingDialogs = dialogBroker.listPending().filter((d) => allowedMatterIds.has(d.matterId));
		const scopedPreviews = previewManager
			.listPreviews()
			.filter((preview) => (preview.matterId ? allowedMatterIds.has(preview.matterId) : isSuperAdminActor(actor)));
		const scopedActiveRuns = Object.fromEntries(
			[...activeRuns.entries()]
				.filter(([matterId]) => allowedMatterIds.has(matterId))
				.map(([matterId, run]) => [matterId, { ...run.progress, matterId, startedAt: run.startedAt }]),
		);

		const orgMembersByOrgId: Record<string, ReturnType<typeof store.listOrgMembers>> = {};
		const orgAiRolesByOrgId: Record<
			string,
			{
				configured: boolean;
				configs: ReturnType<typeof store.listOrgAiRoleConfigs>;
				effectiveMemberIds: string[];
			}
		> = {};
		for (const org of scopedOrgs) {
			orgMembersByOrgId[org.id] = store.listOrgMembers(org.id);
			const configured = store.hasOrgAiRolesConfigured(org.id);
			const configs = store.listOrgAiRoleConfigs(org.id);
			const effectiveMembers = store.resolveEffectiveOrgMembers(org.id);
			orgAiRolesByOrgId[org.id] = {
				configured,
				configs,
				effectiveMemberIds: effectiveMembers.map((m) => m.id),
			};
		}

		const isAdmin = isSuperAdminActor(actor);
		const accessibleOrgIds = new Set(scopedOrgs.map((o) => o.id));
		const visibleMembers = store.listMembers().filter((m) => canActorUseMember(store, actor, m));
		const visibleTemplateIds = new Set(visibleMembers.map((m) => m.templateId));

		sendJson(res, 200, {
			innerDemoAvailable: Boolean(ctx.innerMatterDemo),
			unifiedConversation: true,
			authKind: actor.authKind,
			currentUser: toPublicCollaborator(actor.collaborator),
			accountUser: actor.user ? toPublicUser(actor.user) : null,
			platformPolicy: {
				requireAuth: Boolean(ctx.requireAuth),
				registrationMode: settings.registrationMode,
				allowLocalWorkspacePath: settings.allowLocalWorkspacePath || isAdmin,
				allowCommandPreviews: settings.allowCommandPreviews || isAdmin,
			},
			collaborators: isAdmin
				? allCollaborators
				: actor.authKind === "session"
					? allCollaborators
							.filter((c) => Boolean(c.orgId && accessibleOrgIds.has(c.orgId)))
							.map(toPublicCollaborator)
					: allCollaborators.filter((c) => !c.orgId || accessibleOrgIds.has(c.orgId)).map(toPublicCollaborator),
			members: visibleMembers,
			templates: liveTemplates
				.filter((t) => t.roleKind === "architect" || visibleTemplateIds.has(t.id))
				.map((t) => ({
					id: t.id,
					name: t.name,
					title: t.title,
					roleKind: t.roleKind ?? (t.id === "role-architect" ? "architect" : "business"),
					roleScope: t.roleScope ?? "global",
					ownerOrgId: t.ownerOrgId ?? null,
					ownerUserId: t.ownerUserId ?? null,
					version: t.version,
					skills: t.skills,
					mcpDependencies: t.mcpDependencies,
					tools: t.tools,
					keywords: t.keywords,
					shareable: t.shareable,
					antiJobs: t.antiJobs ?? [],
					responsibilities: t.sections.responsibilitiesAndBoundaries,
				})),
			workspaces: scopedWorkspaces,
			organizations: scopedOrgs,
			orgMembersByOrgId,
			orgAiRolesByOrgId,
			matters: scopedMatters,
			deliverables: scopedDeliverables,
			pendingDialogs: scopedPendingDialogs,
			previews: scopedPreviews,
			memoriesByMember: formatScopedMemoryMap(store, actor),
			activeRuns: scopedActiveRuns,
		});
		return true;
	}

	if (method === "GET" && pathname === "/api/runtime") {
		if (!requireActiveActor(res, actor)) return true;
		const visibleMembers = store.listMembers().filter((m) => canActorUseMember(store, actor, m));
		const overview = await buildRuntimeOverview({
			config: orchestrator.getRuntimeConfig(),
			serverConfig: ctx.getServerRuntimeConfig?.(),
			activeMembers: visibleMembers,
			isOwner: isSuperAdminActor(actor),
			probePiCli: ctx.probePiCli,
		});
		sendJson(res, 200, overview);
		return true;
	}

	// ---- Organization Membership & Invites ----
	if (method === "POST" && pathname === "/api/organizations/join") {
		if (!requireActiveActor(res, actor)) return true;
		if (!actor.user) {
			sendError(res, 400, "请先使用个人账号登录后再加入组织");
			return true;
		}
		const body = await readJsonBody(req);
		const inviteToken = typeof body.inviteToken === "string" ? body.inviteToken.trim() : "";
		if (!inviteToken) {
			sendError(res, 400, "inviteToken is required");
			return true;
		}
		let result: ReturnType<typeof store.consumeOrgInviteByToken>;
		try {
			result = store.consumeOrgInviteByToken(inviteToken, actor.user.id);
		} catch (err) {
			sendError(res, 400, err instanceof Error ? err.message : String(err));
			return true;
		}
		const org = store.getOrganization(result.invite.orgId);
		auditActorAction(ctx, req, actor, {
			action: "org.join_invite",
			targetType: "organization",
			targetId: result.invite.orgId,
			orgId: result.invite.orgId,
			detail: { orgRole: result.membership.orgRole },
		});
		if (org) {
			broadcast("organization_updated", { organization: org }, { orgId: org.id });
		}
		sendJson(res, 200, { ok: true, organization: org, membership: result.membership });
		return true;
	}

	const orgMembersMatch = pathname.match(/^\/api\/organizations\/([^/]+)\/members$/);
	if (orgMembersMatch) {
		const orgId = decodeURIComponent(orgMembersMatch[1]!);
		if (!store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		if (method === "GET") {
			if (!requireOrgAccess(res, store, actor, orgId)) return true;
			const canAdminOrg = canManageOrganization(store, actor, orgId);
			sendJson(res, 200, {
				members: store.listOrgMembers(orgId),
				invites: canAdminOrg ? store.listOrgInvites(orgId) : [],
			});
			return true;
		}
		if (method === "POST") {
			if (!requireOrgAdmin(res, store, actor, orgId)) return true;
			const body = await readJsonBody(req);
			const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
			const userId = typeof body.userId === "string" ? body.userId.trim() : "";
			const targetUser = email ? store.getUserByEmail(email) : userId ? store.getUserById(userId) : null;
			if (!targetUser) {
				sendError(res, 404, "未找到该注册账号，请确认对方已完成邮箱注册或改用组织邀请链接");
				return true;
			}
			if (targetUser.status === "disabled") {
				sendError(res, 400, "该用户账号已被停用");
				return true;
			}
			const orgRole = parseOrgMemberRole(body.orgRole) ?? "org_member";
			const actorRole = getActorOrgRole(store, actor, orgId);
			if (orgRole === "org_owner" && actorRole !== "org_owner" && !isSuperAdminActor(actor)) {
				sendError(res, 403, "仅组织所有者或超级管理员可授予 org_owner 角色");
				return true;
			}
			const membership = store.upsertOrgMember({
				orgId,
				userId: targetUser.id,
				orgRole,
				roleTitle: typeof body.roleTitle === "string" ? body.roleTitle : undefined,
			});
			auditActorAction(ctx, req, actor, {
				action: "org.add_member",
				targetType: "user",
				targetId: targetUser.id,
				orgId,
				detail: { orgRole, email: targetUser.email },
			});
			const org = store.getOrganization(orgId)!;
			broadcast("organization_updated", { organization: org }, { orgId });
			sendJson(res, 201, { member: membership });
			return true;
		}
	}

	const orgMemberItemMatch = pathname.match(/^\/api\/organizations\/([^/]+)\/members\/([^/]+)$/);
	if (orgMemberItemMatch) {
		const orgId = decodeURIComponent(orgMemberItemMatch[1]!);
		const targetUserId = decodeURIComponent(orgMemberItemMatch[2]!);
		if (!store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		if (method === "PATCH") {
			if (!requireOrgAdmin(res, store, actor, orgId)) return true;
			const existing = store.getOrgMembership(orgId, targetUserId);
			if (!existing) {
				sendError(res, 404, "成员不属于当前组织");
				return true;
			}
			const body = await readJsonBody(req);
			const nextRole = body.orgRole !== undefined ? parseOrgMemberRole(body.orgRole) : existing.orgRole;
			if (!nextRole) {
				sendError(res, 400, "无效的 orgRole");
				return true;
			}
			const actorRole = getActorOrgRole(store, actor, orgId);
			if (
				(existing.orgRole === "org_owner" || nextRole === "org_owner") &&
				actorRole !== "org_owner" &&
				!isSuperAdminActor(actor)
			) {
				sendError(res, 403, "仅组织所有者或超级管理员可变更 org_owner 权限");
				return true;
			}
			const updated = store.upsertOrgMember({
				orgId,
				userId: targetUserId,
				orgRole: nextRole,
				roleTitle: typeof body.roleTitle === "string" ? body.roleTitle : existing.roleTitle,
			});
			auditActorAction(ctx, req, actor, {
				action: "org.update_member",
				targetType: "user",
				targetId: targetUserId,
				orgId,
				detail: { orgRole: updated.orgRole },
			});
			broadcast("organization_updated", { organization: store.getOrganization(orgId)! }, { orgId });
			sendJson(res, 200, { member: updated });
			return true;
		}
		if (method === "DELETE") {
			if (!requireActiveActor(res, actor)) return true;
			const isSelf = actor.user?.id === targetUserId;
			if (!isSelf && !canManageOrganization(store, actor, orgId)) {
				sendError(res, 403, "无权移出组织成员");
				return true;
			}
			const existing = store.getOrgMembership(orgId, targetUserId);
			if (!existing) {
				sendError(res, 404, "成员不属于当前组织");
				return true;
			}
			const actorRole = getActorOrgRole(store, actor, orgId);
			if (!isSelf && existing.orgRole === "org_owner" && actorRole !== "org_owner" && !isSuperAdminActor(actor)) {
				sendError(res, 403, "仅组织所有者或超级管理员可移出组织所有者");
				return true;
			}
			store.removeOrgMember(orgId, targetUserId);
			auditActorAction(ctx, req, actor, {
				action: "org.remove_member",
				targetType: "user",
				targetId: targetUserId,
				orgId,
			});
			broadcast("organization_updated", { organization: store.getOrganization(orgId)! }, { orgId });
			sendJson(res, 200, { ok: true, removedUserId: targetUserId });
			return true;
		}
	}

	const orgInvitesMatch = pathname.match(/^\/api\/organizations\/([^/]+)\/invites$/);
	if (orgInvitesMatch) {
		const orgId = decodeURIComponent(orgInvitesMatch[1]!);
		if (!store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		if (method === "GET") {
			if (!requireOrgAdmin(res, store, actor, orgId)) return true;
			sendJson(res, 200, { invites: store.listOrgInvites(orgId) });
			return true;
		}
		if (method === "POST") {
			if (!requireOrgAdmin(res, store, actor, orgId)) return true;
			const body = await readJsonBody(req);
			const orgRole = parseOrgMemberRole(body.orgRole) ?? "org_member";
			const actorRole = getActorOrgRole(store, actor, orgId);
			if (orgRole === "org_owner" && actorRole !== "org_owner" && !isSuperAdminActor(actor)) {
				sendError(res, 403, "仅组织所有者或超级管理员可生成 org_owner 邀请");
				return true;
			}
			const { rawToken, invite } = store.createOrgInvite({
				orgId,
				orgRole,
				createdByUserId: actor.user?.id ?? actor.collaborator.id,
				maxUses: typeof body.maxUses === "number" ? body.maxUses : 20,
				expiresInHours: typeof body.expiresInHours === "number" ? body.expiresInHours : 168,
			});
			auditActorAction(ctx, req, actor, {
				action: "org.create_invite",
				targetType: "org_invite",
				targetId: invite.id,
				orgId,
				detail: { orgRole, maxUses: invite.maxUses },
			});
			sendJson(res, 201, { invite, rawToken });
			return true;
		}
	}

	const orgInviteRevokeMatch = pathname.match(/^\/api\/organizations\/([^/]+)\/invites\/([^/]+)\/revoke$/);
	if (method === "POST" && orgInviteRevokeMatch) {
		const orgId = decodeURIComponent(orgInviteRevokeMatch[1]!);
		const inviteId = decodeURIComponent(orgInviteRevokeMatch[2]!);
		if (!requireOrgAdmin(res, store, actor, orgId)) return true;
		const revoked = store.revokeOrgInvite(orgId, inviteId);
		if (!revoked) {
			sendError(res, 404, "邀请链接不存在或已失效");
			return true;
		}
		auditActorAction(ctx, req, actor, {
			action: "org.revoke_invite",
			targetType: "org_invite",
			targetId: inviteId,
			orgId,
		});
		sendJson(res, 200, { ok: true, inviteId });
		return true;
	}

	const orgAiRolesMatch = pathname.match(/^\/api\/organizations\/([^/]+)\/ai-roles$/);
	if (orgAiRolesMatch) {
		const orgId = decodeURIComponent(orgAiRolesMatch[1]!);
		if (!store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		if (method === "GET") {
			if (!requireOrgAccess(res, store, actor, orgId)) return true;
			sendJson(res, 200, {
				configured: store.hasOrgAiRolesConfigured(orgId),
				configs: store.listOrgAiRoleConfigs(orgId),
				effectiveMembers: store.resolveEffectiveOrgMembers(orgId),
			});
			return true;
		}
		if (method === "PATCH") {
			if (!requireOrgAdmin(res, store, actor, orgId)) return true;
			const body = await readJsonBody(req);
			const memberId = typeof body.primaryMemberId === "string" ? body.primaryMemberId.trim() : "";
			if (!memberId || !store.setOrgAiPrimaryContact(orgId, memberId)) {
				sendError(res, 400, "请选择本组织已启用的业务 AI 角色");
				return true;
			}
			auditActorAction(ctx, req, actor, {
				action: "org.update_ai_primary",
				targetType: "organization",
				targetId: orgId,
				orgId,
				detail: { memberId },
			});
			broadcast("team_updated", { orgId }, { orgId });
			sendJson(res, 200, { primaryMemberId: memberId });
			return true;
		}
		if (method === "PUT") {
			if (!requireOrgAdmin(res, store, actor, orgId)) return true;
			const body = await readJsonBody(req);
			if (
				!Array.isArray(body.roles) ||
				body.roles.some((item) => !item || typeof item !== "object" || typeof item.enabled !== "boolean")
			) {
				sendError(res, 400, "roles 必须是包含启用状态的角色配置数组");
				return true;
			}
			const parsedRoles = await Promise.all(
				body.roles
					.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
					.map(async (item) => {
						const selection = Object.hasOwn(item, "modelSelection")
							? await validateModelSelection(ctx, item.modelSelection)
							: undefined;
						return {
							memberId: typeof item.memberId === "string" ? item.memberId.trim() : "",
							enabled: Boolean(item.enabled),
							isPrimaryContact: Boolean(item.isPrimaryContact),
							displayNameOverride:
								typeof item.displayNameOverride === "string" ? item.displayNameOverride.trim() || null : null,
							providerOverride:
								selection !== undefined
									? (selection?.provider ?? null)
									: typeof item.providerOverride === "string"
										? item.providerOverride.trim() || null
										: null,
							modelOverride:
								selection !== undefined
									? (selection?.model ?? null)
									: typeof item.modelOverride === "string"
										? item.modelOverride.trim() || null
										: null,
							thinkingLevelOverride:
								selection !== undefined
									? (selection?.thinkingLevel ?? null)
									: isThinkingLevel(item.thinkingLevelOverride)
										? item.thinkingLevelOverride
										: null,
							gitNameOverride:
								typeof item.gitNameOverride === "string" ? item.gitNameOverride.trim() || null : null,
							gitEmailOverride:
								typeof item.gitEmailOverride === "string" ? item.gitEmailOverride.trim() || null : null,
						};
					}),
			);
			if (new Set(parsedRoles.map((role) => role.memberId)).size !== parsedRoles.length) {
				sendError(res, 400, "每个角色只能配置一次");
				return true;
			}
			if (!parsedRoles.some((role) => role.enabled)) {
				sendError(res, 400, "每个组织至少需要启用 1 位 AI 角色");
				return true;
			}
			for (const role of parsedRoles) {
				const target = store.getMember(role.memberId);
				if (!target) {
					sendError(res, 400, "角色配置包含不存在的成员");
					return true;
				}
				if (target.roleScope === "personal") {
					sendError(res, 400, "个人私有 AI 角色不能加入组织共享角色配置");
					return true;
				}
				if (target.roleScope === "org" && target.ownerOrgId !== orgId) {
					sendError(res, 403, `角色 ${target.displayName} 属于其他组织，无法在本组织启用`);
					return true;
				}
			}
			const useRoleGitIdentity = typeof body.useRoleGitIdentity === "boolean" ? body.useRoleGitIdentity : undefined;
			const configs = store.setOrgAiRolesBatch(orgId, parsedRoles, useRoleGitIdentity);
			const updatedOrganization = useRoleGitIdentity === undefined ? null : store.getOrganization(orgId);
			const effectiveMembers = store.resolveEffectiveOrgMembers(orgId);
			auditActorAction(ctx, req, actor, {
				action: "org.update_ai_roles",
				targetType: "organization",
				targetId: orgId,
				orgId,
				detail: {
					enabledMemberIds: effectiveMembers.map((m) => m.id),
					...(typeof body.useRoleGitIdentity === "boolean" ? { useRoleGitIdentity: body.useRoleGitIdentity } : {}),
				},
			});
			if (updatedOrganization) {
				broadcast("organization_updated", { organization: updatedOrganization }, { orgId });
			}
			broadcast("team_updated", { orgId }, { orgId });
			sendJson(res, 200, {
				...(updatedOrganization ? { organization: updatedOrganization } : {}),
				configs,
				effectiveMembers,
			});
			return true;
		}
	}

	// ---- Legacy LAN Collaborators (backwards compatible) ----
	if (method === "GET" && pathname === "/api/collaborators") {
		if (!requireActiveActor(res, actor)) return true;
		const list = store.listCollaborators();
		const isAdmin = isSuperAdminActor(actor);
		sendJson(res, 200, {
			collaborators: isAdmin
				? list
				: list.filter((c) => !c.orgId || canAccessOrganization(store, actor, c.orgId)).map(toPublicCollaborator),
		});
		return true;
	}

	if (method === "POST" && pathname === "/api/collaborators") {
		if (!requireOwner(res, actor)) return true;
		const body = await readJsonBody(req);
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!name) {
			sendError(res, 400, "name is required");
			return true;
		}
		const roleTitle = typeof body.roleTitle === "string" ? body.roleTitle.trim() : "";
		const orgId = typeof body.orgId === "string" && body.orgId.trim() ? body.orgId.trim() : null;
		if (orgId && !store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		const permissionRole: CollaboratorRole = body.permissionRole === "owner" ? "owner" : "collaborator";
		const collaborator = store.upsertCollaborator({
			id: typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined,
			name,
			roleTitle: roleTitle || (permissionRole === "owner" ? "团队所有者" : "协同同事"),
			permissionRole,
			orgId,
		});
		broadcast("collaborator_updated", { collaborator: toPublicCollaborator(collaborator) });
		sendJson(res, 201, { collaborator });
		return true;
	}

	const collabRegenMatch = pathname.match(/^\/api\/collaborators\/([^/]+)\/regenerate-token$/);
	if (method === "POST" && collabRegenMatch) {
		if (!requireOwner(res, actor)) return true;
		const collabId = decodeURIComponent(collabRegenMatch[1]!);
		const collaborator = store.regenerateCollaboratorToken(collabId);
		if (!collaborator) {
			sendError(res, 404, `Collaborator not found: ${collabId}`);
			return true;
		}
		revokeTokenSessions(collabId, "token_regenerated");
		broadcast("collaborator_updated", { collaborator: toPublicCollaborator(collaborator) });
		sendJson(res, 200, { collaborator });
		return true;
	}

	const collabItemMatch = pathname.match(/^\/api\/collaborators\/([^/]+)$/);
	if (method === "PATCH" && collabItemMatch) {
		if (!requireOwner(res, actor)) return true;
		const collabId = decodeURIComponent(collabItemMatch[1]!);
		const existing = store.getCollaborator(collabId);
		if (!existing) {
			sendError(res, 404, `Collaborator not found: ${collabId}`);
			return true;
		}
		const body = await readJsonBody(req);
		const orgId =
			body.orgId === null
				? null
				: typeof body.orgId === "string" && body.orgId.trim()
					? body.orgId.trim()
					: existing.orgId;
		if (orgId && !store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		const permissionRole: CollaboratorRole =
			collabId === DEFAULT_OWNER_COLLABORATOR_ID
				? "owner"
				: body.permissionRole === "owner"
					? "owner"
					: body.permissionRole === "collaborator"
						? "collaborator"
						: existing.permissionRole;
		const collaborator = store.upsertCollaborator({
			id: collabId,
			name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : existing.name,
			roleTitle:
				typeof body.roleTitle === "string" && body.roleTitle.trim() ? body.roleTitle.trim() : existing.roleTitle,
			permissionRole,
			orgId,
		});
		broadcast("collaborator_updated", { collaborator: toPublicCollaborator(collaborator) });
		sendJson(res, 200, { collaborator });
		return true;
	}

	if (method === "DELETE" && collabItemMatch) {
		if (!requireOwner(res, actor)) return true;
		const collabId = decodeURIComponent(collabItemMatch[1]!);
		if (collabId === DEFAULT_OWNER_COLLABORATOR_ID) {
			sendError(res, 400, "Cannot delete the default owner collaborator");
			return true;
		}
		if (!store.getCollaborator(collabId)) {
			sendError(res, 404, `Collaborator not found: ${collabId}`);
			return true;
		}
		for (const matter of store.listMatters()) {
			if (matter.collaboratorIds.includes(collabId)) {
				store.updateMatterCollaborators(
					matter.id,
					matter.collaboratorIds.filter((id) => id !== collabId),
				);
			}
		}
		store.deleteCollaborator(collabId);
		revokeTokenSessions(collabId, "collaborator_deleted");
		broadcast("collaborator_updated", { deletedId: collabId });
		sendJson(res, 200, { ok: true, deletedId: collabId });
		return true;
	}

	return false;
}
