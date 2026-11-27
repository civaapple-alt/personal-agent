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
	isSoloMember,
} from "../architectApi.ts";
import { MemberInspectorModal } from "../components/team/MemberInspectorModal.tsx";
import { MemberPackageForms } from "../components/team/MemberPackageForms.tsx";
import {
	Badge,
	BotFaceIcon,
	Button,
	EmptyState,
	PageShell,
	PaneHeader,
	SplitPane,
	type TabItem,
	Tabs,
} from "../primitives/index.ts";
import { cn } from "../utils/cn.ts";
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
		const solo = members.filter((m) => isSoloMember(m, templateByRoleId));
		const architect = members.filter((m) => isArchitectMember(m, templateByRoleId));
		return [...regular, ...solo, ...architect];
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
	const scopeTabItems = useMemo<TabItem[]>(() => {
		const items: TabItem[] = [
			{ id: "all", label: "全部", count: businessMembers.length },
			{ id: "global", label: "平台通用", count: scopeCounts.global },
		];
		if (scopeCounts.org > 0) items.push({ id: "org", label: "组织共享", count: scopeCounts.org });
		if (scopeCounts.personal > 0) items.push({ id: "personal", label: "仅我可用", count: scopeCounts.personal });
		return items;
	}, [businessMembers.length, scopeCounts]);
	const inspectedMember = useMemo(() => {
		if (inspectedMemberId) {
			const exact = visibleBusinessMembers.find((m) => m.id === inspectedMemberId);
			if (exact) return exact;
		}
		return visibleBusinessMembers[0] ?? null;
	}, [inspectedMemberId, visibleBusinessMembers]);
	const inspectedIndex = inspectedMember ? members.findIndex((m) => m.id === inspectedMember.id) : -1;
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
		<PageShell maxWidth="wide">
			<PaneHeader
				title="AI 团队"
				subtitle="专注 AI 岗位分工与能力包管理；组织成员与主联系人配置请前往「组织」页。"
				actions={
					canCreateAnyRole ? (
						<Button variant="secondary" size="sm" onClick={() => setShowImportMember((v) => !v)}>
							导入角色包
						</Button>
					) : undefined
				}
			/>

			<div className="mt-4 flex flex-col gap-4">
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

				<section className="flex flex-col gap-3">
					<div className="flex items-start justify-between gap-3 flex-wrap">
						<div className="flex items-baseline gap-2.5 flex-wrap">
							<h2 className="m-0 text-lg font-semibold text-ink leading-snug">
								AI 团队成员（{businessMembers.length}）
								{accountUser && scopeCounts.personal > 0 && (
									<span className="text-xs font-normal text-ink-muted">
										{" "}
										· 个人私有 {scopeCounts.personal}/{accountUser.maxPersonalRoles ?? 5}
									</span>
								)}
							</h2>
							<p className="m-0 text-xs text-ink-muted">
								左侧选择角色，右侧直接查看职责、技能、不做边界与身份档案
							</p>
						</div>
						<div className="flex items-center gap-2 flex-wrap">
							{(scopeCounts.org > 0 || scopeCounts.personal > 0) && (
								<Tabs
									variant="pill"
									size="sm"
									ariaLabel="按角色使用范围筛选"
									value={scopeFilter}
									onChange={(id) => setScopeFilter(id as "all" | RoleScope)}
									items={scopeTabItems}
								/>
							)}
							{canRunHealthcheck && onOpenArchitectMatter && canDispatchAny && (
								<Button
									variant="secondary"
									size="xs"
									onClick={() =>
										onOpenArchitectMatter(
											`请基于当前可见团队名册（${businessMembers.length} 个业务角色）、近期运行洞察与交付反馈，做一次团队协作体检：指出真实存在的职责重叠、协作卡点或工具/Skill 摩擦；如有需要再给出调整或补位建议，没有明显问题时直接说明即可。`,
										)
									}
								>
									团队协作体检
								</Button>
							)}
							{onOpenOrganizations && (
								<Button variant="inline" size="xs" onClick={onOpenOrganizations}>
									组织与主联系人 →
								</Button>
							)}
						</div>
					</div>

					<SplitPane
						sidebarWidth="276px"
						sidebar={
							<nav
								aria-label="AI 角色列表"
								className="lg:sticky lg:top-3 lg:max-h-[calc(100vh-160px)] lg:overflow-y-auto lg:pr-1 flex flex-col gap-1.5"
							>
								{cardDisplayMembers.map((member) => {
									const fullIdx = members.findIndex((m) => m.id === member.id);
									const theme = getBotTheme(fullIdx >= 0 ? fullIdx : 0);
									const isSelected = inspectedMember?.id === member.id;
									const isPrimary = member.id === effectivePrimaryId;
									const isArch = isArchitectMember(member, templateByRoleId);
									const scopeBadge = getMemberScopeBadge(member, organizationName);
									return (
										<button
											key={member.id}
											type="button"
											aria-current={isSelected ? "true" : undefined}
											onClick={() => setInspectedMemberId(member.id)}
											className={cn(
												"w-full flex items-center gap-2.5 px-2.5 py-2 border rounded-md text-left cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-accent",
												isSelected
													? "border-accent bg-accent-soft"
													: "border-line bg-stage hover:border-line-strong hover:bg-hover/60",
											)}
										>
											<BotFaceIcon
												bg={theme.bg}
												tilt={theme.tilt}
												size="sm"
												mood={isArch ? "thinking" : "idle"}
											/>
											<span className="flex flex-col gap-0.5 min-w-0 flex-1">
												<span className="flex items-center gap-1.5 text-sm min-w-0">
													<strong className="font-semibold text-ink truncate">{member.displayName}</strong>
													{isPrimary && (
														<Badge tone="success" dot>
															主联系
														</Badge>
													)}
												</span>
												<span className="text-micro text-ink-muted truncate">
													{scopeBadge.label}
													{member.roleTitle && member.roleTitle !== member.displayName
														? ` · ${member.roleTitle}`
														: ""}
												</span>
											</span>
										</button>
									);
								})}
							</nav>
						}
					>
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
							<EmptyState
								compact
								title="当前筛选条件下暂无 AI 角色"
								description="可切换上方使用范围筛选，或导入新的角色能力包。"
							/>
						)}
					</SplitPane>
				</section>
			</div>
		</PageShell>
	);
}
