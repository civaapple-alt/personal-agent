import { useMemo } from "react";
import type {
	CollaboratorDto,
	MatterDetailPayload,
	OrganizationDto,
	OrganizationMemberDto,
	OrgMemberRole,
	RoleTemplateDto,
	TeamMemberDto,
	WorkspaceDto,
} from "../api.ts";
import { filterBusinessMembers, isArchitectMemberId } from "../architectApi.ts";
import type { DelegationAssignment } from "../utils/matterDelegations.ts";

const ORG_ROLE_LABEL: Record<OrgMemberRole, string> = {
	org_owner: "组织所有者",
	org_admin: "组织管理员",
	org_member: "普通成员",
	org_viewer: "只读访客",
};

interface UseChatStageParticipantsOptions {
	isSuperAdmin: boolean;
	currentUser?: CollaboratorDto | null;
	collaborators: CollaboratorDto[];
	orgMembersByOrgId: Record<string, OrganizationMemberDto[]>;
	orgEffectiveMemberIds: string[] | null;
	selectedWorkspace: WorkspaceDto | null;
	selectedOrgId: string;
	workspaces: WorkspaceDto[];
	organizations: OrganizationDto[];
	members: TeamMemberDto[];
	selectedMemberId: string;
	headerContact: TeamMemberDto | null;
	selectedMatterId: string | null;
	matterDetail: MatterDetailPayload | null;
	templateByRoleId: Map<string, RoleTemplateDto>;
	matterAiMemberIds: string[];
	observerMemberIds: string[];
	observersEnabled: boolean;
	draftCollaboratorIds: string[];
	delegations: DelegationAssignment[];
}

