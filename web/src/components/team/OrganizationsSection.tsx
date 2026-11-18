import { useState } from "react";
import {
	type AccountUserDto,
	addOrgMember,
	createOrganization,
	createOrgInvite,
	fetchOrgInvites,
	joinOrganizationByInvite,
	type OrganizationAiRoleConfigDto,
	type OrganizationDto,
	type OrganizationInviteDto,
	type OrganizationMemberDto,
	type OrgMemberRole,
	removeOrgMember,
	revokeOrgInvite,
	setDefaultOrganization,
	type TeamMemberDto,
	updateOrgAiRoles,
	updateOrganization,
	updateOrgMember,
	type WorkspaceDto,
} from "../../api.ts";
import { copyTextToClipboard } from "../../clipboard.ts";
import { ModalDialog } from "../ModalDialog.tsx";

interface OrganizationsSectionProps {
	isOwner: boolean;
	isSuperAdmin?: boolean;
	accountUser?: AccountUserDto | null;
	organizations: OrganizationDto[];
	workspaces: WorkspaceDto[];
	businessMembers?: TeamMemberDto[];
	orgMembersByOrgId?: Record<string, OrganizationMemberDto[]>;
	orgAiRolesByOrgId?: Record<
		string,
		{ configured: boolean; configs: OrganizationAiRoleConfigDto[]; effectiveMemberIds: string[] }
	>;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

const ORG_ROLE_LABEL: Record<OrgMemberRole, string> = {
	org_owner: "组织所有者",
	org_admin: "组织管理员",
	org_member: "普通成员",
	org_viewer: "只读访客",
};

/** Manages organizations, human org membership/invites, per-org AI role activation, and workspace groupings. */
export function OrganizationsSection({
	isOwner,
	isSuperAdmin = false,
	accountUser = null,
	organizations,
	workspaces,
	businessMembers = [],
	orgMembersByOrgId = {},
	orgAiRolesByOrgId = {},
	onRefresh,
	onNotice,
	onError,
}: OrganizationsSectionProps) {
	const canCreateOrg = isSuperAdmin || (accountUser ? accountUser.status === "active" : isOwner);
	const [expanded, setExpanded] = useState(Boolean(accountUser));
	const [showOrgForm, setShowOrgForm] = useState(false);
	const [editingOrgId, setEditingOrgId] = useState<string | null>(null);
	const [orgNameInput, setOrgNameInput] = useState("");
	const [orgDomainInput, setOrgDomainInput] = useState("");
	const [orgDescInput, setOrgDescInput] = useState("");
	const [initialAiMemberIds, setInitialAiMemberIds] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);

	const [showJoinModal, setShowJoinModal] = useState(false);
	const [joinTokenInput, setJoinTokenInput] = useState("");
	const [joining, setJoining] = useState(false);

	// Sub-modal for managing one org's human members & invites
	const [membersModalOrgId, setMembersModalOrgId] = useState<string | null>(null);
	const [addMemberEmail, setAddMemberEmail] = useState("");
	const [addMemberRole, setAddMemberRole] = useState<OrgMemberRole>("org_member");
	const [addMemberTitle, setAddMemberTitle] = useState("");
	const [invitesByOrgId, setInvitesByOrgId] = useState<Record<string, OrganizationInviteDto[]>>({});
	const [newInviteRole, setNewInviteRole] = useState<OrgMemberRole>("org_member");
	const [latestInviteToken, setLatestInviteToken] = useState<string | null>(null);
	const [memberBusy, setMemberBusy] = useState(false);

	// Sub-modal for managing per-org AI roles
	const [aiModalOrgId, setAiModalOrgId] = useState<string | null>(null);
	const [draftEnabledAiIds, setDraftEnabledAiIds] = useState<string[]>([]);
	const [draftPrimaryAiId, setDraftPrimaryAiId] = useState<string>("");
	const [savingAiRoles, setSavingAiRoles] = useState(false);

