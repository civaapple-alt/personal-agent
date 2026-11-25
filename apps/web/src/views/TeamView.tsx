import { useCallback, useMemo, useState } from "react";
import type { RoleScope } from "../api.ts";
import {
	type AccountUserDto,
	type CollaboratorDto,
	exportMemberPackage,
	type MatterDto,
	type OrganizationAiRoleConfigDto,
	type OrganizationDto,
	type RoleTemplateDto,
	setOrgAiPrimaryContact,
	setPrimaryMember,
	type TeamMemberDto,
	type WorkspaceDto,
} from "../api.ts";
import {
	buildRoleScopeChoices,
	canMemberManageRole,
	filterBusinessMembers,
	getMemberScopeBadge,
	isArchitectMember,
} from "../architectApi.ts";
import { MemberInspectorModal } from "../components/team/MemberInspectorModal.tsx";
import { MemberPackageForms } from "../components/team/MemberPackageForms.tsx";
import { BotFaceIcon } from "../primitives/BotFaceIcon.tsx";
import { applyOrgAiRoleOverrides, getBotTheme, resolveEffectivePrimaryContactId } from "../utils.ts";

interface TeamViewProps {
	currentUser?: CollaboratorDto | null;
	accountUser?: AccountUserDto | null;
	isSuperAdmin?: boolean;
	members: TeamMemberDto[];
	workspaces: WorkspaceDto[];
	organizations?: OrganizationDto[];
	orgAiRolesByOrgId?: Record<
		string,
		{ configured: boolean; configs: OrganizationAiRoleConfigDto[]; effectiveMemberIds: string[] }
	>;
	matters?: MatterDto[];
	selectedOrgId?: string | null;
	defaultWorkspaceId?: string | null;
	templateByRoleId: Map<string, RoleTemplateDto>;
	memberName: (id: string) => string;
	organizationName?: (id: string | null) => string | null;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
	onAssignTask: (memberId: string) => void;
	onOpenArchitectMatter?: (seedText?: string) => void;
	onOpenOrganizations?: () => void;
}