/** Projects organization, workspace, human collaborator, and AI roster views for ChatStage. */
export function useChatStageParticipants({
	isSuperAdmin,
	currentUser,
	collaborators,
	orgMembersByOrgId,
	orgEffectiveMemberIds,
	selectedWorkspace,
	selectedOrgId,
	workspaces,
	organizations,
	members,
	selectedMemberId,
	headerContact,
	selectedMatterId,
	matterDetail,
	templateByRoleId,
	matterAiMemberIds,
	observerMemberIds,
	observersEnabled,
	draftCollaboratorIds,
	delegations,
}: UseChatStageParticipantsOptions) {
	const fallbackOrgId = !isSuperAdmin
		? ((organizations.find((o) => o.isDefault) ?? organizations[0])?.id ?? null)
		: null;
	const effectiveOrgId = selectedWorkspace ? selectedWorkspace.orgId : selectedOrgId || fallbackOrgId;
	const selectedOrganization = useMemo(
		() => (effectiveOrgId ? (organizations.find((org) => org.id === effectiveOrgId) ?? null) : null),
		[effectiveOrgId, organizations],
	);
	const orgFilteredWorkspaces = useMemo(
		() =>
			effectiveOrgId ? workspaces.filter((ws) => ws.orgId === effectiveOrgId) : workspaces.filter((ws) => !ws.orgId),
		[effectiveOrgId, workspaces],
	);

	const orgMembers = effectiveOrgId ? (orgMembersByOrgId[effectiveOrgId] ?? []) : [];
	const scopedMembers = useMemo(() => {
		if (!orgEffectiveMemberIds || orgEffectiveMemberIds.length === 0) return members;
		return members.filter(
			(m) =>
				orgEffectiveMemberIds.includes(m.id) ||
				m.roleScope === "personal" ||
				isArchitectMemberId(m.id, members, templateByRoleId) ||
				m.id === matterDetail?.matter.leadMemberId,
		);
	}, [members, orgEffectiveMemberIds, templateByRoleId, matterDetail?.matter.leadMemberId]);

	const ownerCollab =
		orgMembers.length > 0
			? (() => {
					const orgOwner = orgMembers.find((om) => om.orgRole === "org_owner") ?? orgMembers[0];
					return orgOwner
						? {
								id: orgOwner.userId,
								name: orgOwner.displayName ?? orgOwner.email ?? orgOwner.userId,
								roleTitle: orgOwner.roleTitle || ORG_ROLE_LABEL[orgOwner.orgRole],
								permissionRole: "owner" as const,
								orgId: orgOwner.orgId,
								createdAt: orgOwner.createdAt,
								updatedAt: orgOwner.updatedAt,
							}
						: null;
				})()
			: currentUser?.id.startsWith("usr_")
				? currentUser
				: (collaborators.find((c) => c.permissionRole === "owner") ?? null);
	const nonOwnerCollaborators = collaborators.filter((c) => c.permissionRole !== "owner");
	const humanPeerCandidates = useMemo(() => {
		const map = new Map<string, CollaboratorDto>();
		for (const om of orgMembers) {
			if (ownerCollab?.id === om.userId) continue;
			map.set(om.userId, {
				id: om.userId,
				name: om.displayName ?? om.email ?? om.userId,
				roleTitle: om.roleTitle || ORG_ROLE_LABEL[om.orgRole],
				permissionRole: om.orgRole === "org_owner" || om.orgRole === "org_admin" ? "owner" : "collaborator",
				orgId: om.orgId,
				createdAt: om.createdAt,
				updatedAt: om.updatedAt,
			});
		}
		for (const col of nonOwnerCollaborators) {
			if (!map.has(col.id)) map.set(col.id, col);
		}
		return [...map.values()];
	}, [orgMembers, nonOwnerCollaborators, ownerCollab?.id]);

	const assignedCollabIds = matterDetail ? (matterDetail.matter.collaboratorIds ?? []) : draftCollaboratorIds;
	const messageHumanAuthorIds = useMemo(() => {
		const ids = new Set<string>();
		for (const msg of matterDetail?.userMessages ?? []) {
			if (msg.senderType === "user" && msg.senderId && msg.senderId !== "user") {
				ids.add(msg.senderId);
			}
		}
		return ids;
	}, [matterDetail?.userMessages]);
	const matterHumanParticipants = humanPeerCandidates.filter(
		(c) => assignedCollabIds.includes(c.id) || messageHumanAuthorIds.has(c.id) || currentUser?.id === c.id,
	);
	const allActiveHumans = useMemo(() => {
		const list: CollaboratorDto[] = [];
		const seenIds = new Set<string>();
		if (ownerCollab) {
			list.push(ownerCollab);
			seenIds.add(ownerCollab.id);
		}
		for (const col of matterHumanParticipants) {
			if (!seenIds.has(col.id)) {
				list.push(col);
				seenIds.add(col.id);
			}
		}
		return list;
	}, [ownerCollab, matterHumanParticipants]);

	const leadAi =
		(matterDetail?.matter.leadMemberId
			? scopedMembers.find((m) => m.id === matterDetail.matter.leadMemberId)
			: null) ?? headerContact;
	const inGroupAiMembers = useMemo(() => {
		const idSet = new Set(matterAiMemberIds);
		if (leadAi) idSet.add(leadAi.id);
		const filtered = scopedMembers.filter((m) => idSet.has(m.id));
		if (leadAi && filtered.some((m) => m.id === leadAi.id)) {
			return [leadAi, ...filtered.filter((m) => m.id !== leadAi.id)];
		}
		return filtered.length > 0 ? filtered : scopedMembers;
	}, [leadAi, matterAiMemberIds, scopedMembers]);
	const nonLeadGroupAiMembers = inGroupAiMembers.filter((m) => m.id !== leadAi?.id);
	const removedAiMembers = scopedMembers.filter((m) => !inGroupAiMembers.some((g) => g.id === m.id));
	const observerAis = observersEnabled
		? observerMemberIds.length > 0
			? nonLeadGroupAiMembers.filter((m) => observerMemberIds.includes(m.id))
			: matterDetail
				? []
				: nonLeadGroupAiMembers
		: [];
	const specialistIds = Array.from(new Set(delegations.map((d) => d.toMemberId).filter(Boolean))).filter(
		(id) => id !== leadAi?.id && !observerAis.some((obs) => obs.id === id),
	);
	const isArchitectMode = selectedMatterId
		? Boolean(matterDetail && isArchitectMemberId(matterDetail.matter.leadMemberId, members, templateByRoleId))
		: isArchitectMemberId(selectedMemberId, members, templateByRoleId);
	const businessCount = filterBusinessMembers(members, templateByRoleId).length;

	return {
		effectiveOrgId,
		selectedOrganization,
		orgFilteredWorkspaces,
		orgMembers,
		scopedMembers,
		ownerCollab,
		nonOwnerCollaborators,
		humanPeerCandidates,
		assignedCollabIds,
		matterHumanParticipants,
		allActiveHumans,
		leadAi,
		inGroupAiMembers,
		nonLeadGroupAiMembers,
		removedAiMembers,
		observerAis,
		specialistIds,
		isArchitectMode,
		businessCount,
	};
}
