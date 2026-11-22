import { useEffect, useMemo, useState } from "react";
import type { ModelSelection } from "../api/models.ts";
import { organizationRoleModel } from "../api/organizations.ts";
import {
	type AccountUserDto,
	addOrgMember,
	createOrgInvite,
	fetchOrgInvites,
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
	updateOrgMember,
	type WorkspaceDto,
} from "../api.ts";
import { copyTextToClipboard } from "../clipboard.ts";
import { formatMemberGitIdentity } from "../utils.ts";
import { ModelPicker } from "./ModelPicker.tsx";

export const ORG_ROLE_LABEL: Record<OrgMemberRole, string> = {
	org_owner: "组织所有者",
	org_admin: "组织管理员",
	org_member: "普通成员",
	org_viewer: "只读访客",
};

interface OrganizationDetailPanelProps {
	organization: OrganizationDto;
	workspaces: WorkspaceDto[];
	businessMembers: TeamMemberDto[];
	orgMembers: OrganizationMemberDto[];
	orgAiRoles?: { configured: boolean; configs: OrganizationAiRoleConfigDto[]; effectiveMemberIds: string[] };
	isOwner: boolean;
	isSuperAdmin: boolean;
	accountUser: AccountUserDto | null;
	onEditOrg: (org: OrganizationDto) => void;
	onOpenSpace?: (spaceId: string) => void;
	onOpenWorkspaces?: () => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

/** Inline detail panel for a single organization: human members & invites, AI role activation & primary contact, and linked workspaces. */
export function OrganizationDetailPanel({
	organization,
	workspaces,
	businessMembers,
	orgMembers,
	orgAiRoles,
	isOwner,
	isSuperAdmin,
	accountUser,
	onEditOrg,
	onOpenSpace,
	onOpenWorkspaces,
	onRefresh,
	onNotice,
	onError,
}: OrganizationDetailPanelProps) {
	const [subTab, setSubTab] = useState<"members" | "roles" | "workspaces">("members");

	// Human members & invites state
	const [addMemberEmail, setAddMemberEmail] = useState("");
	const [addMemberRole, setAddMemberRole] = useState<OrgMemberRole>("org_member");
	const [addMemberTitle, setAddMemberTitle] = useState("");
	const [invites, setInvites] = useState<OrganizationInviteDto[]>([]);
	const [newInviteRole, setNewInviteRole] = useState<OrgMemberRole>("org_member");
	const [latestInviteToken, setLatestInviteToken] = useState<string | null>(null);
	const [memberBusy, setMemberBusy] = useState(false);

	// AI roles & primary contact state
	const eligibleAiMembers = useMemo(
		() =>
			businessMembers.filter(
				(m) => m.roleScope !== "personal" && (m.roleScope !== "org" || m.ownerOrgId === organization.id),
			),
		[businessMembers, organization.id],
	);

	const [draftEnabledAiIds, setDraftEnabledAiIds] = useState<string[]>([]);
	const [draftPrimaryAiId, setDraftPrimaryAiId] = useState<string>("");
	const [draftUseRoleGitIdentity, setDraftUseRoleGitIdentity] = useState(false);
	const [draftGitByMemberId, setDraftGitByMemberId] = useState<Record<string, { gitName: string; gitEmail: string }>>(
		{},
	);
	const [modelEdits, setModelEdits] = useState<Record<string, ModelSelection | null>>({});
	const [savingAiRoles, setSavingAiRoles] = useState(false);
	const [dirtyAiRoles, setDirtyAiRoles] = useState(false);

	const canManageOrg =
		isSuperAdmin ||
		organization.orgRole === "org_owner" ||
		organization.orgRole === "org_admin" ||
		(!accountUser && isOwner);
	const canSetDefault = isSuperAdmin || organization.orgRole === "org_owner" || (!accountUser && isOwner);
	const orgWorkspaces = useMemo(
		() => workspaces.filter((ws) => ws.orgId === organization.id),
		[workspaces, organization.id],
	);

	// Reset invites & sync AI draft whenever organization or its server config changes
	useEffect(() => {
		setLatestInviteToken(null);
		let cancelled = false;
		void fetchOrgInvites(organization.id)
			.then((res) => {
				if (!cancelled) setInvites(res.invites);
			})
			.catch(() => {
				if (!cancelled) setInvites([]);
			});
		return () => {
			cancelled = true;
		};
	}, [organization.id]);

	useEffect(() => {
		const enabledIds = orgAiRoles ? orgAiRoles.effectiveMemberIds : eligibleAiMembers.map((m) => m.id);
		const primaryConfig = orgAiRoles?.configs.find((c) => c.enabled && c.isPrimaryContact);
		const fallbackPrimary =
			eligibleAiMembers.find((m) => enabledIds.includes(m.id) && m.isPrimaryContact)?.id ?? enabledIds[0] ?? "";
		const gitDrafts: Record<string, { gitName: string; gitEmail: string }> = {};
		for (const m of eligibleAiMembers) {
			const cfg = orgAiRoles?.configs.find((c) => c.memberId === m.id);
			gitDrafts[m.id] = {
				gitName: cfg?.gitNameOverride ?? "",
				gitEmail: cfg?.gitEmailOverride ?? "",
			};
		}
		setDraftEnabledAiIds(enabledIds);
		setDraftPrimaryAiId(primaryConfig?.memberId ?? fallbackPrimary);
		setDraftUseRoleGitIdentity(Boolean(organization.useRoleGitIdentity));
		setDraftGitByMemberId(gitDrafts);
		setModelEdits({});
		setDirtyAiRoles(false);
	}, [organization.useRoleGitIdentity, orgAiRoles, eligibleAiMembers]);

	const handleSetDefault = async () => {
		try {
			await setDefaultOrganization(organization.id);
			onNotice(`已将「${organization.name}」设为默认组织`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleAddMember = async () => {
		if (!addMemberEmail.trim() || memberBusy) return;
		setMemberBusy(true);
		try {
			await addOrgMember(organization.id, {
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

	const handleCreateInvite = async () => {
		if (memberBusy) return;
		setMemberBusy(true);
		try {
			const res = await createOrgInvite(organization.id, {
				orgRole: newInviteRole,
				maxUses: 10,
				expiresInHours: 168,
			});
			setLatestInviteToken(res.rawToken);
			const refreshed = await fetchOrgInvites(organization.id);
			setInvites(refreshed.invites);
			onNotice("已生成组织邀请码（请立即复制，仅本次明文展示）");
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setMemberBusy(false);
		}
	};

	const handleSaveAiRoles = async () => {
		if (savingAiRoles) return;
		const configByMemberId = new Map((orgAiRoles?.configs ?? []).map((c) => [c.memberId, c]));
		setSavingAiRoles(true);
		try {
			const payload = eligibleAiMembers.map((m) => {
				const existingCfg = configByMemberId.get(m.id);
				const draftGit = draftGitByMemberId[m.id];
				return {
					memberId: m.id,
					enabled: draftEnabledAiIds.includes(m.id),
					isPrimaryContact: draftEnabledAiIds.includes(m.id) && draftPrimaryAiId === m.id,
					displayNameOverride: existingCfg?.displayNameOverride ?? null,
					providerOverride: existingCfg?.providerOverride ?? null,
					modelOverride: existingCfg?.modelOverride ?? null,
					thinkingLevelOverride: existingCfg?.thinkingLevelOverride ?? null,
					modelSelection: modelEdits[m.id],
					gitNameOverride: draftGit?.gitName.trim() || null,
					gitEmailOverride: draftGit?.gitEmail.trim() || null,
				};
			});
			await updateOrgAiRoles(organization.id, payload, { useRoleGitIdentity: draftUseRoleGitIdentity });
			setDirtyAiRoles(false);
			onNotice(`已保存「${organization.name}」的 AI 角色与主联系人配置`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setSavingAiRoles(false);
		}
	};

	const enabledCount = orgAiRoles ? orgAiRoles.effectiveMemberIds.length : eligibleAiMembers.length;

	return (
		<div className="ws-detail-panel">
			<div className="ws-detail-header">
				<div>
					<div className="ws-detail-title-row">
						<h2>{organization.name}</h2>
						{organization.isDefault && <span className="pill live">默认组织</span>}
						{organization.orgRole && <span className="pill">{ORG_ROLE_LABEL[organization.orgRole]}</span>}
					</div>
					<div className="ws-detail-sub">
						{organization.description || "同组织工作区与事项共享组织级资料空间与经验记忆"}
						{" · "}
						Git 署名：
						{organization.useRoleGitIdentity
							? `按 AI 角色署名${organization.gitEmailDomain ? `（@${organization.gitEmailDomain}）` : ""}`
							: "默认使用仓库本地配置"}
					</div>
				</div>
				<div className="ws-detail-actions">
					{onOpenSpace && (
						<button
							type="button"
							className="btn-pill-outline btn-xs"
							onClick={() => onOpenSpace(`spc_org_${organization.id}`)}
						>
							打开组织空间 ↗
						</button>
					)}
					{canManageOrg && (
						<button type="button" className="btn-pill-outline btn-xs" onClick={() => onEditOrg(organization)}>
							编辑组织
						</button>
					)}
					{canSetDefault && !organization.isDefault && (
						<button type="button" className="btn-pill-dark btn-xs" onClick={() => void handleSetDefault()}>
							设为默认
						</button>
					)}
				</div>
			</div>

			<div className="ws-detail-toolbar">
				<div className="ws-subtabs" role="tablist" aria-label="组织内容标签">
					<button
						type="button"
						role="tab"
						aria-selected={subTab === "members"}
						className={subTab === "members" ? "btn-pill-dark btn-xs" : "btn-pill-outline btn-xs"}
						onClick={() => setSubTab("members")}
					>
						成员与邀请（{orgMembers.length}）
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={subTab === "roles"}
						className={subTab === "roles" ? "btn-pill-dark btn-xs" : "btn-pill-outline btn-xs"}
						onClick={() => setSubTab("roles")}
					>
						AI 角色与主联系人（{enabledCount}）
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={subTab === "workspaces"}
						className={subTab === "workspaces" ? "btn-pill-dark btn-xs" : "btn-pill-outline btn-xs"}
						onClick={() => setSubTab("workspaces")}
					>
						关联工作区（{orgWorkspaces.length}）
					</button>
				</div>
			</div>

			{subTab === "members" && (
				<div className="ws-custom-modal">
					<section>
						<div className="ws-section-head-row">
							<h3 className="ws-section-title">组织成员（{orgMembers.length}）</h3>
							<span className="ws-section-hint">按组织成员角色控制工作区、AI 调度与管理权限</span>
						</div>
						{orgMembers.length === 0 ? (
							<div className="ui-card">
								<p className="ui-empty-note compact">
									当前组织暂无已登记账号成员；可通过下方邮箱添加或生成邀请码。
								</p>
							</div>
						) : (
							<div className="ws-folders-list">
								{orgMembers.map((m) => (
									<div key={m.userId} className="ws-folder-row">
										<div className="ws-folder-main">
											<div className="ws-folder-title">
												<strong>{m.displayName ?? m.email ?? m.userId}</strong>
												<span className="ws-role-pill">{ORG_ROLE_LABEL[m.orgRole]}</span>
												{m.roleTitle && <span className="pill">{m.roleTitle}</span>}
											</div>
											{m.email && <div className="ws-folder-path">{m.email}</div>}
										</div>
										{canManageOrg && m.userId !== accountUser?.id && (
											<div className="ws-folder-controls">
												<select
													className="select-sm select-control"
													aria-label={`修改 ${m.displayName ?? m.email ?? m.userId} 的组织角色`}
													value={m.orgRole}
													onChange={async (e) => {
														try {
															await updateOrgMember(organization.id, m.userId, {
																orgRole: e.target.value as OrgMemberRole,
															});
															onNotice("成员角色已更新");
															await onRefresh();
														} catch (err: unknown) {
															onError(err instanceof Error ? err.message : String(err));
														}
													}}
												>
													<option value="org_owner">组织所有者</option>
													<option value="org_admin">组织管理员</option>
													<option value="org_member">普通成员</option>
													<option value="org_viewer">只读访客</option>
												</select>
												<button
													type="button"
													className="btn-inline btn-danger-inline"
													onClick={async () => {
														try {
															await removeOrgMember(organization.id, m.userId);
															onNotice("已移出成员");
															await onRefresh();
														} catch (err: unknown) {
															onError(err instanceof Error ? err.message : String(err));
														}
													}}
												>
													移除
												</button>
											</div>
										)}
									</div>
								))}
							</div>
						)}
					</section>

					{canManageOrg && (
						<section>
							<div className="ws-section-head-row">
								<h3 className="ws-section-title">添加成员与邀请码</h3>
								<span className="ws-section-hint">
									已注册用户可直接按邮箱加入，未注册同事可使用邀请码注册并自动入组
								</span>
							</div>
							<div className="ws-budget-card">
								<div className="org-inline-form-row">
									<input
										className="input-field"
										style={{ flex: 2 }}
										placeholder="已注册用户邮箱，如 alice@company.com"
										value={addMemberEmail}
										onChange={(e) => setAddMemberEmail(e.target.value)}
									/>
									<input
										className="input-field"
										style={{ flex: 1 }}
										placeholder="职位头衔（可选）"
										value={addMemberTitle}
										onChange={(e) => setAddMemberTitle(e.target.value)}
									/>
									<select
										className="select-sm select-control"
										aria-label="新成员角色"
										value={addMemberRole}
										onChange={(e) => setAddMemberRole(e.target.value as OrgMemberRole)}
									>
										<option value="org_admin">组织管理员</option>
										<option value="org_member">普通成员</option>
										<option value="org_viewer">只读访客</option>
									</select>
									<button
										type="button"
										className="btn-pill-dark btn-xs"
										disabled={!addMemberEmail.trim() || memberBusy}
										onClick={() => void handleAddMember()}
									>
										添加成员
									</button>
								</div>

								<div className="ws-breakdown-group">
									<div className="ws-breakdown-row">
										<span className="ws-breakdown-title">组织邀请码（7 天有效，最多 10 次）</span>
										<div className="ws-folder-controls">
											<select
												className="select-sm select-control"
												aria-label="邀请默认角色"
												value={newInviteRole}
												onChange={(e) => setNewInviteRole(e.target.value as OrgMemberRole)}
											>
												<option value="org_member">加入为普通成员</option>
												<option value="org_admin">加入为管理员</option>
												<option value="org_viewer">加入为只读访客</option>
											</select>
											<button
												type="button"
												className="btn-pill-outline btn-xs"
												disabled={memberBusy}
												onClick={() => void handleCreateInvite()}
											>
												生成邀请码
											</button>
										</div>
									</div>

									{latestInviteToken && (
										<div className="ws-rule-card">
											<div className="ws-rule-card-head">
												<strong className="ws-rule-card-title">新生成邀请码（仅本次明文展示）</strong>
												<div className="ws-rule-card-right">
													<button
														type="button"
														className="btn-inline"
														onClick={() =>
															void copyTextToClipboard(latestInviteToken, "组织邀请码", onNotice)
														}
													>
														复制邀请码
													</button>
													<button
														type="button"
														className="btn-inline"
														onClick={() =>
															void copyTextToClipboard(
																`${window.location.origin}/?invite=${encodeURIComponent(latestInviteToken)}`,
																"邀请链接",
																onNotice,
															)
														}
													>
														复制注册链接
													</button>
												</div>
											</div>
											<div className="ws-rule-path">{latestInviteToken}</div>
										</div>
									)}

									{invites.length > 0 && (
										<div className="ws-breakdown-items">
											{invites.map((inv) => (
												<div key={inv.id} className="ws-skill-row">
													<span className="ws-skill-main">
														<strong>{inv.id.slice(0, 12)}…</strong>
														<span className="ws-muted-pill">{ORG_ROLE_LABEL[inv.orgRole]}</span>
														<span className="muted-tiny">
															已用 {inv.usedCount}/{inv.maxUses}
															{inv.revokedAt ? " · 已吊销" : ""}
														</span>
													</span>
													{!inv.revokedAt && (
														<button
															type="button"
															className="btn-inline btn-danger-inline"
															onClick={async () => {
																try {
																	await revokeOrgInvite(organization.id, inv.id);
																	const refreshed = await fetchOrgInvites(organization.id);
																	setInvites(refreshed.invites);
																	onNotice("已吊销该邀请码");
																} catch (err: unknown) {
																	onError(err instanceof Error ? err.message : String(err));
																}
															}}
														>
															吊销
														</button>
													)}
												</div>
											))}
										</div>
									)}
								</div>
							</div>
						</section>
					)}
				</div>
			)}

			{subTab === "roles" && (
				<div className="ws-custom-modal">
					<section>
						<div className="ws-section-head-row">
							<h3 className="ws-section-title">主联系人与启用角色</h3>
							<span className="ws-section-hint">新事项或未点名对话默认由本组织主联系人首接响应</span>
						</div>
						<div className="ws-budget-card">
							<div className="ws-breakdown-row">
								<span className="ws-breakdown-title">组织默认主联系人</span>
								<select
									aria-label="选择组织默认主联系人"
									className="select-sm select-control"
									disabled={!canManageOrg}
									value={draftPrimaryAiId}
									onChange={(e) => {
										setDraftPrimaryAiId(e.target.value);
										setDirtyAiRoles(true);
									}}
								>
									{eligibleAiMembers
										.filter((m) => draftEnabledAiIds.includes(m.id))
										.map((m) => (
											<option key={m.id} value={m.id}>
												{m.displayName}（{m.roleTitle}）
											</option>
										))}
								</select>
							</div>
							<label className="org-git-toggle-row">
								<input
									type="checkbox"
									disabled={!canManageOrg}
									checked={draftUseRoleGitIdentity}
									onChange={(e) => {
										setDraftUseRoleGitIdentity(e.target.checked);
										setDirtyAiRoles(true);
									}}
								/>
								<span>
									在本组织仓库执行 Git 提交时启用 AI 角色署名（Author），同时保留真实仓库用户作 Committer
								</span>
							</label>
						</div>
					</section>

					<section>
						<div className="ws-section-head-row">
							<h3 className="ws-section-title">
								AI 角色名册（已启用 {draftEnabledAiIds.length} / {eligibleAiMembers.length}）
							</h3>
							{canManageOrg && (
								<button
									type="button"
									className="btn-pill-dark btn-xs"
									disabled={savingAiRoles || !dirtyAiRoles}
									onClick={() => void handleSaveAiRoles()}
								>
									{savingAiRoles ? "保存中…" : dirtyAiRoles ? "保存角色配置" : "已同步"}
								</button>
							)}
						</div>
						<div className="ws-folders-list">
							{eligibleAiMembers.map((member) => {
								const enabled = draftEnabledAiIds.includes(member.id);
								const isPrimary = enabled && draftPrimaryAiId === member.id;
								const cfg = orgAiRoles?.configs.find((c) => c.memberId === member.id);
								const resolvedModel =
									modelEdits[member.id] !== undefined ? modelEdits[member.id] : organizationRoleModel(cfg);
								const gitIdentity = formatMemberGitIdentity(member, organization);
								const gitDraft = draftGitByMemberId[member.id] ?? { gitName: "", gitEmail: "" };
								return (
									<div key={member.id} className="ws-folder-row org-ai-role-row">
										<div className="ws-folder-main">
											<div className="ws-folder-title">
												<input
													type="checkbox"
													disabled={!canManageOrg}
													checked={enabled}
													onChange={(e) => {
														const checked = e.target.checked;
														setDraftEnabledAiIds((prev) => {
															const next = checked
																? Array.from(new Set([...prev, member.id]))
																: prev.filter((id) => id !== member.id);
															if (!checked && draftPrimaryAiId === member.id) {
																setDraftPrimaryAiId(next[0] ?? "");
															} else if (checked && !draftPrimaryAiId) {
																setDraftPrimaryAiId(member.id);
															}
															return next;
														});
														setDirtyAiRoles(true);
													}}
												/>
												<strong>{member.displayName}</strong>
												{member.roleTitle !== member.displayName && (
													<span className="muted-tiny">{member.roleTitle}</span>
												)}
												{isPrimary && <span className="pill live">主联系人</span>}
											</div>
											{enabled && draftUseRoleGitIdentity && canManageOrg && (
												<div className="org-role-git-inputs">
													<input
														className="input-field input-sm"
														placeholder={`Git Name（默认 ${gitIdentity.gitName}）`}
														value={gitDraft.gitName}
														onChange={(e) => {
															setDraftGitByMemberId((prev) => ({
																...prev,
																[member.id]: { ...gitDraft, gitName: e.target.value },
															}));
															setDirtyAiRoles(true);
														}}
													/>
													<input
														className="input-field input-sm"
														placeholder={`Git Email（默认 ${gitIdentity.gitEmail}）`}
														value={gitDraft.gitEmail}
														onChange={(e) => {
															setDraftGitByMemberId((prev) => ({
																...prev,
																[member.id]: { ...gitDraft, gitEmail: e.target.value },
															}));
															setDirtyAiRoles(true);
														}}
													/>
												</div>
											)}
										</div>
										{enabled && canManageOrg && (
											<div className="ws-folder-controls">
												<ModelPicker
													value={resolvedModel ?? null}
													inheritLabel="沿用角色默认模型"
													onChange={(next) => {
														setModelEdits((prev) => ({ ...prev, [member.id]: next }));
														setDirtyAiRoles(true);
													}}
												/>
											</div>
										)}
									</div>
								);
							})}
						</div>
					</section>
				</div>
			)}

			{subTab === "workspaces" && (
				<div className="ws-custom-modal">
					<section>
						<div className="ws-section-head-row">
							<h3 className="ws-section-title">关联工作区（{orgWorkspaces.length}）</h3>
							{onOpenWorkspaces && (
								<button type="button" className="btn-inline" onClick={onOpenWorkspaces}>
									前往工作区管理 →
								</button>
							)}
						</div>
						{orgWorkspaces.length === 0 ? (
							<div className="ui-card">
								<p className="ui-empty-note compact">
									该组织暂未关联工作区，可在「工作区」页创建或切换所属组织。
								</p>
							</div>
						) : (
							<div className="ws-folders-list">
								{orgWorkspaces.map((ws) => (
									<div key={ws.id} className="ws-folder-row">
										<div className="ws-folder-main">
											<div className="ws-folder-title">
												<strong>{ws.name}</strong>
												<span className="ws-role-pill">{ws.defaultBranch}</span>
												{ws.visibility === "restricted" && <span className="pill">仅授权成员</span>}
											</div>
											<div className="ws-folder-path">{ws.repoPath}</div>
										</div>
										{onOpenWorkspaces && (
											<button type="button" className="btn-pill-outline btn-xs" onClick={onOpenWorkspaces}>
												查看工作区
											</button>
										)}
									</div>
								))}
							</div>
						)}
					</section>
				</div>
			)}
		</div>
	);
}
