import { useMemo, useState } from "react";
import type { RoleScope } from "../api.ts";
import {
	type AccountUserDto,
	type CollaboratorDto,
	exportMemberPackage,
	type MatterDto,
	type MemberMemoryDto,
	type OrganizationAiRoleConfigDto,
	type OrganizationDto,
	type OrganizationMemberDto,
	type RoleTemplateDto,
	setPrimaryMember,
	type TeamMemberDto,
	type WorkspaceDto,
} from "../api.ts";
import { buildRoleScopeChoices, canMemberManageRole, filterBusinessMembers } from "../architectApi.ts";
import { CollaboratorsSection } from "./team/CollaboratorsSection.tsx";
import { MemberCard } from "./team/MemberCard.tsx";
import { MemberInspectorModal } from "./team/MemberInspectorModal.tsx";
import { MemberPackageForms } from "./team/MemberPackageForms.tsx";
import { OrganizationsSection } from "./team/OrganizationsSection.tsx";
import { TeamHealthcheckPanel } from "./team/TeamHealthcheckPanel.tsx";

interface TeamViewProps {
	currentUser?: CollaboratorDto | null;
	accountUser?: AccountUserDto | null;
	isSuperAdmin?: boolean;
	collaborators?: CollaboratorDto[];
	members: TeamMemberDto[];
	workspaces: WorkspaceDto[];
	organizations?: OrganizationDto[];
	orgMembersByOrgId?: Record<string, OrganizationMemberDto[]>;
	orgAiRolesByOrgId?: Record<
		string,
		{ configured: boolean; configs: OrganizationAiRoleConfigDto[]; effectiveMemberIds: string[] }
	>;
	matters?: MatterDto[];
	defaultWorkspaceId?: string | null;
	memoriesByMember: Record<string, MemberMemoryDto[]>;
	templateByRoleId: Map<string, RoleTemplateDto>;
	memberName: (id: string) => string;
	workspaceName: (id: string | null) => string | null;
	organizationName?: (id: string | null) => string | null;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
	onPreviewAsCollaborator?: (token: string) => void;
	onRestoreOwner?: () => void;
	onAssignTask: (memberId: string) => void;
	onOpenArchitect?: () => void;
	onOpenArchitectMatter?: () => void;
	onOpenMatter?: (matterId: string) => void;
	onOpenDeliverable?: (deliverableId: string) => void;
}

