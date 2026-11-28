import { useEffect, useId, useMemo, useState } from "react";
import {
	addWorkspace,
	type MatterDto,
	type OrganizationDto,
	type OrganizationMemberDto,
	updateWorkspace,
	type WorkspaceDto,
	type WorkspaceSourceType,
	type WorkspaceVisibility,
} from "../api.ts";
import { ServerDirectoryPicker } from "../components/ServerDirectoryPicker.tsx";
import { WorkspaceDetailPanel } from "../components/WorkspaceDetailPanel.tsx";
import {
	Button,
	EmptyState,
	FieldGroup,
	Input,
	ModalDialog,
	PageShell,
	PaneHeader,
	Select,
	SplitPane,
	Tabs,
} from "../primitives/index.ts";
import { cn } from "../utils/cn.ts";

interface MaterialsViewProps {
	workspaces: WorkspaceDto[];
	organizations: OrganizationDto[];
	orgMembersByOrgId?: Record<string, OrganizationMemberDto[]>;
	matters?: MatterDto[];
	memberName?: (id: string) => string;
	selectedWorkspaceId: string;
	allowLocalWorkspacePath?: boolean;
	isAccountMode?: boolean;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
	onOpenMatter?: (matterId: string) => void;
	onOpenSpace?: (targetId: string) => void;
	onUseWorkspace: (workspaceId: string) => void;
}