/** Focused AI team workbench: role directory, role packages, and team healthcheck. */
export function TeamView({
	currentUser,
	accountUser = null,
	isSuperAdmin = false,
	members,
	workspaces,
	organizations = [],
	orgAiRolesByOrgId = {},
	selectedOrgId = null,
	defaultWorkspaceId = null,
	templateByRoleId,
	memberName,
	organizationName,
	onRefresh,
	onNotice,
	onError,
	onAssignTask,
	onOpenArchitectMatter,
	onOpenOrganizations,
}: TeamViewProps) {
	const isOwner = isSuperAdmin || (!accountUser && currentUser?.permissionRole !== "collaborator");
	const roleScopeChoices = useMemo(
		() => buildRoleScopeChoices({ isSuperAdmin, accountUser, currentUser, organizations }),
		[isSuperAdmin, accountUser, currentUser, organizations],
	);
	const canCreateAnyRole = roleScopeChoices.length > 0;
	const canManageAnyOrg =
		isSuperAdmin || organizations.some((org) => org.orgRole === "org_owner" || org.orgRole === "org_admin");
	const canRunHealthcheck = isOwner || canManageAnyOrg;
	const canDispatchAny = accountUser
		? accountUser.status === "active" &&
			accountUser.canDispatchAi &&
			(organizations.length === 0 || organizations.some((o) => o.orgRole !== "org_viewer"))
		: currentUser?.permissionRole !== "collaborator";
	const [scopeFilter, setScopeFilter] = useState<"all" | RoleScope>("all");
	const [showImportMember, setShowImportMember] = useState(false);
	const [exportedPackage, setExportedPackage] = useState<{
		id: string;
		filename: string;
		markdown: string;
	} | null>(null);
	const [inspectedMemberId, setInspectedMemberId] = useState<string | null>(null);
	const [savingPrimary, setSavingPrimary] = useState(false);
	const businessMembers = useMemo(() => {
		const regular = filterBusinessMembers(members, templateByRoleId);
		const architect = members.filter((m) => isArchitectMember(m, templateByRoleId));
		return [...regular, ...architect];
	}, [members, templateByRoleId]);
	const visibleBusinessMembers = useMemo(() => {
		if (scopeFilter === "all") return businessMembers;
		return businessMembers.filter((m) => (m.roleScope ?? (m.ownerOrgId ? "org" : "global")) === scopeFilter);
	}, [businessMembers, scopeFilter]);
	const scopeCounts = useMemo(() => {
		let global = 0;
		let org = 0;
		let personal = 0;
		for (const m of businessMembers) {
			const s = m.roleScope ?? (m.ownerOrgId ? "org" : "global");
			if (s === "personal") personal += 1;
			else if (s === "org") org += 1;
			else global += 1;
		}
		return { global, org, personal };
	}, [businessMembers]);
	const inspectedMember = useMemo(() => {
		if (inspectedMemberId) {
			const exact = visibleBusinessMembers.find((m) => m.id === inspectedMemberId);
			if (exact) return exact;
		}
		return visibleBusinessMembers[0] ?? null;
	}, [inspectedMemberId, visibleBusinessMembers]);
	const inspectedIndex = inspectedMember ? businessMembers.findIndex((m) => m.id === inspectedMember.id) : -1;
	const inspectedCanManage = useMemo(
		() => canMemberManageRole(inspectedMember, { isSuperAdmin, accountUser, currentUser, organizations }),
		[inspectedMember, isSuperAdmin, accountUser, currentUser, organizations],
	);

	const activeWorkspace = useMemo(
		() => workspaces.find((ws) => ws.id === defaultWorkspaceId) ?? null,
		[workspaces, defaultWorkspaceId],
	);
	const activeOrg = useMemo(
		() => (activeWorkspace?.orgId ? (organizations.find((org) => org.id === activeWorkspace.orgId) ?? null) : null),
		[activeWorkspace, organizations],
	);
	const canManageOrgPrimary = useCallback(
		(org: OrganizationDto | null | undefined) =>
			Boolean(
				org &&
					(isSuperAdmin ||
						org.orgRole === "org_owner" ||
						org.orgRole === "org_admin" ||
						(!accountUser && isOwner)),
			),
		[isSuperAdmin, accountUser, isOwner],
	);
	const defaultPrimaryScope = useMemo(() => {
		const selectedOrgObj = selectedOrgId ? (organizations.find((org) => org.id === selectedOrgId) ?? null) : null;
		if (selectedOrgObj && canManageOrgPrimary(selectedOrgObj)) return selectedOrgObj.id;
		if (activeOrg && canManageOrgPrimary(activeOrg)) return activeOrg.id;
		const manageableDefault =
			organizations.find((org) => org.isDefault && canManageOrgPrimary(org)) ??
			organizations.find((org) => canManageOrgPrimary(org));
		if (manageableDefault) return manageableDefault.id;
		if (selectedOrgObj) return selectedOrgObj.id;
		if (activeOrg) return activeOrg.id;
		const fallbackOrg = organizations.find((org) => org.isDefault) ?? organizations[0];
		return fallbackOrg ? fallbackOrg.id : "__global__";
	}, [selectedOrgId, activeOrg, organizations, canManageOrgPrimary]);
	const activePrimaryScope = defaultPrimaryScope;
	const primaryTargetOrg = useMemo(
		() =>
			activePrimaryScope === "__global__"
				? null
				: (organizations.find((org) => org.id === activePrimaryScope) ?? null),
		[activePrimaryScope, organizations],
	);
	const canSwitchPrimary = useMemo(() => {
		if (!primaryTargetOrg) return isOwner;
		return canManageOrgPrimary(primaryTargetOrg);
	}, [primaryTargetOrg, isOwner, canManageOrgPrimary]);
	const eligiblePrimaryMembers = useMemo(() => {
		if (!primaryTargetOrg) {
			return businessMembers.filter((m) => (m.roleScope ?? (m.ownerOrgId ? "org" : "global")) === "global");
		}
		const orgEligible = businessMembers.filter(
			(m) => m.roleScope !== "personal" && (m.roleScope !== "org" || m.ownerOrgId === primaryTargetOrg.id),
		);
		const entry = orgAiRolesByOrgId[primaryTargetOrg.id];
		if (entry?.configured && entry.effectiveMemberIds.length > 0) {
			const enabledSet = new Set(entry.effectiveMemberIds);
			const enabled = orgEligible.filter((m) => enabledSet.has(m.id));
			if (enabled.length > 0) return enabled;
		}
		return orgEligible;
	}, [businessMembers, primaryTargetOrg, orgAiRolesByOrgId]);
	const eligiblePrimaryIds = useMemo(() => new Set(eligiblePrimaryMembers.map((m) => m.id)), [eligiblePrimaryMembers]);
	const effectivePrimaryId = useMemo(
		() => resolveEffectivePrimaryContactId(members, primaryTargetOrg?.id ?? null, orgAiRolesByOrgId),
		[members, primaryTargetOrg, orgAiRolesByOrgId],
	);
	const cardDisplayMembers = useMemo(
		() => applyOrgAiRoleOverrides(visibleBusinessMembers, primaryTargetOrg?.id ?? null, orgAiRolesByOrgId),
		[visibleBusinessMembers, primaryTargetOrg, orgAiRolesByOrgId],
	);
	const inspectedEffectiveGitConfig = useMemo(() => {
		if (!inspectedMember || !primaryTargetOrg) return null;
		return orgAiRolesByOrgId[primaryTargetOrg.id]?.configs.find((c) => c.memberId === inspectedMember.id) ?? null;
	}, [inspectedMember, primaryTargetOrg, orgAiRolesByOrgId]);

	const handleSetPrimary = async (memberId: string) => {
		if (!memberId || savingPrimary || memberId === effectivePrimaryId) return;
		setSavingPrimary(true);
		try {
			if (primaryTargetOrg) {
				await setOrgAiPrimaryContact(primaryTargetOrg.id, memberId);
				onNotice(`已将「${primaryTargetOrg.name}」的主联系人切换为「${memberName(memberId)}」`);
			} else {
				await setPrimaryMember(memberId);
				onNotice(`已将「${memberName(memberId)}」设为全局默认主联系人`);
			}
			await onRefresh();
		} catch (error: unknown) {
			onError(error instanceof Error ? error.message : String(error));
		} finally {
			setSavingPrimary(false);
		}
	};

	const handleExportMember = async (memberId: string) => {
		try {
			const pkg = await exportMemberPackage(memberId);
			setExportedPackage(pkg);
		} catch (error: unknown) {
			onError(error instanceof Error ? error.message : String(error));
		}
	};

	return (
		<div className="subpage-scroll">
			<div className="subpage-inner wide">
				<div className="pane-header-row">
					<div className="pane-header">
						<h1>AI 团队</h1>
						<p>专注 AI 岗位分工与能力包管理；组织成员与主联系人配置请前往「组织」页。</p>
					</div>
					{canCreateAnyRole && (
						<div className="actions-row compact">
							<button type="button" className="btn-pill-outline" onClick={() => setShowImportMember((v) => !v)}>
								导入角色包
							</button>
						</div>
					)}
				</div>

				<div className="ui-sections-stack">
					<MemberPackageForms
						showImportMember={showImportMember}
						exportedPackage={exportedPackage}
						isSuperAdmin={isSuperAdmin}
						accountUser={accountUser}
						currentUser={currentUser}
						organizations={organizations}
						onCloseImportMember={() => setShowImportMember(false)}
						onCloseExportedPackage={() => setExportedPackage(null)}
						onRefresh={onRefresh}
						onNotice={onNotice}
						onError={onError}
					/>

					<section className="ui-section">
						<div className="ui-section-head">
							<div className="team-members-heading">
								<h2 className="ui-section-title">
									AI 团队成员（{businessMembers.length}）
									{accountUser && scopeCounts.personal > 0 && (
										<span className="muted-tiny">
											{" "}
											· 个人私有 {scopeCounts.personal}/{accountUser.maxPersonalRoles ?? 5}
										</span>
									)}
								</h2>
								<p className="ui-section-desc">左侧选择角色，右侧直接查看职责、技能、不做边界与身份档案</p>
							</div>
							<div className="actions-row compact">
								{(scopeCounts.org > 0 || scopeCounts.personal > 0) && (
									<div className="architect-quick-chips" role="tablist" aria-label="按角色使用范围筛选">
										{(
											[
												["all", `全部 (${businessMembers.length})`],
												["global", `平台通用 (${scopeCounts.global})`],
												...(scopeCounts.org > 0
													? ([["org", `组织共享 (${scopeCounts.org})`]] as const)
													: []),
												...(scopeCounts.personal > 0
													? ([["personal", `仅我可用 (${scopeCounts.personal})`]] as const)
													: []),
											] as const
										).map(([key, label]) => (
											<button
												key={key}
												type="button"
												role="tab"
												aria-selected={scopeFilter === key}
												className={`choice-chip ${scopeFilter === key ? "active" : ""}`}
												onClick={() => setScopeFilter(key)}
											>
												{label}
											</button>
										))}
									</div>
								)}
								{canRunHealthcheck && onOpenArchitectMatter && canDispatchAny && (
									<button
										type="button"
										className="btn-pill-outline btn-xs"
										onClick={() =>
											onOpenArchitectMatter(
												`请基于当前可见团队名册（${businessMembers.length} 个业务角色）、近期运行洞察与交付反馈，做一次团队协作体检：指出真实存在的职责重叠、协作卡点或工具/Skill 摩擦；如有需要再给出调整或补位建议，没有明显问题时直接说明即可。`,
											)
										}
									>
										团队协作体检
									</button>
								)}
								{onOpenOrganizations && (
									<button type="button" className="btn-inline" onClick={onOpenOrganizations}>
										组织与主联系人 →
									</button>
								)}
							</div>
						</div>
						<div className="team-split-layout">
							<aside className="team-split-nav" aria-label="AI 角色列表">
								<div className="team-split-list">
									{cardDisplayMembers.map((member) => {
										const fullIdx = businessMembers.findIndex((m) => m.id === member.id);
										const theme = getBotTheme(fullIdx >= 0 ? fullIdx : 0);
										const isSelected = inspectedMember?.id === member.id;
										const isPrimary = member.id === effectivePrimaryId;
										const isArch = isArchitectMember(member, templateByRoleId);
										const scopeBadge = getMemberScopeBadge(member, organizationName);
										return (
											<button
												key={member.id}
												type="button"
												className={`team-nav-item ${isSelected ? "active" : ""}`}
												onClick={() => setInspectedMemberId(member.id)}
											>
												<BotFaceIcon
													bg={theme.bg}
													tilt={theme.tilt}
													size="sm"
													mood={isArch ? "thinking" : "idle"}
												/>
												<span className="team-nav-copy">
													<span className="team-nav-name-row">
														<strong>{member.displayName}</strong>
														{isPrimary && <span className="pill live">主联系</span>}
													</span>
													<span className="team-nav-sub">
														{scopeBadge.label}
														{member.roleTitle && member.roleTitle !== member.displayName
															? ` · ${member.roleTitle}`
															: ""}
													</span>
												</span>
											</button>
										);
									})}
								</div>
							</aside>
							<div className="team-split-main">
								{inspectedMember ? (
									<MemberInspectorModal
										inline
										member={inspectedMember}
										memberIndex={inspectedIndex}
										template={templateByRoleId.get(inspectedMember.templateId)}
										canEditIdentity={inspectedCanManage}
										canDispatch={canDispatchAny}
										canSetPrimary={canSwitchPrimary && eligiblePrimaryIds.has(inspectedMember.id)}
										primaryActionLabel={
											primaryTargetOrg ? `设为「${primaryTargetOrg.name}」主联系` : "设为全局默认主联系"
										}
										isPrimary={inspectedMember.id === effectivePrimaryId}
										effectiveGitOverride={inspectedEffectiveGitConfig}
										activeWorkspace={activeWorkspace}
										activeOrg={primaryTargetOrg ?? activeOrg}
										organizationName={organizationName}
										onAssignTask={onAssignTask}
										onSetPrimary={handleSetPrimary}
										onExportMember={handleExportMember}
										onRefresh={onRefresh}
										onNotice={onNotice}
										onError={onError}
									/>
								) : (
									<div className="ui-card">
										<p className="muted-sm">当前筛选条件下暂无 AI 角色。</p>
									</div>
								)}
							</div>
						</div>
					</section>
				</div>
			</div>
		</div>
	);
}