/** Coordinates the team page: organizations, human org members/AI roles, global AI cards, and legacy collaborators. */
export function TeamView({
	currentUser,
	accountUser = null,
	isSuperAdmin = false,
	collaborators = [],
	members,
	workspaces,
	organizations = [],
	orgMembersByOrgId = {},
	orgAiRolesByOrgId = {},
	matters = [],
	defaultWorkspaceId = null,
	memoriesByMember,
	templateByRoleId,
	memberName,
	workspaceName,
	organizationName,
	onRefresh,
	onNotice,
	onError,
	onPreviewAsCollaborator,
	onRestoreOwner,
	onAssignTask,
	onOpenArchitect,
	onOpenArchitectMatter,
	onOpenMatter,
	onOpenDeliverable,
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
	const [healthcheckOpen, setHealthcheckOpen] = useState(false);
	const [inspectState, setInspectState] = useState<{ memberId: string; tab: "identity" | "memories" } | null>(null);
	const businessMembers = useMemo(() => filterBusinessMembers(members, templateByRoleId), [members, templateByRoleId]);
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
	const inspectedMember = useMemo(
		() => (inspectState ? (members.find((m) => m.id === inspectState.memberId) ?? null) : null),
		[inspectState, members],
	);
	const inspectedIndex = inspectedMember ? businessMembers.findIndex((m) => m.id === inspectedMember.id) : -1;
	const inspectedCanManage = useMemo(
		() => canMemberManageRole(inspectedMember, { isSuperAdmin, accountUser, currentUser, organizations }),
		[inspectedMember, isSuperAdmin, accountUser, currentUser, organizations],
	);

	const matterWorkspaceById = useMemo(
		() => new Map(matters.map((matter) => [matter.id, matter.workspaceId])),
		[matters],
	);
	const activeWorkspace = useMemo(
		() => workspaces.find((ws) => ws.id === defaultWorkspaceId) ?? null,
		[workspaces, defaultWorkspaceId],
	);
	const activeOrg = useMemo(
		() => (activeWorkspace?.orgId ? (organizations.find((org) => org.id === activeWorkspace.orgId) ?? null) : null),
		[activeWorkspace, organizations],
	);

	const handleSetPrimary = async (memberId: string) => {
		try {
			await setPrimaryMember(memberId);
			onNotice(`已将「${memberName(memberId)}」设为默认主联系人`);
			await onRefresh();
		} catch (error: unknown) {
			onError(error instanceof Error ? error.message : String(error));
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
						<h1>我的团队</h1>
						<p>查看岗位分工与经验沉淀，支持按需创建角色或导入导出能力包</p>
					</div>
					{canCreateAnyRole && (
						<div className="actions-row compact">
							{onOpenArchitectMatter && canDispatchAny && (
								<button type="button" className="btn-pill-dark" onClick={onOpenArchitectMatter}>
									对话规划角色
								</button>
							)}
							{onOpenArchitect && (
								<button
									type="button"
									className={onOpenArchitectMatter && canDispatchAny ? "btn-pill-outline" : "btn-pill-dark"}
									onClick={() => {
										setShowImportMember(false);
										onOpenArchitect();
									}}
								>
									+ 快速创建角色
								</button>
							)}
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
									AI 业务团队成员（{businessMembers.length}）
									{accountUser && scopeCounts.personal > 0 && (
										<span className="muted-tiny">
											{" "}
											· 个人私有 {scopeCounts.personal}/{accountUser.maxPersonalRoles ?? 5}
										</span>
									)}
								</h2>
								<p className="ui-section-desc">点开「详情与经验」可查看 Git 署名、禁用边界与三层记忆</p>
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
								{canRunHealthcheck && (
									<button
										type="button"
										className="btn-pill-outline btn-xs"
										onClick={() => setHealthcheckOpen(true)}
									>
										团队协作体检
									</button>
								)}
							</div>
						</div>
						<div className="team-grid">
							{visibleBusinessMembers.map((member, idx) => (
								<MemberCard
									key={member.id}
									member={member}
									index={idx}
									template={templateByRoleId.get(member.templateId)}
									memories={memoriesByMember[member.id] ?? []}
									activeWorkspace={activeWorkspace}
									activeOrg={activeOrg}
									organizationName={organizationName}
									canManage={canMemberManageRole(member, {
										isSuperAdmin,
										accountUser,
										currentUser,
										organizations,
									})}
									canSetPrimary={
										isOwner && (member.roleScope ?? (member.ownerOrgId ? "org" : "global")) === "global"
									}
									canDispatch={canDispatchAny}
									onAssignTask={onAssignTask}
									onSetPrimary={handleSetPrimary}
									onExportMember={handleExportMember}
									onInspectMember={(memberId, tab) => setInspectState({ memberId, tab })}
									onRefresh={onRefresh}
									onNotice={onNotice}
									onError={onError}
								/>
							))}
						</div>
					</section>

					<OrganizationsSection
						isOwner={isOwner}
						isSuperAdmin={isSuperAdmin}
						accountUser={accountUser}
						organizations={organizations}
						workspaces={workspaces}
						businessMembers={businessMembers}
						orgMembersByOrgId={orgMembersByOrgId}
						orgAiRolesByOrgId={orgAiRolesByOrgId}
						onRefresh={onRefresh}
						onNotice={onNotice}
						onError={onError}
					/>

					{(isSuperAdmin || !accountUser) && (
						<CollaboratorsSection
							isOwner={isOwner}
							currentUser={currentUser}
							collaborators={collaborators}
							organizations={organizations}
							onRefresh={onRefresh}
							onNotice={onNotice}
							onError={onError}
							onPreviewAsCollaborator={onPreviewAsCollaborator}
							onRestoreOwner={onRestoreOwner}
						/>
					)}
				</div>
			</div>

			<TeamHealthcheckPanel
				open={healthcheckOpen}
				memberCount={businessMembers.length}
				matterCount={matters.length}
				onClose={() => setHealthcheckOpen(false)}
				onApplied={onRefresh}
				onOpenArchitectChat={onOpenArchitectMatter}
				onNotice={onNotice}
				onError={onError}
			/>

			<MemberInspectorModal
				member={inspectedMember}
				memberIndex={inspectedIndex}
				template={inspectedMember ? templateByRoleId.get(inspectedMember.templateId) : undefined}
				memories={inspectedMember ? (memoriesByMember[inspectedMember.id] ?? []) : []}
				initialTab={inspectState?.tab ?? "identity"}
				canEditIdentity={inspectedCanManage}
				canCurateMemories={
					isOwner || Boolean(inspectedMember && inspectedMember.roleScope === "personal" && inspectedCanManage)
				}
				members={members}
				workspaces={workspaces}
				organizations={organizations}
				activeWorkspace={activeWorkspace}
				activeOrg={activeOrg}
				defaultWorkspaceId={defaultWorkspaceId}
				matterWorkspaceById={matterWorkspaceById}
				memberName={memberName}
				workspaceName={workspaceName}
				organizationName={organizationName}
				onClose={() => setInspectState(null)}
				onOpenMatter={onOpenMatter}
				onOpenDeliverable={onOpenDeliverable}
				onRefresh={onRefresh}
				onNotice={onNotice}
				onError={onError}
			/>
		</div>
	);
}
