import { useMemo } from "react";
import type { BootstrapPayload } from "../api/bootstrap.ts";
import type { MatterDetailPayload } from "../api/matters.ts";
import type { RoleTemplateDto, TeamMemberDto } from "../api/team.ts";
import { isArchitectMemberId, isSoloMemberId } from "../architectApi.ts";
import { applyPrimaryContactToMembers, getBotTheme, resolveEffectivePrimaryContactId } from "../utils.ts";

interface MatterScopeOptions {
	bootstrap: BootstrapPayload | null;
	matterDetail: MatterDetailPayload | null;
	selectedMatterId: string | null;
	selectedMemberId: string;
	selectedOrgId: string;
	selectedWorkspaceId: string;
}

/** Derives the current workspace, organization, lead, and scoped role choices. */
export function useMatterScope({
	bootstrap,
	matterDetail,
	selectedMatterId,
	selectedMemberId,
	selectedOrgId,
	selectedWorkspaceId,
}: MatterScopeOptions) {
	const selectedWorkspace = useMemo(
		() => bootstrap?.workspaces.find((w) => w.id === selectedWorkspaceId) ?? null,
		[bootstrap, selectedWorkspaceId],
	);
	const draftEffectiveOrgId = selectedWorkspace?.orgId ?? (selectedOrgId || null);
	const effectiveOrgIdForScope =
		(selectedMatterId ? matterDetail?.matter.orgId : null) ?? selectedWorkspace?.orgId ?? (selectedOrgId || null);
	const headerContact: TeamMemberDto | null = useMemo(() => {
		if (!bootstrap) return null;
		if (selectedMatterId && matterDetail?.matter.leadMemberId) {
			return bootstrap.members.find((m) => m.id === matterDetail.matter.leadMemberId) ?? null;
		}
		if (selectedMemberId !== "auto") {
			return bootstrap.members.find((m) => m.id === selectedMemberId) ?? null;
		}
		const primaryId = resolveEffectivePrimaryContactId(
			bootstrap.members,
			effectiveOrgIdForScope,
			bootstrap.orgAiRolesByOrgId,
		);
		return bootstrap.members.find((m) => m.id === primaryId) ?? bootstrap.members[0] ?? null;
	}, [bootstrap, matterDetail, selectedMatterId, selectedMemberId, effectiveOrgIdForScope]);

	const memberThemeMap = useMemo(() => {
		const map = new Map<string, { bg: string; tilt: string }>();
		bootstrap?.members.forEach((member, index) => {
			map.set(member.id, getBotTheme(index));
		});
		return map;
	}, [bootstrap]);

	const activeDialogs = useMemo(() => {
		if (!bootstrap) return [];
		return selectedMatterId
			? bootstrap.pendingDialogs.filter((d) => d.matterId === selectedMatterId)
			: bootstrap.pendingDialogs;
	}, [bootstrap, selectedMatterId]);

	const templateByRoleId = useMemo(() => {
		const map = new Map<string, RoleTemplateDto>();
		for (const tpl of bootstrap?.templates ?? []) {
			map.set(tpl.id, tpl);
		}
		return map;
	}, [bootstrap]);

	const initiationScopedMembers = useMemo(() => {
		const all = bootstrap?.members ?? [];
		const enabledIds = draftEffectiveOrgId
			? bootstrap?.orgAiRolesByOrgId?.[draftEffectiveOrgId]?.effectiveMemberIds
			: undefined;
		const filtered =
			!enabledIds || enabledIds.length === 0
				? all
				: all.filter(
						(m) =>
							enabledIds.includes(m.id) ||
							m.roleScope === "personal" ||
							isArchitectMemberId(m.id, all, templateByRoleId) ||
							isSoloMemberId(m.id, all, templateByRoleId),
					);
		const primaryId = resolveEffectivePrimaryContactId(all, draftEffectiveOrgId, bootstrap?.orgAiRolesByOrgId);
		return applyPrimaryContactToMembers(filtered, primaryId);
	}, [bootstrap, draftEffectiveOrgId, templateByRoleId]);

	const effectiveOrg = effectiveOrgIdForScope
		? (bootstrap?.organizations.find((o) => o.id === effectiveOrgIdForScope) ?? null)
		: null;
	const orgEffectiveMemberIds = effectiveOrgIdForScope
		? (bootstrap?.orgAiRolesByOrgId?.[effectiveOrgIdForScope]?.effectiveMemberIds ?? null)
		: null;

	return {
		selectedWorkspace,
		draftEffectiveOrgId,
		effectiveOrgIdForScope,
		headerContact,
		memberThemeMap,
		activeDialogs,
		templateByRoleId,
		initiationScopedMembers,
		effectiveOrg,
		orgEffectiveMemberIds,
	};
}
