import { useEffect, useMemo, useState } from "react";
import {
	type AccountUserDto,
	type CollaboratorDto,
	createOrganization,
	joinOrganizationByInvite,
	type OrganizationAiRoleConfigDto,
	type OrganizationDto,
	type OrganizationMemberDto,
	type RoleTemplateDto,
	type TeamMemberDto,
	updateOrganization,
	type WorkspaceDto,
} from "../api.ts";
import { filterBusinessMembers } from "../architectApi.ts";
import { ORG_ROLE_LABEL, OrganizationDetailPanel } from "../components/OrganizationDetailPanel.tsx";
import {
	Button,
	EmptyState,
	FieldGroup,
	Input,
	ModalDialog,
	PageShell,
	PaneHeader,
	SplitPane,
} from "../primitives/index.ts";
import { cn } from "../utils/cn.ts";

interface OrganizationsViewProps {
	currentUser?: CollaboratorDto | null;
	accountUser?: AccountUserDto | null;
	isSuperAdmin?: boolean;
	organizations: OrganizationDto[];
	workspaces: WorkspaceDto[];
	members: TeamMemberDto[];
	templateByRoleId: Map<string, RoleTemplateDto>;
	orgMembersByOrgId?: Record<string, OrganizationMemberDto[]>;
	orgAiRolesByOrgId?: Record<
		string,
		{ configured: boolean; configs: OrganizationAiRoleConfigDto[]; effectiveMemberIds: string[] }
	>;
	selectedOrgId?: string | null;
	onOpenSpace?: (spaceId: string) => void;
	onOpenWorkspaces?: () => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

/** Dedicated two-column Organizations workbench aligned with Workspaces and Spaces. */
export function OrganizationsView({
	currentUser = null,
	accountUser = null,
	isSuperAdmin = false,
	organizations,
	workspaces,
	members,
	templateByRoleId,
	orgMembersByOrgId = {},
	orgAiRolesByOrgId = {},
	selectedOrgId = null,
	onOpenSpace,
	onOpenWorkspaces,
	onRefresh,
	onNotice,
	onError,
}: OrganizationsViewProps) {
	const isOwner = isSuperAdmin || (!accountUser && currentUser?.permissionRole !== "collaborator");
	const canCreateOrg = isSuperAdmin || (accountUser ? accountUser.status === "active" : isOwner);
	const businessMembers = useMemo(() => filterBusinessMembers(members, templateByRoleId), [members, templateByRoleId]);

	const defaultOrgId = selectedOrgId || organizations.find((o) => o.isDefault)?.id || organizations[0]?.id || "";
	const [activeOrgId, setActiveOrgId] = useState<string>(defaultOrgId);

	useEffect(() => {
		if (!organizations.some((o) => o.id === activeOrgId)) {
			setActiveOrgId(defaultOrgId);
		}
	}, [organizations, activeOrgId, defaultOrgId]);

	const activeOrg = useMemo(
		() => organizations.find((o) => o.id === activeOrgId) ?? organizations[0] ?? null,
		[organizations, activeOrgId],
	);

	// Create / edit org modal
	const [showOrgForm, setShowOrgForm] = useState(false);
	const [editingOrgId, setEditingOrgId] = useState<string | null>(null);
	const [orgNameInput, setOrgNameInput] = useState("");
	const [orgDomainInput, setOrgDomainInput] = useState("");
	const [orgUseRoleGitInput, setOrgUseRoleGitInput] = useState(false);
	const [orgDescInput, setOrgDescInput] = useState("");
	const [initialAiMemberIds, setInitialAiMemberIds] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);

	// Join by invite modal
	const [showJoinModal, setShowJoinModal] = useState(false);
	const [joinTokenInput, setJoinTokenInput] = useState("");
	const [joining, setJoining] = useState(false);

	const openCreateOrgForm = () => {
		setEditingOrgId(null);
		setOrgNameInput("");
		setOrgDomainInput("");
		setOrgUseRoleGitInput(false);
		setOrgDescInput("");
		setInitialAiMemberIds(businessMembers.map((m) => m.id));
		setShowOrgForm(true);
	};

	const openEditOrgForm = (org: OrganizationDto) => {
		setEditingOrgId(org.id);
		setOrgNameInput(org.name);
		setOrgDomainInput(org.gitEmailDomain);
		setOrgUseRoleGitInput(Boolean(org.useRoleGitIdentity));
		setOrgDescInput(org.description);
		setShowOrgForm(true);
	};