export function MaterialsView({
	workspaces,
	organizations,
	orgMembersByOrgId = {},
	matters = [],
	memberName = (id) => id,
	selectedWorkspaceId,
	allowLocalWorkspacePath = true,
	isAccountMode = false,
	onRefresh,
	onNotice,
	onError,
	onOpenMatter,
	onOpenSpace,
	onUseWorkspace,
}: MaterialsViewProps) {
	const defaultOrganization = organizations.find((o) => o.isDefault) ?? organizations[0] ?? null;
	const [activeWsId, setActiveWsId] = useState<string>(selectedWorkspaceId || workspaces[0]?.id || "");
	const [showAddModal, setShowAddModal] = useState(false);
	const [newWsName, setNewWsName] = useState("");
	const [newWsSourceType, setNewWsSourceType] = useState<WorkspaceSourceType>(
		!allowLocalWorkspacePath || isAccountMode ? "cloned" : "local",
	);
	const [newWsCloneUrl, setNewWsCloneUrl] = useState("");
	const [newWsBranch, setNewWsBranch] = useState("");
	const [newWsPath, setNewWsPath] = useState("");
	const [browsingDirectory, setBrowsingDirectory] = useState(false);
	const [newWsOrgChoice, setNewWsOrgChoice] = useState<string>("");
	const [newWsVisibility, setNewWsVisibility] = useState<WorkspaceVisibility>("org");
	const [newWsAllowedUserIds, setNewWsAllowedUserIds] = useState<string[]>([]);
	const [submitting, setSubmitting] = useState(false);

	// Visibility edit modal
	const [editingAccessWs, setEditingAccessWs] = useState<WorkspaceDto | null>(null);
	const [editVisibility, setEditVisibility] = useState<WorkspaceVisibility>("org");
	const [editAllowedUserIds, setEditAllowedUserIds] = useState<string[]>([]);
	const [savingAccess, setSavingAccess] = useState(false);

	const wsNameId = useId();
	const wsOrgId = useId();
	const wsCloneUrlId = useId();
	const wsBranchId = useId();
	const wsVisibilityId = useId();
	const editVisibilityId = useId();

	useEffect(() => {
		if (!workspaces.some((w) => w.id === activeWsId)) {
			setActiveWsId(selectedWorkspaceId || workspaces[0]?.id || "");
		}
	}, [workspaces, activeWsId, selectedWorkspaceId]);

	const activeWorkspace = useMemo(
		() => workspaces.find((w) => w.id === activeWsId) ?? workspaces[0] ?? null,
		[workspaces, activeWsId],
	);

	const groupedWorkspaces = useMemo(() => {
		const groups: Array<{ key: string; label: string; items: WorkspaceDto[] }> = [];
		const byOrg = new Map<string, WorkspaceDto[]>();
		for (const ws of workspaces) {
			const key = ws.orgId ?? "__standalone__";
			const list = byOrg.get(key) ?? [];
			list.push(ws);
			byOrg.set(key, list);
		}
		for (const org of organizations) {
			const items = byOrg.get(org.id);
			if (items && items.length > 0) {
				groups.push({ key: org.id, label: org.name, items });
			}
		}
		const standalone = byOrg.get("__standalone__");
		if (standalone && standalone.length > 0) {
			groups.push({ key: "__standalone__", label: "独立工作区", items: standalone });
		}
		return groups;
	}, [workspaces, organizations]);

	const resolvedNewOrgId =
		newWsOrgChoice === "__standalone__" ? null : newWsOrgChoice || defaultOrganization?.id || null;
	const targetOrgMembers = resolvedNewOrgId ? (orgMembersByOrgId[resolvedNewOrgId] ?? []) : [];

	const openAddModal = () => {
		setNewWsName("");
		setNewWsSourceType(!allowLocalWorkspacePath || isAccountMode ? "cloned" : "local");
		setNewWsCloneUrl("");
		setNewWsBranch("");
		setNewWsPath("");
		setBrowsingDirectory(false);
		setNewWsOrgChoice("");
		setNewWsVisibility("org");
		setNewWsAllowedUserIds([]);
		setShowAddModal(true);
	};

	const closeAddModal = () => {
		if (submitting) return;
		setShowAddModal(false);
	};

	const handleAddWorkspace = async () => {
		if (!newWsName.trim() || submitting) return;
		if (newWsSourceType === "cloned" && !newWsCloneUrl.trim()) return;
		if (newWsSourceType === "local" && !newWsPath.trim()) return;
		setSubmitting(true);
		try {
			await addWorkspace({
				name: newWsName.trim(),
				sourceType: newWsSourceType,
				...(newWsSourceType === "cloned"
					? {
							cloneUrl: newWsCloneUrl.trim(),
							...(newWsBranch.trim() ? { defaultBranch: newWsBranch.trim() } : {}),
						}
					: { repoPath: newWsPath.trim() }),
				orgId: newWsOrgChoice === "__standalone__" ? null : newWsOrgChoice || undefined,
				visibility: newWsVisibility,
				...(newWsVisibility === "restricted" ? { allowedUserIds: newWsAllowedUserIds } : {}),
			});
			setShowAddModal(false);
			onNotice(newWsSourceType === "cloned" ? "仓库已克隆到组织主目录并绑定工作区" : "项目工作区已绑定");
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	};

	const handleChangeWorkspaceOrg = async (workspaceId: string, orgId: string) => {
		try {
			await updateWorkspace(workspaceId, { orgId: orgId || null });
			onNotice(orgId ? "仓库所属组织已更新，同组织仓库将共享组织级经验与记忆" : "已取消该仓库的组织归属");
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		}
	};

	const openEditAccessModal = (ws: WorkspaceDto) => {
		setEditingAccessWs(ws);
		setEditVisibility(ws.visibility ?? "org");
		setEditAllowedUserIds(ws.allowedUserIds ?? []);
	};

	const handleSaveAccess = async () => {
		if (!editingAccessWs || savingAccess) return;
		setSavingAccess(true);
		try {
			await updateWorkspace(editingAccessWs.id, {
				visibility: editVisibility,
				allowedUserIds: editVisibility === "restricted" ? editAllowedUserIds : [],
			});
			setEditingAccessWs(null);
			onNotice("项目仓库访问范围已更新");
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setSavingAccess(false);
		}
	};

	const addDisabled =
		!newWsName.trim() || submitting || (newWsSourceType === "cloned" ? !newWsCloneUrl.trim() : !newWsPath.trim());

	const activeOrg = activeWorkspace?.orgId
		? (organizations.find((o) => o.id === activeWorkspace.orgId) ?? null)
		: null;
	const activeCanManage = Boolean(
		activeWorkspace &&
			(!isAccountMode ||
				!activeOrg?.orgRole ||
				activeOrg.orgRole === "org_owner" ||
				activeOrg.orgRole === "org_admin"),
	);
	const activeCanEditAccess = Boolean(
		activeCanManage && activeWorkspace?.orgId && (orgMembersByOrgId[activeWorkspace.orgId]?.length ?? 0) > 0,
	);

	return (
		<PageShell maxWidth="wide">
			<PaneHeader
				title="工作区"
				subtitle="统一查看工作区、配置多目录与 Rules / Skills 预算，以及追踪事项与资料空间动态。"
			/>

			<SplitPane
				sidebarWidth="244px"
				className="mt-5 gap-6 lg:gap-8"
				sidebar={
					<nav
						className="flex flex-col gap-3.5 border-b border-line pb-4 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-5 lg:min-h-[440px]"
						aria-label="工作区列表"
					>
						<div className="flex items-center justify-between gap-2 text-sm">
							<span className="text-xs font-semibold text-ink-secondary">全部工作区（{workspaces.length}）</span>
							<Button variant="inline" size="xs" onClick={openAddModal}>
								+ 新建工作区
							</Button>
						</div>
						{workspaces.length === 0 ? (
							<p className="m-0 px-2.5 py-2 text-xs text-ink-muted">暂无已登记工作区，点击右上角添加。</p>
						) : (
							groupedWorkspaces.map((group) => (
								<div key={group.key} className="flex flex-col gap-0.5">
									<div className="px-2.5 py-1 text-micro font-semibold text-ink-muted uppercase tracking-wider">
										{group.label}
									</div>
									{group.items.map((ws) => {
										const isSelected = activeWorkspace?.id === ws.id;
										const matterCount = matters.filter(
											(m) => m.workspaceId === ws.id && m.status !== "archived",
										).length;
										return (
											<button
												key={ws.id}
												type="button"
												className={cn(
													"flex items-center justify-between gap-2 w-full px-2.5 py-1.5 border-0 rounded-md text-left text-sm cursor-pointer transition-colors",
													isSelected
														? "bg-subtle text-ink font-semibold"
														: "bg-transparent text-ink-secondary hover:bg-hover/60 hover:text-ink",
												)}
												onClick={() => setActiveWsId(ws.id)}
											>
												<span className="min-w-0 truncate">{ws.name}</span>
												{matterCount > 0 && (
													<span className="text-micro text-ink-muted tabular-nums shrink-0">
														{matterCount}
													</span>
												)}
											</button>
										);
									})}
								</div>
							))
						)}
					</nav>
				}
			>
				{activeWorkspace ? (
					<WorkspaceDetailPanel
						workspace={activeWorkspace}
						allWorkspaces={workspaces}
						organizations={organizations}
						matters={matters}
						canManage={activeCanManage}
						canEditAccess={activeCanEditAccess}
						isAccountMode={isAccountMode}
						memberName={memberName}
						onChangeOrg={handleChangeWorkspaceOrg}
						onOpenAccess={openEditAccessModal}
						onUseWorkspace={onUseWorkspace}
						onOpenMatter={onOpenMatter}
						onOpenSpace={onOpenSpace}
						onNotice={onNotice}
						onChanged={onRefresh}
					/>
				) : (
					<EmptyState
						compact
						title="暂无可访问的工作区"
						description="可点击左侧「+ 新建工作区」添加。"
						action={
							<Button variant="secondary" size="xs" onClick={openAddModal}>
								+ 新建工作区
							</Button>
						}
					/>
				)}
			</SplitPane>

			<ModalDialog
				open={showAddModal}
				title="登记项目 Git 工作区"
				subtitle="建议通过 Git 地址克隆到组织安全主目录；超级管理员也可按策略开放指定服务器本地目录。"
				size="sm"
				closeDisabled={submitting}
				onClose={closeAddModal}
				footer={
					<>
						<Button variant="secondary" size="sm" disabled={submitting} onClick={closeAddModal}>
							取消
						</Button>
						<Button variant="primary" size="sm" disabled={addDisabled} onClick={() => void handleAddWorkspace()}>
							{submitting
								? newWsSourceType === "cloned"
									? "正在克隆并绑定…"
									: "绑定中…"
								: newWsSourceType === "cloned"
									? "克隆并绑定"
									: "绑定工作区"}
						</Button>
					</>
				}
			>
				{allowLocalWorkspacePath && (
					<Tabs
						variant="pill"
						size="sm"
						ariaLabel="仓库接入方式"
						value={newWsSourceType}
						onChange={(id) => setNewWsSourceType(id as WorkspaceSourceType)}
						items={[
							{ id: "cloned", label: "从 Git 地址克隆到组织主目录" },
							{ id: "local", label: "指定服务器本地目录" },
						]}
					/>
				)}

				<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
					<FieldGroup label="项目名称" htmlFor={wsNameId}>
						<Input
							id={wsNameId}
							placeholder="如：order-service"
							value={newWsName}
							onChange={(e) => setNewWsName(e.target.value)}
						/>
					</FieldGroup>
					<FieldGroup label="所属组织" htmlFor={wsOrgId}>
						<Select
							id={wsOrgId}
							size="sm"
							aria-label="新仓库所属组织"
							value={newWsOrgChoice === "__standalone__" ? "__standalone__" : (resolvedNewOrgId ?? "")}
							onChange={(e) => setNewWsOrgChoice(e.target.value)}
						>
							{organizations.length === 0 ? (
								<option value="">自动归入默认组织</option>
							) : (
								organizations.map((org) => (
									<option key={org.id} value={org.id}>
										组织：{org.name}
										{org.isDefault ? "（默认）" : ""}
									</option>
								))
							)}
							{!isAccountMode && <option value="__standalone__">不归属组织（独立仓库）</option>}
						</Select>
					</FieldGroup>
				</div>

				{newWsSourceType === "cloned" ? (
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
						<FieldGroup label="Git 克隆地址（HTTPS / SSH）" htmlFor={wsCloneUrlId}>
							<Input
								id={wsCloneUrlId}
								mono
								placeholder="https://github.com/org/repo.git 或 git@github.com:org/repo.git"
								value={newWsCloneUrl}
								onChange={(e) => setNewWsCloneUrl(e.target.value)}
							/>
						</FieldGroup>
						<FieldGroup label="分支（可选）" htmlFor={wsBranchId}>
							<Input
								id={wsBranchId}
								mono
								placeholder="main"
								value={newWsBranch}
								onChange={(e) => setNewWsBranch(e.target.value)}
							/>
						</FieldGroup>
					</div>
				) : (
					<FieldGroup label="本地仓库绝对路径" htmlFor="workspace-local-path">
						<div className="flex items-center gap-2 flex-wrap sm:flex-nowrap min-w-0">
							<Input
								id="workspace-local-path"
								mono
								className="flex-1 min-w-0"
								placeholder="/Users/you/code/order-service"
								value={newWsPath}
								onChange={(e) => setNewWsPath(e.target.value)}
							/>
							<Button variant="secondary" size="md" onClick={() => setBrowsingDirectory(!browsingDirectory)}>
								选择目录
							</Button>
						</div>
						{browsingDirectory && (
							<ServerDirectoryPicker
								key={resolvedNewOrgId ?? "standalone"}
								orgId={resolvedNewOrgId}
								initialPath={newWsPath}
								onClose={() => setBrowsingDirectory(false)}
								onSelect={(path) => {
									setNewWsPath(path);
									setBrowsingDirectory(false);
								}}
							/>
						)}
					</FieldGroup>
				)}

				{resolvedNewOrgId && (
					<FieldGroup label="项目可见范围" htmlFor={wsVisibilityId}>
						<Select
							id={wsVisibilityId}
							size="sm"
							value={newWsVisibility}
							onChange={(e) => setNewWsVisibility(e.target.value as WorkspaceVisibility)}
						>
							<option value="org">组织全员可见（org）</option>
							<option value="restricted">仅勾选的组织成员可见（restricted）</option>
						</Select>
						{newWsVisibility === "restricted" && targetOrgMembers.length > 0 && (
							<div className="mt-1.5 max-h-40 overflow-y-auto border border-line rounded-md p-2 flex flex-col gap-1 bg-surface">
								{targetOrgMembers.map((m) => (
									<label
										key={m.userId}
										className="flex items-center gap-2 px-2 py-1 rounded-xs text-xs text-ink hover:bg-hover/60 cursor-pointer"
									>
										<input
											type="checkbox"
											checked={newWsAllowedUserIds.includes(m.userId)}
											onChange={(e) =>
												setNewWsAllowedUserIds((prev) =>
													e.target.checked ? [...prev, m.userId] : prev.filter((id) => id !== m.userId),
												)
											}
										/>
										<span>{m.displayName ?? m.email ?? m.userId}</span>
									</label>
								))}
							</div>
						)}
					</FieldGroup>
				)}
			</ModalDialog>

			<ModalDialog
				open={Boolean(editingAccessWs)}
				title={editingAccessWs ? `项目权限范围 · ${editingAccessWs.name}` : "项目权限范围"}
				size="sm"
				closeDisabled={savingAccess}
				onClose={() => !savingAccess && setEditingAccessWs(null)}
				footer={
					<>
						<Button
							variant="secondary"
							size="sm"
							disabled={savingAccess}
							onClick={() => setEditingAccessWs(null)}
						>
							取消
						</Button>
						<Button variant="primary" size="sm" disabled={savingAccess} onClick={() => void handleSaveAccess()}>
							{savingAccess ? "保存中…" : "保存权限"}
						</Button>
					</>
				}
			>
				{editingAccessWs && (
					<FieldGroup label="项目可见范围" htmlFor={editVisibilityId}>
						<Select
							id={editVisibilityId}
							size="sm"
							value={editVisibility}
							onChange={(e) => setEditVisibility(e.target.value as WorkspaceVisibility)}
						>
							<option value="org">组织内全部成员可见</option>
							<option value="restricted">仅指定组织成员可见</option>
						</Select>
						{editVisibility === "restricted" && editingAccessWs.orgId && (
							<div className="mt-1.5 max-h-40 overflow-y-auto border border-line rounded-md p-2 flex flex-col gap-1 bg-surface">
								{(orgMembersByOrgId[editingAccessWs.orgId] ?? []).map((m) => (
									<label
										key={m.userId}
										className="flex items-center gap-2 px-2 py-1 rounded-xs text-xs text-ink hover:bg-hover/60 cursor-pointer"
									>
										<input
											type="checkbox"
											checked={editAllowedUserIds.includes(m.userId)}
											onChange={(e) =>
												setEditAllowedUserIds((prev) =>
													e.target.checked ? [...prev, m.userId] : prev.filter((id) => id !== m.userId),
												)
											}
										/>
										<span>{m.displayName ?? m.email ?? m.userId}</span>
									</label>
								))}
							</div>
						)}
					</FieldGroup>
				)}
			</ModalDialog>
		</PageShell>
	);
}
