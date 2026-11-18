import { useEffect, useState } from "react";
import {
	type MemberMemoryDto,
	type MemoryCategory,
	type MemoryScope,
	type MemoryStatus,
	type OrganizationDto,
	type RoleTemplateDto,
	type TeamMemberDto,
	updateMemberIdentity,
	updateMemberMemory,
	type WorkspaceDto,
} from "../../api.ts";
import { getMemberScopeBadge } from "../../architectApi.ts";
import {
	defaultMemberGitName,
	formatMemberGitIdentity,
	getBotTheme,
	MEMORY_CATEGORY_LABELS,
	MEMORY_CATEGORY_VALUES,
} from "../../utils.ts";
import { BotFaceIcon } from "../BotFaceIcon.tsx";
import { ExperienceItemCard, ManualExperienceForm } from "../ExperienceReviewPanel.tsx";

type MemoryFilterTab = "all" | "candidate" | "verified" | "archived";

interface MemberInspectorModalProps {
	member: TeamMemberDto | null;
	memberIndex: number;
	template?: RoleTemplateDto;
	memories: MemberMemoryDto[];
	initialTab: "identity" | "memories";
	canEditIdentity?: boolean;
	canCurateMemories?: boolean;
	members: TeamMemberDto[];
	workspaces: WorkspaceDto[];
	organizations: OrganizationDto[];
	activeWorkspace: WorkspaceDto | null;
	activeOrg: OrganizationDto | null;
	defaultWorkspaceId: string | null;
	matterWorkspaceById: Map<string, string | null>;
	memberName: (id: string) => string;
	workspaceName: (id: string | null) => string | null;
	organizationName?: (id: string | null) => string | null;
	onClose: () => void;
	onOpenMatter?: (matterId: string) => void;
	onOpenDeliverable?: (deliverableId: string) => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

/** Spacious modal for editing member identity/Git author and curating three-scope member memories without distorting team grid cards. */
export function MemberInspectorModal({
	member,
	memberIndex,
	template,
	memories,
	initialTab,
	canEditIdentity = true,
	canCurateMemories = true,
	members,
	workspaces,
	organizations,
	activeWorkspace,
	activeOrg,
	defaultWorkspaceId,
	matterWorkspaceById,
	memberName,
	workspaceName,
	organizationName,
	onClose,
	onOpenMatter,
	onOpenDeliverable,
	onRefresh,
	onNotice,
	onError,
}: MemberInspectorModalProps) {
	const [tab, setTab] = useState<"identity" | "memories">(initialTab);
	const [editDisplayName, setEditDisplayName] = useState("");
	const [editRoleTitle, setEditRoleTitle] = useState("");
	const [editGitName, setEditGitName] = useState("");
	const [editGitEmail, setEditGitEmail] = useState("");
	const [editIdentitySummary, setEditIdentitySummary] = useState("");
	const [savingIdentity, setSavingIdentity] = useState(false);

	const [memoryFilter, setMemoryFilter] = useState<MemoryFilterTab>("all");
	const [scopeFilter, setScopeFilter] = useState<"all" | MemoryScope>("all");
	const [categoryFilter, setCategoryFilter] = useState<"all" | MemoryCategory>("all");
	const [showAddMemory, setShowAddMemory] = useState(false);
	const [batchApproving, setBatchApproving] = useState(false);

	useEffect(() => {
		setTab(initialTab);
	}, [initialTab]);

	useEffect(() => {
		if (!member) return;
		setEditDisplayName(member.displayName);
		setEditRoleTitle(member.roleTitle);
		setEditGitName(member.gitName || defaultMemberGitName(member));
		setEditGitEmail(member.gitEmail || `${member.id}@team.local`);
		setEditIdentitySummary(member.identitySummary || "");
		setShowAddMemory(false);
		setMemoryFilter("all");
		setScopeFilter("all");
		setCategoryFilter("all");
	}, [member]);

	if (!member) return null;

	const theme = getBotTheme(memberIndex >= 0 ? memberIndex : 0);
	const gitIdentity = formatMemberGitIdentity(member, activeOrg);
	const verifiedCount = memories.filter((m) => m.status === "verified" || (!m.status && m.verified)).length;
	const candidateMemories = memories.filter((m) => m.status === "candidate" || (!m.status && !m.verified));
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

	const handleSaveIdentity = async () => {
		if (savingIdentity) return;
		setSavingIdentity(true);
		try {
			const res = await updateMemberIdentity(member.id, {
				displayName: editDisplayName.trim() || undefined,
				roleTitle: editRoleTitle.trim() || undefined,
				gitName: editGitName.trim() || undefined,
				gitEmail: editGitEmail.trim() || undefined,
				identitySummary: editIdentitySummary.trim(),
			});
			onNotice(`已更新「${res.member.displayName}」的角色身份与 Git 署名`);
			await onRefresh();
			onClose();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setSavingIdentity(false);
		}
	};

	const handleApproveAllCandidates = async () => {
		if (candidateMemories.length === 0 || batchApproving) return;
		setBatchApproving(true);
		try {
			await Promise.all(candidateMemories.map((m) => updateMemberMemory(m.id, { status: "verified" })));
			onNotice(`已将「${member.displayName}」的 ${candidateMemories.length} 条待核验经验全部核验通过`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setBatchApproving(false);
		}
	};

	return (
		<div className="architect-modal-backdrop">
			<button type="button" className="architect-modal-scrim" aria-label="关闭弹窗" onClick={onClose} />
			<div className="architect-modal-card" role="dialog" aria-modal="true" aria-label="成员详情管理">
				<div className="banner-row">
					<div className="member-ident">
						<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="md" />
						<div className="member-ident-copy">
							<div className="member-name-row">
								<strong>{member.displayName}</strong>
								{member.isPrimaryContact && <span className="pill live">默认主联系</span>}
								<span
									className={`pill role-scope-pill is-${getMemberScopeBadge(member, organizationName).scope}`}
								>
									{getMemberScopeBadge(member, organizationName).label}
								</span>
							</div>
							<div className="member-sub">
								{member.roleTitle} · {member.model} · ID：{member.id}
							</div>
						</div>
					</div>
					<button type="button" className="btn-inline" onClick={onClose}>
						关闭
					</button>
				</div>

				<div className="architect-tabs" role="tablist" aria-label="成员管理视图切换">
					<button
						type="button"
						role="tab"
						aria-selected={tab === "identity"}
						className={`choice-chip ${tab === "identity" ? "active" : ""}`}
						onClick={() => setTab("identity")}
					>
						身份与 Git 署名
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "memories"}
						className={`choice-chip ${tab === "memories" ? "active" : ""}`}
						onClick={() => setTab("memories")}
					>
						成长经验（{memories.length}
						{candidateCount > 0 ? ` · ${candidateCount} 待核验` : ""}）
					</button>
				</div>

				{tab === "identity" ? (
					<div className="architect-form-body">
						<div className="identity-form-hint">
							Git 提交区分 Author（{gitIdentity.formatted}）与 Committer（保留当前仓库真实用户
							{activeWorkspace?.repoGitUser
								? `：${activeWorkspace.repoGitUser.name} <${activeWorkspace.repoGitUser.email}>`
								: ""}
							）。
						</div>

						<div className="form-grid">
							<label className="identity-field">
								<span className="identity-field-label">团队显示名</span>
								<input
									className="input-field"
									disabled={!canEditIdentity}
									value={editDisplayName}
									onChange={(e) => setEditDisplayName(e.target.value)}
								/>
							</label>
							<label className="identity-field">
								<span className="identity-field-label">职位头衔</span>
								<input
									className="input-field"
									disabled={!canEditIdentity}
									value={editRoleTitle}
									onChange={(e) => setEditRoleTitle(e.target.value)}
								/>
							</label>
							<label className="identity-field">
								<span className="identity-field-label">Git Author 名称</span>
								<input
									className="input-field"
									disabled={!canEditIdentity}
									placeholder="如：R&D Lead"
									value={editGitName}
									onChange={(e) => setEditGitName(e.target.value)}
								/>
							</label>
							<label className="identity-field">
								<span className="identity-field-label">Git Author 邮箱</span>
								<input
									className="input-field"
									disabled={!canEditIdentity}
									placeholder="如：rd@acme.dev"
									value={editGitEmail}
									onChange={(e) => setEditGitEmail(e.target.value)}
								/>
							</label>
						</div>

						<label className="identity-field">
							<span className="identity-field-label">角色定位与专长补充（私有，不随公开模板导出）</span>
							<textarea
								rows={3}
								className="input-field identity-textarea"
								disabled={!canEditIdentity}
								placeholder="补充该角色在当前团队/项目中的分工偏好、关注重点或边界说明"
								value={editIdentitySummary}
								onChange={(e) => setEditIdentitySummary(e.target.value)}
							/>
						</label>

						{template &&
							(template.responsibilities || template.skills.length > 0 || template.keywords.length > 0) && (
								<div className="architect-preview-pane">
									<h4>核心职责与能力标签</h4>
									{template.responsibilities && (
										<p className="architect-preview-copy">{template.responsibilities}</p>
									)}
									{(template.keywords.length > 0 || template.skills.length > 0) && (
										<div className="tag-list">
											{template.keywords.map((kw) => (
												<span key={kw} className="tag-chip">
													#{kw}
												</span>
											))}
											{template.skills.map((sk) => (
												<span key={sk} className="tag-chip skill">
													{sk}
												</span>
											))}
										</div>
									)}
								</div>
							)}

						{template?.antiJobs && template.antiJobs.length > 0 && (
							<div className="architect-preview-pane">
								<h4>当前不做边界（Anti-Jobs）</h4>
								<ul className="architect-preview-list">
									{template.antiJobs.map((rule) => (
										<li key={rule}>{rule}</li>
									))}
								</ul>
							</div>
						)}

						<div className="form-footer">
							<span className="muted-tiny">
								声明工具：{template?.tools.length ? template.tools.join(", ") : "纯分析与文稿（无工具）"}
							</span>
							<div className="ui-row-actions">
								<button type="button" className="btn-pill-outline" onClick={onClose}>
									{canEditIdentity ? "取消" : "关闭"}
								</button>
								{canEditIdentity && (
									<button
										type="button"
										className="btn-pill-dark"
										disabled={savingIdentity}
										onClick={() => void handleSaveIdentity()}
									>
										{savingIdentity ? "保存中…" : "保存身份"}
									</button>
								)}
							</div>
						</div>
					</div>
				) : (
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
								{candidateCount > 0 && canCurateMemories && (
									<button
										type="button"
										className="btn-pill-dark btn-xs"
										disabled={batchApproving}
										onClick={() => void handleApproveAllCandidates()}
									>
										{batchApproving ? "核验中..." : `全部通过 (${candidateCount})`}
									</button>
								)}
								{canCurateMemories && (
									<button
										type="button"
										className="btn-pill-outline btn-xs"
										onClick={() => setShowAddMemory((prev) => !prev)}
									>
										{showAddMemory ? "取消录入" : "+ 录入经验"}
									</button>
								)}
							</div>
						</div>

						{showAddMemory && (
							<ManualExperienceForm
								members={members}
								workspaces={workspaces}
								organizations={organizations}
								defaultMemberId={member.id}
								allowSelectMember={false}
								defaultWorkspaceId={defaultWorkspaceId}
								headerLabel={`为「${member.displayName}」新增经验规则`}
								onSaved={() => setShowAddMemory(false)}
								onCancel={() => setShowAddMemory(false)}
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
										(mem.sourceMatterId ? matterWorkspaceById.get(mem.sourceMatterId) : undefined) ??
										defaultWorkspaceId
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
		</div>
	);
}