	const closeOrgModal = () => {
		if (saving) return;
		setShowOrgForm(false);
		setEditingOrgId(null);
	};

	const handleSaveOrg = async () => {
		if (!orgNameInput.trim() || saving) return;
		setSaving(true);
		try {
			if (editingOrgId) {
				await updateOrganization(editingOrgId, {
					name: orgNameInput.trim(),
					gitEmailDomain: orgDomainInput.trim(),
					useRoleGitIdentity: orgUseRoleGitInput,
					description: orgDescInput.trim(),
				});
				onNotice(`组织「${orgNameInput.trim()}」已更新`);
			} else {
				const created = await createOrganization({
					name: orgNameInput.trim(),
					gitEmailDomain: orgDomainInput.trim(),
					useRoleGitIdentity: orgUseRoleGitInput,
					description: orgDescInput.trim(),
					...(businessMembers.length > 0 ? { aiMemberIds: initialAiMemberIds } : {}),
				});
				if (created?.organization?.id) {
					setActiveOrgId(created.organization.id);
				}
				onNotice(`已创建组织「${orgNameInput.trim()}」`);
			}
			setShowOrgForm(false);
			setEditingOrgId(null);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	const handleJoinOrg = async () => {
		if (!joinTokenInput.trim() || joining) return;
		setJoining(true);
		try {
			const res = await joinOrganizationByInvite(joinTokenInput.trim());
			setJoinTokenInput("");
			setShowJoinModal(false);
			setActiveOrgId(res.organization.id);
			onNotice(`已加入组织「${res.organization.name}」（${ORG_ROLE_LABEL[res.membership.orgRole]}）`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setJoining(false);
		}
	};

	const sidebar = (
		<nav aria-label="组织列表" className="bg-sidebar border border-line rounded-lg p-2.5 flex flex-col gap-2">
			<div className="flex items-center justify-between gap-2 px-1">
				<span className="text-xs font-semibold text-ink-secondary">全部组织（{organizations.length}）</span>
				{canCreateOrg && (
					<Button variant="inline" size="xs" onClick={openCreateOrgForm}>
						+ 新建组织
					</Button>
				)}
			</div>
			{organizations.length === 0 ? (
				<p className="m-0 px-1.5 py-2 text-xs text-ink-muted leading-normal">
					尚未加入任何组织，可新建组织或使用邀请码加入。
				</p>
			) : (
				<div className="flex flex-col gap-0.5">
					{organizations.map((org) => {
						const isSelected = activeOrg?.id === org.id;
						const memberCount = orgMembersByOrgId[org.id]?.length ?? 0;
						return (
							<button
								key={org.id}
								type="button"
								className={cn(
									"w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-sm text-xs text-left cursor-pointer transition-colors border-l-2 focus-visible:outline-2 focus-visible:outline-accent",
									isSelected
										? "bg-stage text-ink font-semibold border-accent shadow-sm"
										: "bg-transparent text-ink-secondary border-transparent hover:bg-hover hover:text-ink",
								)}
								onClick={() => setActiveOrgId(org.id)}
							>
								<span className="min-w-0 truncate">
									{org.name}
									{org.isDefault ? " · 默认" : ""}
								</span>
								{memberCount > 0 && (
									<span className="shrink-0 text-micro text-ink-muted tabular-nums">{memberCount}</span>
								)}
							</button>
						);
					})}
				</div>
			)}
			{accountUser && (
				<div className="pt-2 border-t border-line">
					<Button variant="secondary" size="xs" className="w-full" onClick={() => setShowJoinModal(true)}>
						+ 邀请码加入组织
					</Button>
				</div>
			)}
		</nav>
	);

	return (
		<PageShell maxWidth="wide">
			<PaneHeader title="组织" subtitle="管理组织权限边界、人类成员与邀请、组织启用的 AI 角色名册与默认主联系人。" />

			<SplitPane className="mt-4" sidebar={sidebar} sidebarWidth="248px">
				{activeOrg ? (
					<OrganizationDetailPanel
						organization={activeOrg}
						workspaces={workspaces}
						businessMembers={businessMembers}
						orgMembers={orgMembersByOrgId[activeOrg.id] ?? []}
						orgAiRoles={orgAiRolesByOrgId[activeOrg.id]}
						isOwner={isOwner}
						isSuperAdmin={isSuperAdmin}
						accountUser={accountUser}
						onEditOrg={openEditOrgForm}
						onOpenSpace={onOpenSpace}
						onOpenWorkspaces={onOpenWorkspaces}
						onRefresh={onRefresh}
						onNotice={onNotice}
						onError={onError}
					/>
				) : (
					<EmptyState
						title="暂无组织"
						description="新建组织后即可统一管理人类成员权限、工作区归属与 AI 角色装配。"
						action={
							<>
								{canCreateOrg && (
									<Button variant="primary" size="xs" onClick={openCreateOrgForm}>
										+ 新建组织
									</Button>
								)}
								{accountUser && (
									<Button variant="secondary" size="xs" onClick={() => setShowJoinModal(true)}>
										邀请码加入组织
									</Button>
								)}
							</>
						}
					/>
				)}
			</SplitPane>

			<ModalDialog
				open={showOrgForm}
				title={editingOrgId ? "编辑组织" : "新建组织"}
				subtitle="每个组织拥有独立的成员权限、启用的 AI 角色名册与组织级资料空间。"
				size="sm"
				closeDisabled={saving}
				onClose={closeOrgModal}
				footer={
					<>
						<Button variant="secondary" size="sm" disabled={saving} onClick={closeOrgModal}>
							取消
						</Button>
						<Button
							variant="primary"
							size="sm"
							disabled={!orgNameInput.trim() || saving}
							onClick={() => void handleSaveOrg()}
						>
							{saving ? "保存中…" : editingOrgId ? "保存修改" : "创建组织"}
						</Button>
					</>
				}
			>
				<div className="flex flex-col gap-3">
					<FieldGroup label="组织名称" htmlFor="org-form-name">
						<Input
							id="org-form-name"
							placeholder="如：研发一部、产品团队"
							value={orgNameInput}
							onChange={(e) => setOrgNameInput(e.target.value)}
						/>
					</FieldGroup>
					<FieldGroup label="组织说明（可选）" htmlFor="org-form-desc">
						<Input
							id="org-form-desc"
							placeholder="简要说明该组织的业务范围"
							value={orgDescInput}
							onChange={(e) => setOrgDescInput(e.target.value)}
						/>
					</FieldGroup>
					<FieldGroup label="AI 角色 Git 邮箱域名（可选）" htmlFor="org-form-domain">
						<Input
							id="org-form-domain"
							placeholder="如 company.com（留空则使用默认域名）"
							value={orgDomainInput}
							onChange={(e) => setOrgDomainInput(e.target.value)}
						/>
					</FieldGroup>
					<label className="inline-flex items-center gap-2 text-xs text-ink cursor-pointer">
						<input
							type="checkbox"
							className="accent-accent"
							checked={orgUseRoleGitInput}
							onChange={(e) => setOrgUseRoleGitInput(e.target.checked)}
						/>
						<span>在本组织仓库执行 Git 提交时以 AI 角色署名作为 Author</span>
					</label>
				</div>
			</ModalDialog>

			<ModalDialog
				open={showJoinModal}
				title="通过邀请码加入组织"
				subtitle="输入组织管理员生成的 orginv_ 邀请码，加入后即可访问该组织的工作区与共享空间。"
				size="sm"
				closeDisabled={joining}
				onClose={() => !joining && setShowJoinModal(false)}
				footer={
					<>
						<Button variant="secondary" size="sm" disabled={joining} onClick={() => setShowJoinModal(false)}>
							取消
						</Button>
						<Button
							variant="primary"
							size="sm"
							disabled={!joinTokenInput.trim() || joining}
							onClick={() => void handleJoinOrg()}
						>
							{joining ? "加入中…" : "确认加入"}
						</Button>
					</>
				}
			>
				<div className="flex flex-col gap-3">
					<FieldGroup label="组织邀请码" htmlFor="org-join-token">
						<Input
							id="org-join-token"
							placeholder="粘贴 orginv_ 开头的邀请码"
							value={joinTokenInput}
							onChange={(e) => setJoinTokenInput(e.target.value)}
						/>
					</FieldGroup>
				</div>
			</ModalDialog>
		</PageShell>
	);
}
