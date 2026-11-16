import { useState } from "react";
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
import {
	countMemberMemoriesByScope,
	defaultMemberGitName,
	formatMemberGitIdentity,
	getBotTheme,
	MEMORY_CATEGORY_LABELS,
	MEMORY_CATEGORY_VALUES,
	stripMarkdownFormatting,
} from "../../utils.ts";
import { BotFaceIcon } from "../BotFaceIcon.tsx";
import { ExperienceItemCard, ManualExperienceForm } from "../ExperienceReviewPanel.tsx";

type MemoryFilterTab = "all" | "candidate" | "verified" | "archived";

interface MemberCardProps {
	member: TeamMemberDto;
	index: number;
	template?: RoleTemplateDto;
	memories: MemberMemoryDto[];
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
	onAssignTask: (memberId: string) => void;
	onSetPrimary: (memberId: string) => Promise<void>;
	onExportMember: (memberId: string) => Promise<void>;
	onOpenMatter?: (matterId: string) => void;
	onOpenDeliverable?: (deliverableId: string) => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

/** Card displaying an AI role's identity, Git attribution, 3-tier memory inventory, and filterable experience drawer. */
export function MemberCard({
	member,
	index,
	template,
	memories,
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
	onAssignTask,
	onSetPrimary,
	onExportMember,
	onOpenMatter,
	onOpenDeliverable,
	onRefresh,
	onNotice,
	onError,
}: MemberCardProps) {
	const [editingIdentity, setEditingIdentity] = useState(false);
	const [editDisplayName, setEditDisplayName] = useState("");
	const [editRoleTitle, setEditRoleTitle] = useState("");
	const [editGitName, setEditGitName] = useState("");
	const [editGitEmail, setEditGitEmail] = useState("");
	const [editIdentitySummary, setEditIdentitySummary] = useState("");

	const [expandedMemories, setExpandedMemories] = useState(false);
	const [memoryFilter, setMemoryFilter] = useState<MemoryFilterTab>("all");
	const [scopeFilter, setScopeFilter] = useState<"all" | MemoryScope>("all");
	const [categoryFilter, setCategoryFilter] = useState<"all" | MemoryCategory>("all");
	const [showAddMemory, setShowAddMemory] = useState(false);
	const [batchApproving, setBatchApproving] = useState(false);

	const theme = getBotTheme(index);
	const scopeCounts = countMemberMemoriesByScope(memories);
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

	const openIdentityEditor = () => {
		setEditDisplayName(member.displayName);
		setEditRoleTitle(member.roleTitle);
		setEditGitName(member.gitName || defaultMemberGitName(member));
		setEditGitEmail(member.gitEmail || `${member.id}@team.local`);
		setEditIdentitySummary(member.identitySummary || "");
		setEditingIdentity(true);
	};

	const handleSaveIdentity = async () => {
		try {
			const res = await updateMemberIdentity(member.id, {
				displayName: editDisplayName.trim() || undefined,
				roleTitle: editRoleTitle.trim() || undefined,
				gitName: editGitName.trim() || undefined,
				gitEmail: editGitEmail.trim() || undefined,
				identitySummary: editIdentitySummary.trim(),
			});
			setEditingIdentity(false);
			onNotice(`已更新「${res.member.displayName}」的角色身份与 Git 署名`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleApproveAllCandidates = async () => {
		if (candidateMemories.length === 0) return;
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

	const cleanResponsibility = template?.responsibilities
		? stripMarkdownFormatting(template.responsibilities.split("\n")[0] ?? "")
		: "";
	const visibleKeywords = template?.keywords.slice(0, 3) ?? [];
	const visibleSkills = template?.skills.slice(0, 3) ?? [];
	const hiddenTagCount = Math.max(0, (template?.skills.length ?? 0) - visibleSkills.length);

	return (
		<div className="member-card">
			<div className="member-card-top">
				<div className="member-ident">
					<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="md" />
					<div className="member-ident-copy">
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
					{candidateCount > 0 && <span className="rsi-badge rsi-status-candidate">{candidateCount} 待核验</span>}
					<span className="pill">{verifiedCount} 已验证</span>
				</div>
			</div>

			<div className="member-identity-box">
				<div className="member-identity-row">
					<span className="member-identity-label">Git Author（角色署名）</span>
					<button
						type="button"
						className="btn-inline btn-xs"
						onClick={() => (editingIdentity ? setEditingIdentity(false) : openIdentityEditor())}
					>
						{editingIdentity ? "收起编辑" : "编辑身份"}
					</button>
				</div>
				<div className="member-git-pill" title={`提交代码时以此成员身份作 Git Author：${gitIdentity.formatted}`}>
					{gitIdentity.formatted}
				</div>
				{activeWorkspace?.repoGitUser && (
					<div
						className="member-committer-line"
						title={`保留当前仓库真实用户作 Git Committer：${activeWorkspace.repoGitUser.name} <${activeWorkspace.repoGitUser.email}>`}
					>
						Committer：{activeWorkspace.repoGitUser.name} &lt;{activeWorkspace.repoGitUser.email}&gt;
					</div>
				)}
				{member.identitySummary && <div className="member-summary-line">{member.identitySummary}</div>}
				<div className="member-memory-tiers">
					<span className="pill">岗位 {scopeCounts.roleGeneral}</span>
					<span className="pill">组织 {scopeCounts.companyPrivate}</span>
					<span className="pill">仓库 {scopeCounts.projectPrivate}</span>
					<span
						className="pill"
						title={
							template?.tools.length
								? `声明工具：${template.tools.join(", ")}`
								: "无文件系统或命令行工具（纯分析与文稿协同）"
						}
					>
						{template?.tools.includes("edit") || template?.tools.includes("bash")
							? "读写与命令"
							: template?.tools.includes("read")
								? "只读核查"
								: "纯思考文稿"}
					</span>
					{(template?.antiJobs?.length ?? 0) > 0 && (
						<span className="pill" title={template!.antiJobs!.join("；")}>
							边界 {template!.antiJobs!.length}
						</span>
					)}
				</div>
			</div>

			{editingIdentity && (
				<div className="memory-draft-box identity-form-box compact">
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
						<span className="identity-field-label">角色定位与专长补充（私有，不随公开模板导出）</span>
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
						<div className="form-grid compact">
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
					<div className="actions-row tight">
						<button type="button" className="btn-pill-dark btn-xs" onClick={() => void handleSaveIdentity()}>
							保存身份
						</button>
						<button type="button" className="btn-pill-outline btn-xs" onClick={() => setEditingIdentity(false)}>
							取消
						</button>
					</div>
				</div>
			)}

			{cleanResponsibility && (
				<p className="member-resp" title={cleanResponsibility}>
					{cleanResponsibility}
				</p>
			)}

			{(visibleKeywords.length > 0 || visibleSkills.length > 0) && (
				<div className="tag-list">
					{visibleKeywords.map((kw) => (
						<span key={kw} className="tag-chip">
							#{kw}
						</span>
					))}
					{visibleSkills.map((sk) => (
						<span key={sk} className="tag-chip skill">
							{sk}
						</span>
					))}
					{hiddenTagCount > 0 && <span className="tag-chip">+{hiddenTagCount}</span>}
				</div>
			)}

			<div className="member-card-footer">
				<div className="member-footer-primary">
					<button type="button" className="btn-pill-dark btn-xs" onClick={() => onAssignTask(member.id)}>
						向 TA 派活
					</button>
					<button
						type="button"
						className="btn-pill-outline btn-xs"
						onClick={() => setExpandedMemories((prev) => !prev)}
					>
						{expandedMemories ? "收起经验" : `管理经验 (${memories.length})`}
					</button>
				</div>
				<div className="member-footer-secondary">
					{!member.isPrimaryContact && (
						<button type="button" className="btn-inline btn-xs" onClick={() => void onSetPrimary(member.id)}>
							设为主联系
						</button>
					)}
					<button type="button" className="btn-inline btn-xs" onClick={() => void onExportMember(member.id)}>
						导出能力包
					</button>
				</div>
			</div>

			{expandedMemories && (
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
									disabled={batchApproving}
									onClick={() => void handleApproveAllCandidates()}
								>
									{batchApproving ? "核验中..." : `全部通过 (${candidateCount})`}
								</button>
							)}
							<button
								type="button"
								className="btn-pill-outline btn-xs"
								onClick={() => setShowAddMemory((prev) => !prev)}
							>
								{showAddMemory ? "取消录入" : "+ 录入经验"}
							</button>
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
	);
}
