import { type ChangeEvent, useMemo, useState } from "react";
import {
	type CollaboratorDto,
	createCollaborator,
	createMember,
	createOrganization,
	deleteCollaborator,
	exportMemberPackage,
	importMemberPackage,
	type MatterDto,
	type MemberMemoryDto,
	type MemoryCategory,
	type MemoryScope,
	type MemoryStatus,
	type OrganizationDto,
	type RoleTemplateDto,
	regenerateCollaboratorToken,
	setDefaultOrganization,
	setPrimaryMember,
	type TeamMemberDto,
	updateMemberIdentity,
	updateMemberMemory,
	updateOrganization,
	type WorkspaceDto,
} from "../api.ts";
import {
	countMemberMemoriesByScope,
	defaultMemberGitName,
	formatMemberGitIdentity,
	getBotTheme,
	MEMORY_CATEGORY_LABELS,
	MEMORY_CATEGORY_VALUES,
	splitTagsInput,
} from "../utils.ts";
import { BotFaceIcon } from "./BotFaceIcon.tsx";
import { ExperienceItemCard, ManualExperienceForm } from "./ExperienceReviewPanel.tsx";

interface TeamViewProps {
	currentUser?: CollaboratorDto | null;
	collaborators?: CollaboratorDto[];
	members: TeamMemberDto[];
	workspaces: WorkspaceDto[];
	organizations?: OrganizationDto[];
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
	onOpenMatter?: (matterId: string) => void;
	onOpenDeliverable?: (deliverableId: string) => void;
}

type MemoryFilterTab = "all" | "candidate" | "verified" | "archived";

