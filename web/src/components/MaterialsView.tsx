import { useState } from "react";
import {
	addWorkspace,
	type OrganizationDto,
	type OrganizationMemberDto,
	updateWorkspace,
	type WorkspaceDto,
	type WorkspaceSourceType,
	type WorkspaceVisibility,
} from "../api.ts";
import { copyTextToClipboard } from "../clipboard.ts";
import { ModalDialog } from "./ModalDialog.tsx";

interface MaterialsViewProps {
	workspaces: WorkspaceDto[];
	organizations: OrganizationDto[];
	orgMembersByOrgId?: Record<string, OrganizationMemberDto[]>;
	selectedWorkspaceId: string;
	allowLocalWorkspacePath?: boolean;
	isAccountMode?: boolean;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
	onUseWorkspace: (workspaceId: string) => void;
}

export function MaterialsView({
	workspaces,
	organizations,
	orgMembersByOrgId = {},
	selectedWorkspaceId,
	allowLocalWorkspacePath = true,
	isAccountMode = false,
	onRefresh,
	onNotice,
	onError,
	onUseWorkspace,
}: MaterialsViewProps) {
	const defaultOrganization = organizations.find((o) => o.isDefault) ?? organizations[0] ?? null;
	const [showAddModal, setShowAddModal] = useState(false);
	const [newWsName, setNewWsName] = useState("");
	const [newWsSourceType, setNewWsSourceType] = useState<WorkspaceSourceType>(
		!allowLocalWorkspacePath || isAccountMode ? "cloned" : "local",
	);
	const [newWsCloneUrl, setNewWsCloneUrl] = useState("");
	const [newWsBranch, setNewWsBranch] = useState("");
	const [newWsPath, setNewWsPath] = useState("");
	const [newWsOrgChoice, setNewWsOrgChoice] = useState<string>("");
	const [newWsVisibility, setNewWsVisibility] = useState<WorkspaceVisibility>("org");
	const [newWsAllowedUserIds, setNewWsAllowedUserIds] = useState<string[]>([]);
	const [submitting, setSubmitting] = useState(false);

	// Visibility edit modal
	const [editingAccessWs, setEditingAccessWs] = useState<WorkspaceDto | null>(null);
	const [editVisibility, setEditVisibility] = useState<WorkspaceVisibility>("org");
	const [editAllowedUserIds, setEditAllowedUserIds] = useState<string[]>([]);
	const [savingAccess, setSavingAccess] = useState(false);

	const resolvedNewOrgId =
		newWsOrgChoice === "__standalone__" ? null : newWsOrgChoice || defaultOrganization?.id || null;
	const targetOrgMembers = resolvedNewOrgId ? (orgMembersByOrgId[resolvedNewOrgId] ?? []) : [];

	const openAddModal = () => {
		setNewWsName("");
		setNewWsSourceType(!allowLocalWorkspacePath || isAccountMode ? "cloned" : "local");
		setNewWsCloneUrl("");
		setNewWsBranch("");
		setNewWsPath("");
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

	return (
		<div className="subpage-scroll">
			<div className="subpage-inner wide">
				<div className="pane-header-row">
					<div className="pane-header">
						<h1>已有资料与项目仓库</h1>
						<p>支持从 Git 地址克隆到组织主目录或绑定本地仓库；可按组织范围或指定成员控制项目访问权限。</p>
					</div>
					<div className="actions-row compact">
						<button type="button" className="btn-pill-dark" onClick={openAddModal}>
							+ 登记项目仓库
						</button>
					</div>
				</div>

				<div className="ui-sections-stack">
					<section className="ui-section">
						<div className="ui-section-head">
							<div>
								<h2 className="ui-section-title">已登记工作区（{workspaces.length}）</h2>
								<p className="ui-section-desc">
									同组织工作区共享组织记忆；受限仓库仅管理员与授权成员可见和调度
								</p>
							</div>
						</div>
						{workspaces.length === 0 ? (
							<div className="ui-card">
								<p className="ui-empty-note compact">暂无可访问的已登记仓库，可点击右上角按钮添加。</p>
								<div className="actions-row compact">
									<button type="button" className="btn-pill-outline btn-xs" onClick={openAddModal}>
										+ 登记项目仓库
									</button>
								</div>
							</div>
						) : (
							workspaces.map((ws) => {
								const org = ws.orgId ? organizations.find((o) => o.id === ws.orgId) : null;
								const isActive = selectedWorkspaceId === ws.id;
								const canManageOrg =
									!isAccountMode ||
									!org?.orgRole ||
									org.orgRole === "org_owner" ||
									org.orgRole === "org_admin";
								return (
									<div key={ws.id} className={`compact-row static${isActive ? " is-active" : ""}`}>
										<div className="ui-row-main">
											<div className="ui-row-title">
												<span>
													{ws.name} ({ws.defaultBranch})
												</span>
												{org && <span className="pill org-pill">组织：{org.name}</span>}
												{ws.sourceType === "cloned" && <span className="pill">Git 克隆</span>}
												{ws.visibility === "restricted" && <span className="pill">仅授权成员</span>}
												{isActive && <span className="pill is-active">当前已选</span>}
											</div>
											<div className="ui-row-sub">
												{ws.repoPath}
												{ws.cloneUrl ? ` · 源地址：${ws.cloneUrl}` : ""}
												{ws.repoGitUser
													? ` · Git Committer：${ws.repoGitUser.name} <${ws.repoGitUser.email}>`
													: ""}
											</div>
										</div>
										<div className="ui-row-actions">
											<button
												type="button"
												className="btn-inline"
												onClick={() => void copyTextToClipboard(ws.repoPath, "仓库路径", onNotice)}
											>
												复制路径
											</button>
											{canManageOrg && ws.orgId && (orgMembersByOrgId[ws.orgId]?.length ?? 0) > 0 && (
												<button
													type="button"
													className="btn-inline"
													onClick={() => openEditAccessModal(ws)}
												>
													权限范围
												</button>
											)}
											{organizations.length > 0 && canManageOrg && (
												<select
													className="select-sm select-control"
													aria-label={`设置 ${ws.name} 的所属组织`}
													value={ws.orgId ?? ""}
													onChange={(e) => void handleChangeWorkspaceOrg(ws.id, e.target.value)}
												>
													{!isAccountMode && <option value="">独立仓库（无组织）</option>}
													{organizations.map((item) => (
														<option key={item.id} value={item.id}>
															组织：{item.name}
														</option>
													))}
												</select>
											)}
											<button
												type="button"
												className={`${isActive ? "btn-pill-dark" : "btn-pill-outline"} btn-xs`}
												onClick={() => onUseWorkspace(ws.id)}
											>
												{isActive ? "当前已选 · 新建任务 →" : "在此仓库派活 →"}
											</button>
										</div>
									</div>
								);
							})
						)}
					</section>
				</div>
			</div>

			<ModalDialog
				open={showAddModal}
				title="登记项目 Git 工作区"
				subtitle="建议通过 Git 地址克隆到组织安全主目录；超级管理员也可按策略开放指定服务器本地目录。"
				size="sm"
				closeDisabled={submitting}
				onClose={closeAddModal}
				footer={
					<>
						<button type="button" className="btn-pill-outline" disabled={submitting} onClick={closeAddModal}>
							取消
						</button>
						<button
							type="button"
							className="btn-pill-dark"
							disabled={addDisabled}
							onClick={() => void handleAddWorkspace()}
						>
							{submitting
								? newWsSourceType === "cloned"
									? "正在克隆并绑定…"
									: "绑定中…"
								: newWsSourceType === "cloned"
									? "克隆并绑定"
									: "绑定工作区"}
						</button>
					</>
				}
			>
				{allowLocalWorkspacePath && (
					<div className="auth-tab-strip" role="tablist" aria-label="仓库接入方式">
						<button
							type="button"
							role="tab"
							aria-selected={newWsSourceType === "cloned"}
							className={newWsSourceType === "cloned" ? "auth-tab active" : "auth-tab"}
							onClick={() => setNewWsSourceType("cloned")}
						>
							从 Git 地址克隆到组织主目录
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={newWsSourceType === "local"}
							className={newWsSourceType === "local" ? "auth-tab active" : "auth-tab"}
							onClick={() => setNewWsSourceType("local")}
						>
							指定服务器本地目录
						</button>
					</div>
				)}

				<div className="form-grid">
					<label className="identity-field">
						<span className="identity-field-label">项目名称</span>
						<input
							className="input-field"
							placeholder="如：order-service"
							value={newWsName}
							onChange={(e) => setNewWsName(e.target.value)}
						/>
					</label>
					<label className="identity-field">
						<span className="identity-field-label">所属组织</span>
						<select
							className="select-sm select-control"
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
						</select>
					</label>
				</div>

				{newWsSourceType === "cloned" ? (
					<div className="form-grid">
						<label className="identity-field">
							<span className="identity-field-label">Git 克隆地址（HTTPS / SSH）</span>
							<input
								className="input-field"
								placeholder="https://github.com/org/repo.git 或 git@github.com:org/repo.git"
								value={newWsCloneUrl}
								onChange={(e) => setNewWsCloneUrl(e.target.value)}
							/>
						</label>
						<label className="identity-field">
							<span className="identity-field-label">分支（可选）</span>
							<input
								className="input-field"
								placeholder="main"
								value={newWsBranch}
								onChange={(e) => setNewWsBranch(e.target.value)}
							/>
						</label>
					</div>
				) : (
					<label className="identity-field">
						<span className="identity-field-label">本地仓库绝对路径</span>
						<input
							className="input-field"
							placeholder="/Users/you/code/order-service"
							value={newWsPath}
							onChange={(e) => setNewWsPath(e.target.value)}
						/>
					</label>
				)}

				{resolvedNewOrgId && (
					<div className="identity-field">
						<span className="identity-field-label">项目可见范围</span>
						<select
							className="select-sm select-control"
							value={newWsVisibility}
							onChange={(e) => setNewWsVisibility(e.target.value as WorkspaceVisibility)}
						>
							<option value="org">组织全员可见（org）</option>
							<option value="restricted">仅勾选的组织成员可见（restricted）</option>
						</select>
						{newWsVisibility === "restricted" && targetOrgMembers.length > 0 && (
							<div className="org-ai-checklist">
								{targetOrgMembers.map((m) => (
									<label key={m.userId} className="org-ai-check-item">
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
					</div>
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
						<button
							type="button"
							className="btn-pill-outline"
							disabled={savingAccess}
							onClick={() => setEditingAccessWs(null)}
						>
							取消
						</button>
						<button
							type="button"
							className="btn-pill-dark"
							disabled={savingAccess}
							onClick={() => void handleSaveAccess()}
						>
							{savingAccess ? "保存中…" : "保存权限"}
						</button>
					</>
				}
			>
				{editingAccessWs && (
					<div className="identity-field">
						<label className="identity-field">
							<span className="identity-field-label">项目可见范围</span>
							<select
								className="select-sm select-control"
								value={editVisibility}
								onChange={(e) => setEditVisibility(e.target.value as WorkspaceVisibility)}
							>
								<option value="org">组织内全部成员可见</option>
								<option value="restricted">仅指定组织成员可见</option>
							</select>
						</label>
						{editVisibility === "restricted" && editingAccessWs.orgId && (
							<div className="org-ai-checklist">
								{(orgMembersByOrgId[editingAccessWs.orgId] ?? []).map((m) => (
									<label key={m.userId} className="org-ai-check-item">
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
					</div>
				)}
			</ModalDialog>
		</div>
	);
}