	const openCreateOrgForm = () => {
		setEditingOrgId(null);
		setOrgNameInput("");
		setOrgDomainInput("");
		setOrgDescInput("");
		setInitialAiMemberIds(businessMembers.map((m) => m.id));
		setShowOrgForm(true);
	};

	const openEditOrgForm = (org: OrganizationDto) => {
		setEditingOrgId(org.id);
		setOrgNameInput(org.name);
		setOrgDomainInput(org.gitEmailDomain);
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
					description: orgDescInput.trim(),
				});
				onNotice(`组织「${orgNameInput.trim()}」已更新`);
			} else {
				await createOrganization({
					name: orgNameInput.trim(),
					gitEmailDomain: orgDomainInput.trim(),
					description: orgDescInput.trim(),
					...(businessMembers.length > 0 ? { aiMemberIds: initialAiMemberIds } : {}),
				});
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

	const handleSetDefaultOrg = async (org: OrganizationDto) => {
		try {
			await setDefaultOrganization(org.id);
			onNotice(`已将「${org.name}」设为默认组织`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleJoinOrg = async () => {
		if (!joinTokenInput.trim() || joining) return;
		setJoining(true);
		try {
			const res = await joinOrganizationByInvite(joinTokenInput.trim());
			setJoinTokenInput("");
			setShowJoinModal(false);
			onNotice(`已加入组织「${res.organization.name}」（${ORG_ROLE_LABEL[res.membership.orgRole]}）`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setJoining(false);
		}
	};

	const openMembersModal = async (orgId: string) => {
		setMembersModalOrgId(orgId);
		setLatestInviteToken(null);
		try {
			const res = await fetchOrgInvites(orgId);
			setInvitesByOrgId((prev) => ({ ...prev, [orgId]: res.invites }));
		} catch {
			// Ignore if legacy loopback without user session
		}
	};

	const handleAddOrgMember = async () => {
		if (!membersModalOrgId || !addMemberEmail.trim() || memberBusy) return;
		setMemberBusy(true);
		try {
			await addOrgMember(membersModalOrgId, {
				email: addMemberEmail.trim(),
				orgRole: addMemberRole,
				roleTitle: addMemberTitle.trim() || undefined,
			});
			setAddMemberEmail("");
			setAddMemberTitle("");
			onNotice("已添加组织成员");
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setMemberBusy(false);
		}
	};

	const handleCreateOrgInvite = async () => {
		if (!membersModalOrgId || memberBusy) return;
		setMemberBusy(true);
		try {
			const res = await createOrgInvite(membersModalOrgId, {
				orgRole: newInviteRole,
				maxUses: 10,
				expiresInHours: 168,
			});
			setLatestInviteToken(res.rawToken);
			const refreshed = await fetchOrgInvites(membersModalOrgId);
			setInvitesByOrgId((prev) => ({ ...prev, [membersModalOrgId]: refreshed.invites }));
			onNotice("已生成组织邀请码（请立即复制，仅本次明文展示）");
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setMemberBusy(false);
		}
	};

	const openAiModal = (orgId: string) => {
		const entry = orgAiRolesByOrgId[orgId];
		const enabledIds = entry ? entry.effectiveMemberIds : businessMembers.map((m) => m.id);
		const primaryConfig = entry?.configs.find((c) => c.enabled && c.isPrimaryContact);
		const fallbackPrimary =
			businessMembers.find((m) => enabledIds.includes(m.id) && m.isPrimaryContact)?.id ?? enabledIds[0] ?? "";
		setDraftEnabledAiIds(enabledIds);
		setDraftPrimaryAiId(primaryConfig?.memberId ?? fallbackPrimary);
		setAiModalOrgId(orgId);
	};

	const handleSaveAiRoles = async () => {
		if (!aiModalOrgId || savingAiRoles) return;
		setSavingAiRoles(true);
		try {
			const payload = businessMembers.map((m) => ({
				memberId: m.id,
				enabled: draftEnabledAiIds.includes(m.id),
				isPrimaryContact: draftEnabledAiIds.includes(m.id) && draftPrimaryAiId === m.id,
			}));
			await updateOrgAiRoles(aiModalOrgId, payload);
			setAiModalOrgId(null);
			onNotice("组织 AI 角色配置已保存");
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setSavingAiRoles(false);
		}
	};

	const defaultOrg = organizations.find((o) => o.isDefault) ?? organizations[0] ?? null;
	const activeModalOrg = membersModalOrgId ? (organizations.find((o) => o.id === membersModalOrgId) ?? null) : null;
	const activeAiModalOrg = aiModalOrgId ? (organizations.find((o) => o.id === aiModalOrgId) ?? null) : null;

	return (
		<section className="org-strip-card">
			<div className="ui-section-head team-admin-head">
				<div className="team-admin-summary">
					<h2 className="ui-section-title">组织、人类成员与 AI 角色（{organizations.length}）</h2>
					<span className="team-admin-meta">
						{defaultOrg ? `默认「${defaultOrg.name}」` : "尚未建立组织，可随时自主创建"}
					</span>
				</div>
				<div className="ui-row-actions">
					{accountUser && (
						<button type="button" className="btn-inline btn-xs" onClick={() => setShowJoinModal(true)}>
							+ 邀请码加入组织
						</button>
					)}
					{canCreateOrg && (
						<button type="button" className="btn-pill-outline btn-xs" onClick={openCreateOrgForm}>
							+ 新建组织
						</button>
					)}
					<button
						type="button"
						className="btn-inline btn-xs"
						aria-expanded={expanded}
						onClick={() => setExpanded((v) => !v)}
					>
						{expanded ? "收起 ▴" : canCreateOrg ? "展开管理 ▾" : "展开组织 ▾"}
					</button>
				</div>
			</div>

			{expanded && (
				<>
					<p className="ui-section-desc">
						每个组织拥有独立的成员权限、启用的 AI 角色名册、专属工作区主目录与组织级经验记忆。
					</p>
					{organizations.length === 0 ? (
						<div className="muted-hint">
							尚未加入任何组织。点击右上角「+ 新建组织」或使用团队管理员发来的组织邀请码加入已有团队。
						</div>
					) : (
						<div className="org-chip-list">
							{organizations.map((org) => {
								const boundWs = workspaces.filter((ws) => ws.orgId === org.id);
								const membersList = orgMembersByOrgId[org.id] ?? [];
								const aiEntry = orgAiRolesByOrgId[org.id];
								const activeAiCount = aiEntry ? aiEntry.effectiveMemberIds.length : businessMembers.length;
								const canManageThisOrg =
									isSuperAdmin ||
									org.orgRole === "org_owner" ||
									org.orgRole === "org_admin" ||
									(!accountUser && isOwner);
								return (
									<div key={org.id} className="org-chip-card">
										<div className="org-chip-head">
											<div className="ui-inline-head">
												<strong className="ui-chip-title">{org.name}</strong>
												{org.isDefault && <span className="pill live">默认组织</span>}
												{org.orgRole && <span className="pill">{ORG_ROLE_LABEL[org.orgRole]}</span>}
											</div>
											{canManageThisOrg && (
												<div className="ui-row-actions">
													{businessMembers.length > 0 && (
														<button
															type="button"
															className="btn-inline btn-xs"
															onClick={() => openAiModal(org.id)}
														>
															AI 角色 ({activeAiCount})
														</button>
													)}
													<button
														type="button"
														className="btn-inline btn-xs"
														onClick={() => void openMembersModal(org.id)}
													>
														人类成员 ({membersList.length})
													</button>
													{(isSuperAdmin || !accountUser) && !org.isDefault && (
														<button
															type="button"
															className="btn-inline btn-xs"
															onClick={() => void handleSetDefaultOrg(org)}
														>
															设为默认
														</button>
													)}
													<button
														type="button"
														className="btn-inline btn-xs"
														onClick={() => openEditOrgForm(org)}
													>
														编辑
													</button>
												</div>
											)}
										</div>
										<div className="org-chip-meta">
											{org.gitEmailDomain ? `Git 域名：@${org.gitEmailDomain} · ` : ""}
											{boundWs.length > 0
												? `已关联仓库：${boundWs.map((w) => w.name).join("、")}`
												: "尚未关联仓库（可在「项目仓库与资料」中克隆或绑定）"}
										</div>
										{org.workspacesDir && canManageThisOrg && (
											<div className="org-chip-meta">团队代码克隆主目录：{org.workspacesDir}</div>
										)}
										{org.description && <div className="org-chip-meta">{org.description}</div>}
									</div>
								);
							})}
						</div>
					)}
				</>
			)}

			<ModalDialog
				open={showOrgForm && canCreateOrg}
				title={editingOrgId ? "编辑组织身份" : "新建组织"}
				subtitle="归属同一组织的项目将共享组织记忆、人类成员范围与启用的 AI 角色配置。"
				size="sm"
				closeDisabled={saving}
				onClose={closeOrgModal}
				footer={
					<>
						<button type="button" className="btn-pill-outline" disabled={saving} onClick={closeOrgModal}>
							取消
						</button>
						<button
							type="button"
							className="btn-pill-dark"
							disabled={!orgNameInput.trim() || saving}
							onClick={() => void handleSaveOrg()}
						>
							{saving ? "保存中..." : "保存组织"}
						</button>
					</>
				}
			>
				<div className="form-grid">
					<label className="identity-field">
						<span className="identity-field-label">组织名称</span>
						<input
							className="input-field"
							aria-label="组织名称"
							placeholder="如：Acme Engineering"
							value={orgNameInput}
							onChange={(e) => setOrgNameInput(e.target.value)}
						/>
					</label>
					<label className="identity-field">
						<span className="identity-field-label">默认 Git 邮箱域名（可选）</span>
						<input
							className="input-field"
							aria-label="组织 Git 邮箱域名"
							placeholder="如：acme.dev"
							value={orgDomainInput}
							onChange={(e) => setOrgDomainInput(e.target.value)}
						/>
					</label>
				</div>
				<label className="identity-field">
					<span className="identity-field-label">组织背景与共同准则（可选）</span>
					<textarea
						rows={3}
						className="composer-input"
						aria-label="组织简介"
						placeholder="简要描述组织规范、协作边界或业务背景"
						value={orgDescInput}
						onChange={(e) => setOrgDescInput(e.target.value)}
					/>
				</label>
				{!editingOrgId && businessMembers.length > 0 && (
					<div className="identity-field">
						<span className="identity-field-label">本组织启用的 AI 角色</span>
						<div className="org-ai-checklist">
							{businessMembers.map((m) => {
								const checked = initialAiMemberIds.includes(m.id);
								return (
									<label key={m.id} className="org-ai-check-item">
										<input
											type="checkbox"
											checked={checked}
											onChange={(e) => {
												setInitialAiMemberIds((prev) =>
													e.target.checked ? [...prev, m.id] : prev.filter((id) => id !== m.id),
												);
											}}
										/>
										<span>{m.displayName}</span>
										<small className="muted-hint">{m.roleTitle}</small>
									</label>
								);
							})}
						</div>
					</div>
				)}
			</ModalDialog>

			<ModalDialog
				open={showJoinModal}
				title="通过邀请码加入组织"
				subtitle="输入组织管理员生成的 orginv_ 邀请码，立即成为该组织成员。"
				size="sm"
				closeDisabled={joining}
				onClose={() => !joining && setShowJoinModal(false)}
				footer={
					<>
						<button
							type="button"
							className="btn-pill-outline"
							disabled={joining}
							onClick={() => setShowJoinModal(false)}
						>
							取消
						</button>
						<button
							type="button"
							className="btn-pill-dark"
							disabled={!joinTokenInput.trim() || joining}
							onClick={() => void handleJoinOrg()}
						>
							{joining ? "加入中..." : "立即加入"}
						</button>
					</>
				}
			>
				<label className="identity-field">
					<span className="identity-field-label">组织邀请码</span>
					<input
						className="input-field"
						placeholder="粘贴 orginv_..."
						value={joinTokenInput}
						onChange={(e) => setJoinTokenInput(e.target.value)}
					/>
				</label>
			</ModalDialog>

			<ModalDialog
				open={Boolean(activeModalOrg)}
				title={activeModalOrg ? `组织人类成员管理 · ${activeModalOrg.name}` : "成员管理"}
				subtitle="配置本组织成员角色（组织管理员 / 普通成员可触发 AI / 只读访客）或签发邀请码。"
				size="md"
				onClose={() => setMembersModalOrgId(null)}
			>
				{activeModalOrg && (
					<div className="org-modal-stack">
						<div className="org-member-add-row">
							<input
								className="input-field"
								placeholder="输入已注册用户的邮箱..."
								value={addMemberEmail}
								onChange={(e) => setAddMemberEmail(e.target.value)}
							/>
							<select
								className="select-sm select-control"
								value={addMemberRole}
								onChange={(e) => setAddMemberRole(e.target.value as OrgMemberRole)}
							>
								<option value="org_member">普通成员（可触发 AI）</option>
								<option value="org_admin">组织管理员</option>
								<option value="org_viewer">只读访客</option>
							</select>
							<input
								className="input-field"
								placeholder="职位备注（可选）"
								value={addMemberTitle}
								onChange={(e) => setAddMemberTitle(e.target.value)}
							/>
							<button
								type="button"
								className="btn-pill-dark btn-xs"
								disabled={!addMemberEmail.trim() || memberBusy}
								onClick={() => void handleAddOrgMember()}
							>
								添加成员
							</button>
						</div>

						<div className="org-member-list">
							{(orgMembersByOrgId[activeModalOrg.id] ?? []).map((member) => (
								<div key={`${member.orgId}-${member.userId}`} className="org-member-row">
									<div>
										<strong>{member.displayName ?? member.email ?? member.userId}</strong>{" "}
										<span className="muted-hint">{member.email ?? ""}</span>
										{member.roleTitle && <div className="muted-hint">{member.roleTitle}</div>}
									</div>
									<div className="ui-row-actions">
										<select
											className="select-sm select-control"
											value={member.orgRole}
											onChange={(e) =>
												void updateOrgMember(activeModalOrg.id, member.userId, {
													orgRole: e.target.value as OrgMemberRole,
												})
													.then(onRefresh)
													.catch((err) => onError(err instanceof Error ? err.message : String(err)))
											}
										>
											<option value="org_owner">组织所有者</option>
											<option value="org_admin">组织管理员</option>
											<option value="org_member">普通成员</option>
											<option value="org_viewer">只读访客</option>
										</select>
										<button
											type="button"
											className="btn-inline btn-xs"
											onClick={() =>
												void removeOrgMember(activeModalOrg.id, member.userId)
													.then(() => {
														onNotice("已移除组织成员");
														return onRefresh();
													})
													.catch((err) => onError(err instanceof Error ? err.message : String(err)))
											}
										>
											移除
										</button>
									</div>
								</div>
							))}
						</div>

						<div className="org-invite-box">
							<div className="ui-inline-head">
								<strong>组织邀请码</strong>
								<select
									className="select-sm select-control"
									value={newInviteRole}
									onChange={(e) => setNewInviteRole(e.target.value as OrgMemberRole)}
								>
									<option value="org_member">邀请为普通成员</option>
									<option value="org_admin">邀请为组织管理员</option>
									<option value="org_viewer">邀请为只读访客</option>
								</select>
								<button
									type="button"
									className="btn-pill-outline btn-xs"
									disabled={memberBusy}
									onClick={() => void handleCreateOrgInvite()}
								>
									生成邀请码
								</button>
							</div>
							{latestInviteToken && (
								<div className="notice-card">
									<div className="banner-row">
										<span>新邀请码：{latestInviteToken}</span>
										<button
											type="button"
											className="btn-inline"
											onClick={() =>
												void copyTextToClipboard(
													`${window.location.origin}/?invite=${encodeURIComponent(latestInviteToken)}`,
													"组织邀请链接",
													onNotice,
												)
											}
										>
											复制邀请链接
										</button>
									</div>
								</div>
							)}
							{(invitesByOrgId[activeModalOrg.id] ?? []).slice(0, 5).map((inv) => (
								<div key={inv.id} className="muted-hint org-invite-item">
									<span>
										角色：{ORG_ROLE_LABEL[inv.orgRole]} · 已用 {inv.usedCount}/{inv.maxUses}
										{inv.revokedAt ? " · 已作废" : ""}
									</span>
									{!inv.revokedAt && (
										<button
											type="button"
											className="btn-inline btn-xs"
											onClick={() =>
												void revokeOrgInvite(activeModalOrg.id, inv.id)
													.then(() => fetchOrgInvites(activeModalOrg.id))
													.then((r) =>
														setInvitesByOrgId((prev) => ({
															...prev,
															[activeModalOrg.id]: r.invites,
														})),
													)
													.catch((err) => onError(err instanceof Error ? err.message : String(err)))
											}
										>
											作废
										</button>
									)}
								</div>
							))}
						</div>
					</div>
				)}
			</ModalDialog>

			<ModalDialog
				open={Boolean(activeAiModalOrg)}
				title={activeAiModalOrg ? `配置启用 AI 角色 · ${activeAiModalOrg.name}` : "配置 AI 角色"}
				subtitle="勾选本组织工作时允许启动、路由及委托的 AI 岗位，并指定组织主联系人。"
				size="sm"
				closeDisabled={savingAiRoles}
				onClose={() => !savingAiRoles && setAiModalOrgId(null)}
				footer={
					<>
						<button
							type="button"
							className="btn-pill-outline"
							disabled={savingAiRoles}
							onClick={() => setAiModalOrgId(null)}
						>
							取消
						</button>
						<button
							type="button"
							className="btn-pill-dark"
							disabled={savingAiRoles || draftEnabledAiIds.length === 0}
							onClick={() => void handleSaveAiRoles()}
						>
							{savingAiRoles ? "保存中..." : "保存 AI 角色配置"}
						</button>
					</>
				}
			>
				<div className="org-ai-checklist">
					{businessMembers.map((m) => {
						const enabled = draftEnabledAiIds.includes(m.id);
						return (
							<div key={m.id} className="org-ai-config-row">
								<label className="org-ai-check-item">
									<input
										type="checkbox"
										checked={enabled}
										onChange={(e) => {
											if (e.target.checked) {
												setDraftEnabledAiIds((prev) => [...prev, m.id]);
											} else {
												setDraftEnabledAiIds((prev) => prev.filter((id) => id !== m.id));
											}
										}}
									/>
									<span>
										<strong>{m.displayName}</strong> · <small className="muted-hint">{m.roleTitle}</small>
									</span>
								</label>
								{enabled && (
									<label className="org-ai-primary-radio">
										<input
											type="radio"
											name="orgPrimaryAi"
											checked={draftPrimaryAiId === m.id}
											onChange={() => setDraftPrimaryAiId(m.id)}
										/>
										<span>主联系人</span>
									</label>
								)}
							</div>
						);
					})}
				</div>
			</ModalDialog>
		</section>
	);
}