export function TeamView({
	currentUser,
	collaborators = [],
	members,
	workspaces,
	organizations = [],
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
	onOpenMatter,
	onOpenDeliverable,
}: TeamViewProps) {
	const isOwner = currentUser?.permissionRole !== "collaborator";
	const [showAddCollab, setShowAddCollab] = useState(false);
	const [collabNameInput, setCollabNameInput] = useState("");
	const [collabRoleInput, setCollabRoleInput] = useState("");
	const [collabOrgInput, setCollabOrgInput] = useState("");
	const [showAddMember, setShowAddMember] = useState(false);
	const [newMemberName, setNewMemberName] = useState("");
	const [newMemberTitle, setNewMemberTitle] = useState("");
	const [newMemberResp, setNewMemberResp] = useState("");
	const [newMemberKeywords, setNewMemberKeywords] = useState("");
	const [newMemberSkills, setNewMemberSkills] = useState("");
	const [newMemberGitName, setNewMemberGitName] = useState("");
	const [newMemberGitEmail, setNewMemberGitEmail] = useState("");
	const [newMemberIdentitySummary, setNewMemberIdentitySummary] = useState("");
	const [newMemberPrimary, setNewMemberPrimary] = useState(false);

	const [showOrgForm, setShowOrgForm] = useState(false);
	const [editingOrgId, setEditingOrgId] = useState<string | null>(null);
	const [orgNameInput, setOrgNameInput] = useState("");
	const [orgDomainInput, setOrgDomainInput] = useState("");
	const [orgDescInput, setOrgDescInput] = useState("");

	const [editingIdentityMemberId, setEditingIdentityMemberId] = useState<string | null>(null);
	const [editDisplayName, setEditDisplayName] = useState("");
	const [editRoleTitle, setEditRoleTitle] = useState("");
	const [editGitName, setEditGitName] = useState("");
	const [editGitEmail, setEditGitEmail] = useState("");
	const [editIdentitySummary, setEditIdentitySummary] = useState("");

	const [showImportMember, setShowImportMember] = useState(false);
	const [importMarkdown, setImportMarkdown] = useState("");
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
	const [exportedPackage, setExportedPackage] = useState<{
		id: string;
		filename: string;
		markdown: string;
	} | null>(null);
	const [expandedMemoryMemberId, setExpandedMemoryMemberId] = useState<string | null>(null);
	const [memoryFilter, setMemoryFilter] = useState<MemoryFilterTab>("all");
	const [scopeFilter, setScopeFilter] = useState<"all" | MemoryScope>("all");
	const [categoryFilter, setCategoryFilter] = useState<"all" | MemoryCategory>("all");
	const [showAddMemoryFor, setShowAddMemoryFor] = useState<string | null>(null);
	const [batchApprovingMemberId, setBatchApprovingMemberId] = useState<string | null>(null);

	const handleApproveAllCandidates = async (member: TeamMemberDto, candidates: MemberMemoryDto[]) => {
		if (candidates.length === 0) return;
		setBatchApprovingMemberId(member.id);
		try {
			await Promise.all(candidates.map((m) => updateMemberMemory(m.id, { status: "verified" })));
			onNotice(`已将「${member.displayName}」的 ${candidates.length} 条待核验经验全部核验通过`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setBatchApprovingMemberId(null);
		}
	};

	const handleCreateMember = async () => {
		if (!newMemberName.trim() || !newMemberTitle.trim()) return;
		try {
			const res = await createMember({
				name: newMemberName.trim(),
				title: newMemberTitle.trim(),
				responsibilities: newMemberResp.trim() || undefined,
				keywords: splitTagsInput(newMemberKeywords),
				skills: splitTagsInput(newMemberSkills),
				gitName: newMemberGitName.trim() || undefined,
				gitEmail: newMemberGitEmail.trim() || undefined,
				identitySummary: newMemberIdentitySummary.trim() || undefined,
				isPrimaryContact: newMemberPrimary,
			});
			setNewMemberName("");
			setNewMemberTitle("");
			setNewMemberResp("");
			setNewMemberKeywords("");
			setNewMemberSkills("");
			setNewMemberGitName("");
			setNewMemberGitEmail("");
			setNewMemberIdentitySummary("");
			setNewMemberPrimary(false);
			setShowAddMember(false);
			onNotice(`新同事「${res.member.displayName}」已加入团队`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		}
	};

	const openCreateOrgForm = () => {
		setEditingOrgId(null);
		setOrgNameInput("");
		setOrgDomainInput("");
		setOrgDescInput("");
		setShowOrgForm(true);
	};

	const openEditOrgForm = (org: OrganizationDto) => {
		setEditingOrgId(org.id);
		setOrgNameInput(org.name);
		setOrgDomainInput(org.gitEmailDomain);
		setOrgDescInput(org.description);
		setShowOrgForm(true);
	};

	const handleSaveOrg = async () => {
		if (!orgNameInput.trim()) return;
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
				});
				onNotice(`已创建组织「${orgNameInput.trim()}」`);
			}
			setShowOrgForm(false);
			setEditingOrgId(null);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		}
	};

	const openMemberIdentityEditor = (member: TeamMemberDto) => {
		setEditingIdentityMemberId(member.id);
		setEditDisplayName(member.displayName);
		setEditRoleTitle(member.roleTitle);
		setEditGitName(member.gitName || defaultMemberGitName(member));
		setEditGitEmail(member.gitEmail || `${member.id}@team.local`);
		setEditIdentitySummary(member.identitySummary || "");
	};

	const handleSaveMemberIdentity = async (memberId: string) => {
		try {
			const res = await updateMemberIdentity(memberId, {
				displayName: editDisplayName.trim() || undefined,
				roleTitle: editRoleTitle.trim() || undefined,
				gitName: editGitName.trim() || undefined,
				gitEmail: editGitEmail.trim() || undefined,
				identitySummary: editIdentitySummary.trim(),
			});
			setEditingIdentityMemberId(null);
			onNotice(`已更新「${res.member.displayName}」的角色身份与 Git 署名`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleSetDefaultOrg = async (org: OrganizationDto) => {
		try {
			await setDefaultOrganization(org.id);
			onNotice(`已将「${org.name}」设为默认组织，新创建的仓库与组织记忆将默认归入此组织`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleSetPrimary = async (memberId: string) => {
		await setPrimaryMember(memberId);
		onNotice(`已将「${memberName(memberId)}」设为默认主联系人`);
		await onRefresh();
	};

	const handleExportMember = async (memberId: string) => {
		const pkg = await exportMemberPackage(memberId);
		setExportedPackage(pkg);
	};

	const handleImportMember = async () => {
		if (!importMarkdown.trim()) return;
		try {
			const res = await importMemberPackage(importMarkdown);
			setImportMarkdown("");
			setShowImportMember(false);
			onNotice(`已导入角色「${res.member.displayName}」`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleImportFileChange = (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result === "string") {
				setImportMarkdown(reader.result);
			}
		};
		reader.readAsText(file);
	};

	const handleDownloadExportedPackage = () => {
		if (!exportedPackage) return;
		const blob = new Blob([exportedPackage.markdown], { type: "text/markdown;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = exportedPackage.filename;
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div className="subpage-scroll">
			<div className="subpage-inner wide">
				<div className="pane-header-row">
					<div className="pane-header">
						<h1>我的团队</h1>
						<p>查看角色分工与积累经验，支持新增自定义角色，或导入导出脱敏角色能力包</p>
					</div>
					{isOwner && (
						<div className="actions-row" style={{ marginTop: 0 }}>
							<button
								type="button"
								className="btn-pill-dark"
								onClick={() => {
									setShowAddMember((v) => !v);
									setShowImportMember(false);
								}}
							>
								+ 新增角色
							</button>
							<button
								type="button"
								className="btn-pill-outline"
								onClick={() => {
									setShowImportMember((v) => !v);
									setShowAddMember(false);
								}}
							>
								导入角色包
							</button>
						</div>
					)}
				</div>

				{showAddMember && (
					<div className="deliverable-card form-card">
						<h3 className="section-title">组建新角色</h3>
						<div className="form-grid">
							<input
								className="input-field"
								placeholder="角色名称（如：架构师）"
								value={newMemberName}
								onChange={(e) => setNewMemberName(e.target.value)}
							/>
							<input
								className="input-field"
								placeholder="职位头衔（如：System Architect）"
								value={newMemberTitle}
								onChange={(e) => setNewMemberTitle(e.target.value)}
							/>
						</div>
						<textarea
							rows={2}
							className="composer-input"
							placeholder="核心职责描述（例如：负责系统架构选型、模块解耦和性能瓶颈排查）"
							value={newMemberResp}
							onChange={(e) => setNewMemberResp(e.target.value)}
						/>
						<div className="form-grid">
							<input
								className="input-field"
								placeholder="路由关键词（逗号分隔，如：架构,性能,重构）"
								value={newMemberKeywords}
								onChange={(e) => setNewMemberKeywords(e.target.value)}
							/>
							<input
								className="input-field"
								placeholder="能力技能（逗号分隔，如：architecture-review,rfc）"
								value={newMemberSkills}
								onChange={(e) => setNewMemberSkills(e.target.value)}
							/>
						</div>
						<div className="form-grid">
							<input
								className="input-field"
								placeholder="Git Author 名称（可选，默认用英文头衔或 ID）"
								value={newMemberGitName}
								onChange={(e) => setNewMemberGitName(e.target.value)}
							/>
							<input
								className="input-field"
								placeholder="Git 提交邮箱 Email（可选，默认按组织域名或 @team.local）"
								value={newMemberGitEmail}
								onChange={(e) => setNewMemberGitEmail(e.target.value)}
							/>
						</div>
						<input
							className="input-field"
							placeholder="角色背景与身份定位说明（可选，仅私有保存，导出能力包时自动脱敏）"
							value={newMemberIdentitySummary}
							onChange={(e) => setNewMemberIdentitySummary(e.target.value)}
						/>
						<div className="form-footer">
							<label className="checkbox-label">
								<input
									type="checkbox"
									checked={newMemberPrimary}
									onChange={(e) => setNewMemberPrimary(e.target.checked)}
								/>
								<span>设为默认主联系人</span>
							</label>
							<div style={{ display: "flex", gap: 8 }}>
								<button type="button" className="btn-pill-outline" onClick={() => setShowAddMember(false)}>
									取消
								</button>
								<button type="button" className="btn-pill-dark" onClick={() => void handleCreateMember()}>
									加入团队
								</button>
							</div>
						</div>
					</div>
				)}

				{showImportMember && (
					<div className="deliverable-card form-card">
						<h3 className="section-title">导入团队成员能力包（.md）</h3>
						<p className="muted-hint">
							支持粘贴或选择导出的角色 Markdown 模板。导入后立即注册到当前团队，不包含他人私有项目记忆。
						</p>
						<label className="file-upload-label">
							<span>选择本地 .md 文件：</span>
							<input type="file" accept=".md,text/markdown" onChange={handleImportFileChange} />
						</label>
						<textarea
							rows={6}
							className="composer-input mono-input"
							placeholder="粘贴角色模板 Markdown（含 --- frontmatter ---）..."
							value={importMarkdown}
							onChange={(e) => setImportMarkdown(e.target.value)}
						/>
						<div className="actions-row">
							<button type="button" className="btn-pill-dark" onClick={() => void handleImportMember()}>
								确认导入
							</button>
							<button type="button" className="btn-pill-outline" onClick={() => setShowImportMember(false)}>
								取消
							</button>
						</div>
					</div>
				)}

				{exportedPackage && (
					<div className="deliverable-card form-card">
						<div className="banner-row">
							<h3 className="section-title">已导出脱敏能力包：{exportedPackage.filename}</h3>
							<button type="button" className="btn-inline" onClick={() => setExportedPackage(null)}>
								关闭
							</button>
						</div>
						<p className="muted-hint">已自动剥离公司私有规范与项目私有记忆，仅保留角色职责、技能与工作原则。</p>
						<textarea rows={7} readOnly className="composer-input mono-input" value={exportedPackage.markdown} />
						<div className="actions-row">
							<button type="button" className="btn-pill-dark" onClick={handleDownloadExportedPackage}>
								下载 .md 文件
							</button>
							<button
								type="button"
								className="btn-pill-outline"
								onClick={() => {
									void navigator.clipboard.writeText(exportedPackage.markdown);
									onNotice("能力包 Markdown 已复制到剪贴板");
								}}
							>
								复制内容
							</button>
						</div>
					</div>
				)}

				<div className="org-strip-card">
					<div className="banner-row">
						<div>
							<strong style={{ fontSize: 14 }}>团队同事与邀请</strong>
							<span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 8 }}>
								所有者掌管代码执行、仓库切换与角色设置；同事通过专属邀请链接加入同一房间讨论、提请 AI 与验收评价
							</span>
						</div>
						<div style={{ display: "flex", gap: 8 }}>
							{!isOwner && onRestoreOwner && (
								<button type="button" className="btn-pill-outline btn-xs" onClick={onRestoreOwner}>
									恢复所有者身份
								</button>
							)}
							{isOwner && (
								<button
									type="button"
									className="btn-pill-outline btn-xs"
									onClick={() => setShowAddCollab((prev) => !prev)}
								>
									+ 新增邀请同事
								</button>
							)}
						</div>
					</div>

					<div className="collab-humans-list">
						{collaborators.map((col) => {
							const isSelf = currentUser?.id === col.id;
							const orgLabel = col.orgId
								? (organizations.find((o) => o.id === col.orgId)?.name ?? col.orgId)
								: null;
							return (
								<div key={col.id} className={`org-chip-card collab-human-card ${isSelf ? "is-default" : ""}`}>
									<div className="org-chip-head">
										<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
											<strong>{col.name}</strong>
											<span className={`pill ${col.permissionRole === "owner" ? "live" : ""}`}>
												{col.permissionRole === "owner" ? "所有者" : "协同成员"}
											</span>
											{isSelf && <span className="roster-me">当前视角</span>}
										</div>
										<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
											{isOwner && col.token && col.permissionRole !== "owner" && (
												<>
													<button
														type="button"
														className="btn-inline"
														onClick={() => {
															const inviteUrl = `${window.location.origin}/?invite=${encodeURIComponent(col.token!)}`;
															void navigator.clipboard
																.writeText(inviteUrl)
																.then(() => {
																	const lanHint =
																		window.location.hostname === "127.0.0.1" ||
																		window.location.hostname === "localhost"
																			? "（局域网访问请以 PA_HOST=0.0.0.0 启动并将域名替换为本机局域网 IP）"
																			: "";
																	onNotice(`已复制「${col.name}」的邀请链接${lanHint}`);
																})
																.catch(() => onNotice(`邀请链接：${inviteUrl}`));
														}}
													>
														复制邀请链接
													</button>
													{onPreviewAsCollaborator && (
														<button
															type="button"
															className="btn-inline"
															onClick={() => onPreviewAsCollaborator(col.token!)}
														>
															以此身份体验
														</button>
													)}
													<button
														type="button"
														className="btn-inline"
														onClick={() => {
															void regenerateCollaboratorToken(col.id)
																.then(async () => {
																	await onRefresh();
																	onNotice(`已重新生成「${col.name}」的邀请口令`);
																})
																.catch((err: unknown) =>
																	onError(err instanceof Error ? err.message : String(err)),
																);
														}}
													>
														重置口令
													</button>
													<button
														type="button"
														className="btn-inline danger"
														onClick={() => {
															void deleteCollaborator(col.id)
																.then(async () => {
																	await onRefresh();
																	onNotice(`已移除协作成员「${col.name}」`);
																})
																.catch((err: unknown) =>
																	onError(err instanceof Error ? err.message : String(err)),
																);
														}}
													>
														移除
													</button>
												</>
											)}
										</div>
									</div>
									<div className="org-chip-meta">
										<span>岗位：{col.roleTitle}</span>
										{orgLabel && <span> · 组织：{orgLabel}</span>}
									</div>
								</div>
							);
						})}
					</div>

					{showAddCollab && isOwner && (
						<div className="org-inline-form">
							<div style={{ fontWeight: 600, fontSize: 13 }}>新增协同同事并生成邀请链接</div>
							<div className="form-grid">
								<input
									className="input-field"
									placeholder="同事姓名（如：李四）"
									value={collabNameInput}
									onChange={(e) => setCollabNameInput(e.target.value)}
								/>
								<input
									className="input-field"
									placeholder="岗位/分工（如：后端研发、设计、测试）"
									value={collabRoleInput}
									onChange={(e) => setCollabRoleInput(e.target.value)}
								/>
							</div>
							<div className="actions-row" style={{ marginTop: 4 }}>
								{organizations.length > 0 && (
									<select
										className="select-pill"
										value={collabOrgInput}
										onChange={(e) => setCollabOrgInput(e.target.value)}
									>
										<option value="">组织：默认 / 不指定</option>
										{organizations.map((org) => (
											<option key={org.id} value={org.id}>
												组织：{org.name}
											</option>
										))}
									</select>
								)}
								<button
									type="button"
									className="btn-pill-dark"
									disabled={!collabNameInput.trim()}
									onClick={() => {
										void createCollaborator({
											name: collabNameInput.trim(),
											roleTitle: collabRoleInput.trim() || "协同同事",
											orgId: collabOrgInput || null,
										})
											.then(async (res) => {
												setCollabNameInput("");
												setCollabRoleInput("");
												setCollabOrgInput("");
												setShowAddCollab(false);
												await onRefresh();
												onNotice(`已创建同事「${res.collaborator.name}」并生成专属邀请链接`);
											})
											.catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
									}}
								>
									保存并生成邀请
								</button>
								<button type="button" className="btn-pill-outline" onClick={() => setShowAddCollab(false)}>
									取消
								</button>
							</div>
						</div>
					)}
				</div>

				<div className="org-strip-card">
					<div className="banner-row">
						<div>
							<strong style={{ fontSize: 14 }}>组织身份与多仓库分组</strong>
							<span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 8 }}>
								同一支全局团队成员跨组织与多仓库工作；新建仓库默认归入「默认组织」，同组织仓库共享「组织记忆」与邮箱域名
							</span>
						</div>
						{isOwner && (
							<button type="button" className="btn-pill-outline btn-xs" onClick={openCreateOrgForm}>
								+ 新建组织
							</button>
						)}
					</div>

					{organizations.length === 0 ? (
						<div className="muted-hint" style={{ margin: 0 }}>
							尚未建立组织（新建仓库时会自动创建「默认组织」）。成员按「角色 Author + 仓库真实用户
							Committer」双署名提交 Git；创建组织并在「资料与仓库」绑定后，同组织仓库共享组织记忆。
						</div>
					) : (
						<div className="org-chip-list">
							{organizations.map((org) => {
								const boundWs = workspaces.filter((ws) => ws.orgId === org.id);
								return (
									<div key={org.id} className="org-chip-card">
										<div className="org-chip-head">
											<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
												<strong style={{ fontSize: 13 }}>{org.name}</strong>
												{org.isDefault && <span className="pill live">默认组织</span>}
											</div>
											<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
												{!org.isDefault && (
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
										</div>
										<div className="org-chip-meta">
											{org.gitEmailDomain ? `Git 域名：@${org.gitEmailDomain} · ` : ""}
											{boundWs.length > 0
												? `已关联仓库：${boundWs.map((w) => w.name).join("、")}`
												: "尚未关联仓库（可在「资料与仓库」选择归属）"}
										</div>
										{org.description && <div className="org-chip-meta">{org.description}</div>}
									</div>
								);
							})}
						</div>
					)}

					{showOrgForm && (
						<div className="memory-draft-box identity-form-box">
							<div className="memory-draft-head">
								<strong>{editingOrgId ? "编辑组织身份" : "新建组织身份"}</strong>
							</div>
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
								<span className="identity-field-label">组织背景与共同准则（可选，执行时自动注入上下文）</span>
								<input
									className="input-field"
									aria-label="组织简介"
									placeholder="简要描述组织规范、协作边界或业务背景"
									value={orgDescInput}
									onChange={(e) => setOrgDescInput(e.target.value)}
								/>
							</label>
							<div className="actions-row">
								<button
									type="button"
									className="btn-pill-dark btn-xs"
									disabled={!orgNameInput.trim()}
									onClick={() => void handleSaveOrg()}
								>
									保存组织
								</button>
								<button
									type="button"
									className="btn-pill-outline btn-xs"
									onClick={() => {
										setShowOrgForm(false);
										setEditingOrgId(null);
									}}
								>
									取消
								</button>
							</div>
						</div>
					)}
				</div>

				<div className="team-grid">
					{members.map((member, idx) => {
						const tpl = templateByRoleId.get(member.templateId);
						const memories = memoriesByMember[member.id] ?? [];
						const isExpanded = expandedMemoryMemberId === member.id;
						const theme = getBotTheme(idx);
						const scopeCounts = countMemberMemoriesByScope(memories);
						const gitIdentity = formatMemberGitIdentity(member, activeOrg);
						const verifiedCount = memories.filter(
							(m) => m.status === "verified" || (!m.status && m.verified),
						).length;
						const candidateMemories = memories.filter(
							(m) => m.status === "candidate" || (!m.status && !m.verified),
						);
						const candidateCount = candidateMemories.length;
						const filteredMemories = memories.filter((m) => {
							const st: MemoryStatus = m.status ?? (m.verified ? "verified" : "candidate");
							if (memoryFilter === "candidate" && st !== "candidate") return false;
							if (memoryFilter === "verified" && st !== "verified") return false;
							if (memoryFilter === "archived" && st !== "rejected" && st !== "superseded") return false;
							if (scopeFilter !== "all" && m.scope !== scopeFilter) return false;
							const cat: MemoryCategory = m.category ?? "general";
							if (categoryFilter !== "all" && cat !== categoryFilter) return false;
							return true;
						});
						return (
							<div key={member.id} className="member-card">
								<div className="member-card-top">
									<div className="member-ident">
										<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="md" />
										<div>
											<div className="member-name-row">
												<strong>{member.displayName}</strong>
												{member.isPrimaryContact && <span className="pill live">默认主联系</span>}
											</div>
											<div className="member-sub">
												{member.roleTitle} · {member.model}
											</div>
										</div>
									</div>
									<div className="member-memory-badges">
										{candidateCount > 0 && (
											<span className="rsi-badge rsi-status-candidate">{candidateCount} 待核验</span>
										)}
										<span className="pill">{verifiedCount} 已验证</span>
									</div>
								</div>

								<div className="member-identity-box">
									<div className="member-identity-row">
										<span
											className="member-git-pill"
											title="提交代码时以此成员身份作为 Git Author 区分不同角色工作"
										>
											Git Author（角色）：{gitIdentity.formatted}
										</span>
										<button
											type="button"
											className="btn-inline btn-xs"
											onClick={() =>
												editingIdentityMemberId === member.id
													? setEditingIdentityMemberId(null)
													: openMemberIdentityEditor(member)
											}
										>
											{editingIdentityMemberId === member.id ? "收起身份编辑" : "编辑身份"}
										</button>
									</div>
									{activeWorkspace?.repoGitUser && (
										<div
											className="member-committer-line"
											title="提交代码时从当前仓库 git config 读取真实用户作为 Git Committer 保留"
										>
											Git Committer（真实用户）：{activeWorkspace.repoGitUser.name} &lt;
											{activeWorkspace.repoGitUser.email}&gt;
										</div>
									)}
									{member.identitySummary && (
										<div className="member-summary-line">{member.identitySummary}</div>
									)}
									<div className="member-memory-tiers">
										<span>三层记忆：</span>
										<span className="pill">岗位通用 {scopeCounts.roleGeneral}</span>
										<span className="pill">组织记忆 {scopeCounts.companyPrivate}</span>
										<span className="pill">仓库记忆 {scopeCounts.projectPrivate}</span>
									</div>
								</div>

								{editingIdentityMemberId === member.id && (
									<div className="memory-draft-box identity-form-box" style={{ marginBottom: 10 }}>
										<div className="identity-form-hint">
											Git 提交区分 Author（下列角色署名）与 Committer（自动沿用当前仓库真实用户）。
										</div>
										<div className="form-grid">
											<label className="identity-field">
												<span className="identity-field-label">Git Author 名称</span>
												<input
													className="input-field"
													aria-label="Git Author 名称"
													placeholder="如：R&D Lead"
													value={editGitName}
													onChange={(e) => setEditGitName(e.target.value)}
												/>
											</label>
											<label className="identity-field">
												<span className="identity-field-label">Git Author 邮箱</span>
												<input
													className="input-field"
													aria-label="Git Author 邮箱"
													placeholder="如：rd@acme.dev"
													value={editGitEmail}
													onChange={(e) => setEditGitEmail(e.target.value)}
												/>
											</label>
										</div>
										<label className="identity-field">
											<span className="identity-field-label">
												角色定位与专长补充（私有，不随公开模板导出）
											</span>
											<textarea
												rows={2}
												className="input-field identity-textarea"
												aria-label="角色背景与专长补充"
												placeholder="补充该角色在当前团队/项目中的分工偏好、关注重点或边界说明"
												value={editIdentitySummary}
												onChange={(e) => setEditIdentitySummary(e.target.value)}
											/>
										</label>
										<details className="identity-rename-details">
											<summary>
												修改显示名称与头衔（当前：{member.displayName} · {member.roleTitle}）
											</summary>
											<div className="form-grid" style={{ marginTop: 8 }}>
												<label className="identity-field">
													<span className="identity-field-label">团队显示名</span>
													<input
														className="input-field"
														aria-label="显示名称"
														placeholder="如：产品经理"
														value={editDisplayName}
														onChange={(e) => setEditDisplayName(e.target.value)}
													/>
												</label>
												<label className="identity-field">
													<span className="identity-field-label">职位头衔</span>
													<input
														className="input-field"
														aria-label="职位头衔"
														placeholder="如：Product Manager"
														value={editRoleTitle}
														onChange={(e) => setEditRoleTitle(e.target.value)}
													/>
												</label>
											</div>
										</details>
										<div className="actions-row" style={{ marginTop: 4 }}>
											<button
												type="button"
												className="btn-pill-dark btn-xs"
												onClick={() => void handleSaveMemberIdentity(member.id)}
											>
												保存身份
											</button>
											<button
												type="button"
												className="btn-pill-outline btn-xs"
												onClick={() => setEditingIdentityMemberId(null)}
											>
												取消
											</button>
										</div>
									</div>
								)}

								{tpl?.responsibilities && <p className="member-resp">{tpl.responsibilities.split("\n")[0]}</p>}

								{tpl && (tpl.keywords.length > 0 || tpl.skills.length > 0) && (
									<div className="tag-list">
										{tpl.keywords.slice(0, 4).map((kw) => (
											<span key={kw} className="tag-chip">
												#{kw}
											</span>
										))}
										{tpl.skills.map((sk) => (
											<span key={sk} className="tag-chip skill">
												{sk}
											</span>
										))}
									</div>
								)}

								<div className="actions-row">
									<button
										type="button"
										className="btn-pill-dark btn-xs"
										onClick={() => onAssignTask(member.id)}
									>
										向 TA 派活
									</button>
									{!member.isPrimaryContact && (
										<button
											type="button"
											className="btn-pill-outline btn-xs"
											onClick={() => void handleSetPrimary(member.id)}
										>
											设为主联系
										</button>
									)}
									<button
										type="button"
										className="btn-pill-outline btn-xs"
										onClick={() => void handleExportMember(member.id)}
									>
										导出能力包
									</button>
									<button
										type="button"
										className="btn-inline"
										onClick={() => setExpandedMemoryMemberId(isExpanded ? null : member.id)}
									>
										{isExpanded ? "收起经验" : `管理经验 (${memories.length})`}
									</button>
								</div>

								{isExpanded && (
									<div className="memory-list">
										<div className="memory-toolbar">
											<div className="memory-filter-tabs">
												{(
													[
														["all", `全部 (${memories.length})`],
														["candidate", `待核验 (${candidateCount})`],
														["verified", `已验证 (${verifiedCount})`],
														["archived", "已替代/忽略"],
													] as const
												).map(([key, label]) => (
													<button
														key={key}
														type="button"
														className={`choice-chip ${memoryFilter === key ? "active" : ""}`}
														onClick={() => setMemoryFilter(key)}
													>
														{label}
													</button>
												))}
											</div>
											<div className="memory-draft-controls">
												<select
													className="select-sm"
													aria-label="按记忆层级筛选"
													value={scopeFilter}
													onChange={(e) => setScopeFilter(e.target.value as "all" | MemoryScope)}
												>
													<option value="all">全部层级</option>
													<option value="role_general">岗位通用</option>
													<option value="company_private">组织记忆</option>
													<option value="project_private">仓库记忆</option>
												</select>
												<select
													className="select-sm"
													aria-label="按经验维度筛选"
													value={categoryFilter}
													onChange={(e) => setCategoryFilter(e.target.value as "all" | MemoryCategory)}
												>
													<option value="all">全部维度</option>
													{MEMORY_CATEGORY_VALUES.map((cat) => (
														<option key={cat} value={cat}>
															{MEMORY_CATEGORY_LABELS[cat]}
														</option>
													))}
												</select>
												{candidateCount > 0 && (
													<button
														type="button"
														className="btn-pill-dark btn-xs"
														disabled={batchApprovingMemberId === member.id}
														onClick={() => void handleApproveAllCandidates(member, candidateMemories)}
													>
														{batchApprovingMemberId === member.id
															? "核验中..."
															: `全部通过 (${candidateCount})`}
													</button>
												)}
												<button
													type="button"
													className="btn-pill-outline btn-xs"
													onClick={() =>
														setShowAddMemoryFor((prev) => (prev === member.id ? null : member.id))
													}
												>
													{showAddMemoryFor === member.id ? "取消录入" : "+ 录入经验"}
												</button>
											</div>
										</div>

										{showAddMemoryFor === member.id && (
											<ManualExperienceForm
												members={members}
												workspaces={workspaces}
												organizations={organizations}
												defaultMemberId={member.id}
												allowSelectMember={false}
												defaultWorkspaceId={defaultWorkspaceId}
												headerLabel={`为「${member.displayName}」新增经验规则`}
												onSaved={() => setShowAddMemoryFor(null)}
												onCancel={() => setShowAddMemoryFor(null)}
												onRefresh={onRefresh}
												onNotice={onNotice}
												onError={onError}
											/>
										)}

										{filteredMemories.length === 0 ? (
											<div className="memory-empty-note">当前筛选条件下暂无经验条目。</div>
										) : (
											filteredMemories.map((mem) => (
												<ExperienceItemCard
													key={mem.id}
													memory={mem}
													members={members}
													workspaces={workspaces}
													organizations={organizations}
													defaultWorkspaceId={
														(mem.sourceMatterId
															? matterWorkspaceById.get(mem.sourceMatterId)
															: undefined) ?? defaultWorkspaceId
													}
													memberName={memberName}
													workspaceName={workspaceName}
													organizationName={organizationName}
													onOpenMatter={onOpenMatter}
													onOpenDeliverable={onOpenDeliverable}
													onRefresh={onRefresh}
													onNotice={onNotice}
													onError={onError}
												/>
											))
										)}
									</div>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
