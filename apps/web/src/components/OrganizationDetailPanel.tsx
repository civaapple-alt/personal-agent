import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Badge, Button, Card, EmptyState, Input, Select, Tabs } from "../primitives/index.ts";
import { queryKeys } from "../queries/index.ts";
import { formatMemberGitIdentity } from "../utils.ts";
import { ModelPicker } from "./ModelPicker.tsx";

const EMPTY_INVITES: OrganizationInviteDto[] = [];

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
	const queryClient = useQueryClient();
	const [subTab, setSubTab] = useState<"members" | "roles" | "workspaces">("members");

	// Human members & invites state
	const [addMemberEmail, setAddMemberEmail] = useState("");
	const [addMemberRole, setAddMemberRole] = useState<OrgMemberRole>("org_member");
	const [addMemberTitle, setAddMemberTitle] = useState("");
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

	const invitesQuery = useQuery({
		queryKey: queryKeys.organizations.invites(organization.id),
		queryFn: async () => (await fetchOrgInvites(organization.id)).invites,
		enabled: canManageOrg,
	});
	const invites = canManageOrg ? (invitesQuery.data ?? EMPTY_INVITES) : EMPTY_INVITES;

	// Reset ephemeral raw invite token when active organization changes
	useEffect(() => {
		setLatestInviteToken(null);
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
			await queryClient.invalidateQueries({ queryKey: queryKeys.organizations.invites(organization.id) });
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
		<div className="flex flex-col gap-4 min-w-0">
			<div className="flex items-start justify-between gap-3 flex-wrap pb-3 border-b border-line">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2 flex-wrap">
						<h2 className="m-0 text-lg font-semibold text-ink leading-tight">{organization.name}</h2>
						{organization.isDefault && (
							<Badge tone="success" dot>
								默认组织
							</Badge>
						)}
						{organization.orgRole && <Badge tone="neutral">{ORG_ROLE_LABEL[organization.orgRole]}</Badge>}
					</div>
					<div className="mt-1 text-xs text-ink-secondary leading-normal">
						{organization.description || "同组织工作区与事项共享组织级资料空间与经验记忆"}
						{" · "}
						Git 署名：
						{organization.useRoleGitIdentity
							? `按 AI 角色署名${organization.gitEmailDomain ? `（@${organization.gitEmailDomain}）` : ""}`
							: "默认使用仓库本地配置"}
					</div>
				</div>
				<div className="flex items-center gap-2 flex-wrap shrink-0">
					{onOpenSpace && (
						<Button variant="secondary" size="xs" onClick={() => onOpenSpace(`spc_org_${organization.id}`)}>
							打开组织空间 ↗
						</Button>
					)}
					{canManageOrg && (
						<Button variant="secondary" size="xs" onClick={() => onEditOrg(organization)}>
							编辑组织
						</Button>
					)}
					{canSetDefault && !organization.isDefault && (
						<Button variant="primary" size="xs" onClick={() => void handleSetDefault()}>
							设为默认
						</Button>
					)}
				</div>
			</div>

			<Tabs
				variant="underline"
				size="sm"
				ariaLabel="组织内容标签"
				value={subTab}
				onChange={(id) => setSubTab(id as "members" | "roles" | "workspaces")}
				items={[
					{ id: "members", label: `成员与邀请（${orgMembers.length}）` },
					{ id: "roles", label: `AI 角色与主联系人（${enabledCount}）` },
					{ id: "workspaces", label: `关联工作区（${orgWorkspaces.length}）` },
				]}
			/>

			{subTab === "members" && (
				<div className="flex flex-col gap-4">
					<section className="flex flex-col gap-2">
						<div className="flex items-center justify-between gap-2 flex-wrap">
							<h3 className="m-0 text-sm font-semibold text-ink">组织成员（{orgMembers.length}）</h3>
							<span className="text-xs text-ink-muted">按组织成员角色控制工作区、AI 调度与管理权限</span>
						</div>
						{orgMembers.length === 0 ? (
							<EmptyState
								compact
								title="当前组织暂无已登记账号成员"
								description="可通过下方邮箱添加或生成邀请码。"
							/>
						) : (
							<div className="flex flex-col gap-2">
								{orgMembers.map((m) => (
									<div
										key={m.userId}
										className="flex items-center justify-between gap-3 flex-wrap px-3 py-2 border border-line rounded-md bg-stage"
									>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2 flex-wrap">
												<strong className="text-sm font-medium text-ink">
													{m.displayName ?? m.email ?? m.userId}
												</strong>
												<Badge tone="neutral">{ORG_ROLE_LABEL[m.orgRole]}</Badge>
												{m.roleTitle && <Badge tone="neutral">{m.roleTitle}</Badge>}
											</div>
											{m.email && <div className="mt-0.5 text-xs text-ink-muted font-mono">{m.email}</div>}
										</div>
										{canManageOrg && m.userId !== accountUser?.id && (
											<div className="flex items-center gap-2 shrink-0">
												<Select
													size="sm"
													className="w-auto"
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
												</Select>
												<Button
													variant="inline"
													size="xs"
													className="text-danger-text"
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
												</Button>
											</div>
										)}
									</div>
								))}
							</div>
						)}
					</section>

					{canManageOrg && (
						<section className="flex flex-col gap-2">
							<div className="flex items-center justify-between gap-2 flex-wrap">
								<h3 className="m-0 text-sm font-semibold text-ink">添加成员与邀请码</h3>
								<span className="text-xs text-ink-muted">
									已注册用户可直接按邮箱加入，未注册同事可使用邀请码注册并自动入组
								</span>
							</div>
							<Card padding="sm" className="flex flex-col gap-3">
								<div className="grid grid-cols-1 md:grid-cols-[minmax(170px,1.4fr)_minmax(110px,1fr)_auto_auto] gap-2 items-center">
									<Input
										size="sm"
										placeholder="已注册用户邮箱，如 alice@company.com"
										value={addMemberEmail}
										onChange={(e) => setAddMemberEmail(e.target.value)}
									/>
									<Input
										size="sm"
										placeholder="职位头衔（可选）"
										value={addMemberTitle}
										onChange={(e) => setAddMemberTitle(e.target.value)}
									/>
									<Select
										size="sm"
										className="w-auto whitespace-nowrap"
										aria-label="新成员角色"
										value={addMemberRole}
										onChange={(e) => setAddMemberRole(e.target.value as OrgMemberRole)}
									>
										<option value="org_admin">组织管理员</option>
										<option value="org_member">普通成员</option>
										<option value="org_viewer">只读访客</option>
									</Select>
									<Button
										variant="primary"
										size="xs"
										disabled={!addMemberEmail.trim() || memberBusy}
										onClick={() => void handleAddMember()}
									>
										添加成员
									</Button>
								</div>

								<div className="pt-2.5 border-t border-dashed border-line flex flex-col gap-2.5">
									<div className="flex items-center justify-between gap-2 flex-wrap">
										<span className="text-xs font-medium text-ink">组织邀请码（7 天有效，最多 10 次）</span>
										<div className="flex items-center gap-2">
											<Select
												size="sm"
												className="w-auto"
												aria-label="邀请默认角色"
												value={newInviteRole}
												onChange={(e) => setNewInviteRole(e.target.value as OrgMemberRole)}
											>
												<option value="org_member">加入为普通成员</option>
												<option value="org_admin">加入为管理员</option>
												<option value="org_viewer">加入为只读访客</option>
											</Select>
											<Button
												variant="secondary"
												size="xs"
												disabled={memberBusy}
												onClick={() => void handleCreateInvite()}
											>
												生成邀请码
											</Button>
										</div>
									</div>

									{latestInviteToken && (
										<div className="bg-sidebar border border-line-strong rounded-md p-2.5 flex flex-col gap-1.5">
											<div className="flex items-center justify-between gap-2 flex-wrap">
												<strong className="text-xs text-ink">新生成邀请码（仅本次明文展示）</strong>
												<div className="flex items-center gap-2">
													<Button
														variant="inline"
														size="xs"
														onClick={() =>
															void copyTextToClipboard(latestInviteToken, "组织邀请码", onNotice)
														}
													>
														复制邀请码
													</Button>
													<Button
														variant="inline"
														size="xs"
														onClick={() =>
															void copyTextToClipboard(
																`${window.location.origin}/?invite=${encodeURIComponent(latestInviteToken)}`,
																"邀请链接",
																onNotice,
															)
														}
													>
														复制注册链接
													</Button>
												</div>
											</div>
											<div className="font-mono text-xs text-ink-secondary break-all">
												{latestInviteToken}
											</div>
										</div>
									)}

									{invites.length > 0 && (
										<div className="flex flex-col gap-1.5">
											{invites.map((inv) => (
												<div
													key={inv.id}
													className="flex items-center justify-between gap-2 flex-wrap px-2.5 py-1.5 rounded-sm bg-sidebar border border-line text-xs"
												>
													<span className="flex items-center gap-2 flex-wrap">
														<strong className="font-mono text-ink">{inv.id.slice(0, 12)}…</strong>
														<Badge tone="neutral">{ORG_ROLE_LABEL[inv.orgRole]}</Badge>
														<span className="text-micro text-ink-muted">
															已用 {inv.usedCount}/{inv.maxUses}
															{inv.revokedAt ? " · 已吊销" : ""}
														</span>
													</span>
													{!inv.revokedAt && (
														<Button
															variant="inline"
															size="xs"
															className="text-danger-text"
															onClick={async () => {
																try {
																	await revokeOrgInvite(organization.id, inv.id);
																	await queryClient.invalidateQueries({
																		queryKey: queryKeys.organizations.invites(organization.id),
																	});
																	onNotice("已吊销该邀请码");
																} catch (err: unknown) {
																	onError(err instanceof Error ? err.message : String(err));
																}
															}}
														>
															吊销
														</Button>
													)}
												</div>
											))}
										</div>
									)}
								</div>
							</Card>
						</section>
					)}
				</div>
			)}

			{subTab === "roles" && (
				<div className="flex flex-col gap-4">
					<section className="flex flex-col gap-2">
						<div className="flex items-center justify-between gap-2 flex-wrap">
							<h3 className="m-0 text-sm font-semibold text-ink">主联系人与启用角色</h3>
							<span className="text-xs text-ink-muted">新事项或未点名对话默认由本组织主联系人首接响应</span>
						</div>
						<Card padding="sm" className="flex flex-col gap-2.5">
							<div className="flex items-center justify-between gap-3 flex-wrap">
								<span className="text-xs font-medium text-ink">组织默认主联系人</span>
								<Select
									aria-label="选择组织默认主联系人"
									size="sm"
									className="w-auto min-w-[200px]"
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
								</Select>
							</div>
							<label className="inline-flex items-start gap-2 text-xs text-ink cursor-pointer leading-normal">
								<input
									type="checkbox"
									className="mt-0.5 accent-accent"
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
						</Card>
					</section>

					<section className="flex flex-col gap-2">
						<div className="flex items-center justify-between gap-2 flex-wrap">
							<h3 className="m-0 text-sm font-semibold text-ink">
								AI 角色名册（已启用 {draftEnabledAiIds.length} / {eligibleAiMembers.length}）
							</h3>
							{canManageOrg && (
								<Button
									variant="primary"
									size="xs"
									disabled={savingAiRoles || !dirtyAiRoles}
									onClick={() => void handleSaveAiRoles()}
								>
									{savingAiRoles ? "保存中…" : dirtyAiRoles ? "保存角色配置" : "已同步"}
								</Button>
							)}
						</div>
						<div className="flex flex-col gap-2">
							{eligibleAiMembers.map((member) => {
								const enabled = draftEnabledAiIds.includes(member.id);
								const isPrimary = enabled && draftPrimaryAiId === member.id;
								const cfg = orgAiRoles?.configs.find((c) => c.memberId === member.id);
								const resolvedModel =
									modelEdits[member.id] !== undefined ? modelEdits[member.id] : organizationRoleModel(cfg);
								const gitIdentity = formatMemberGitIdentity(member, organization);
								const gitDraft = draftGitByMemberId[member.id] ?? { gitName: "", gitEmail: "" };
								return (
									<div
										key={member.id}
										className="flex items-start justify-between gap-3 flex-wrap px-3 py-2.5 border border-line rounded-md bg-stage"
									>
										<div className="min-w-0 flex-1 flex flex-col gap-2">
											<div className="flex items-center gap-2 flex-wrap">
												<input
													type="checkbox"
													className="accent-accent cursor-pointer"
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
												<strong className="text-sm font-medium text-ink">{member.displayName}</strong>
												{member.roleTitle !== member.displayName && (
													<span className="text-micro text-ink-muted">{member.roleTitle}</span>
												)}
												{isPrimary && (
													<Badge tone="accent" dot>
														主联系人
													</Badge>
												)}
											</div>
											{enabled && draftUseRoleGitIdentity && canManageOrg && (
												<div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
													<Input
														size="sm"
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
													<Input
														size="sm"
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
											<div className="shrink-0">
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
				<div className="flex flex-col gap-3">
					<section className="flex flex-col gap-2">
						<div className="flex items-center justify-between gap-2 flex-wrap">
							<h3 className="m-0 text-sm font-semibold text-ink">关联工作区（{orgWorkspaces.length}）</h3>
							{onOpenWorkspaces && (
								<Button variant="inline" size="xs" onClick={onOpenWorkspaces}>
									前往工作区管理 →
								</Button>
							)}
						</div>
						{orgWorkspaces.length === 0 ? (
							<EmptyState
								compact
								title="该组织暂未关联工作区"
								description="可在「工作区」页创建或切换所属组织。"
							/>
						) : (
							<div className="flex flex-col gap-2">
								{orgWorkspaces.map((ws) => (
									<div
										key={ws.id}
										className="flex items-center justify-between gap-3 flex-wrap px-3 py-2 border border-line rounded-md bg-stage"
									>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2 flex-wrap">
												<strong className="text-sm font-medium text-ink">{ws.name}</strong>
												<Badge tone="neutral">{ws.defaultBranch}</Badge>
												{ws.visibility === "restricted" && <Badge tone="warn">仅授权成员</Badge>}
											</div>
											<div className="mt-0.5 font-mono text-xs text-ink-muted truncate">{ws.repoPath}</div>
										</div>
										{onOpenWorkspaces && (
											<Button variant="secondary" size="xs" onClick={onOpenWorkspaces}>
												查看工作区
											</Button>
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
