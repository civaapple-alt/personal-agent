import { useEffect, useState } from "react";
import {
	deleteMember,
	fetchMemberSkillDetail,
	type MemberSkillDetailDto,
	type OrganizationDto,
	type RoleTemplateDto,
	type TeamMemberDto,
	updateMemberIdentity,
	type WorkspaceDto,
} from "../../api.ts";
import { getMemberScopeBadge, isArchitectMember } from "../../architectApi.ts";
import { MarkdownView } from "../../MarkdownView.tsx";
import { BotFaceIcon } from "../../primitives/BotFaceIcon.tsx";
import { ModalDialog } from "../../primitives/ModalDialog.tsx";
import { defaultMemberGitName, formatMemberGitIdentity, getBotTheme } from "../../utils.ts";

function formatMemberSkillLabel(skillRef: string): string {
	const roleLocal = skillRef.match(/^skills\/([^/]+)\/SKILL\.md$/);
	if (roleLocal?.[1]) return `${roleLocal[1]} · 角色专属`;
	return skillRef;
}

function extractCoreResponsibilities(raw: string, hasAntiJobsSection: boolean): string {
	const cleaned = raw
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.split(/\r?\n|(?=-\s*不做\s*\/\s*边界)/)
		.map((line) => line.replace(/^[-*]\s*/, "").trim())
		.filter((line) => {
			if (!line) return false;
			if (hasAntiJobsSection && /^不做\s*\/\s*边界[：:]/.test(line)) return false;
			return true;
		})
		.map((line) => line.replace(/^核心唯一职责[：:]\s*/, "").trim());
	return cleaned.join("\n").trim();
}

interface MemberInspectorModalProps {
	member: TeamMemberDto | null;
	memberIndex: number;
	template?: RoleTemplateDto;
	inline?: boolean;
	canEditIdentity?: boolean;
	canDispatch?: boolean;
	canSetPrimary?: boolean;
	primaryActionLabel?: string;
	isPrimary?: boolean;
	effectiveGitOverride?: { gitNameOverride?: string | null; gitEmailOverride?: string | null } | null;
	activeWorkspace: WorkspaceDto | null;
	activeOrg: OrganizationDto | null;
	organizationName?: (id: string | null) => string | null;
	onAssignTask?: (memberId: string) => void;
	onSetPrimary?: (memberId: string) => Promise<void> | void;
	onExportMember?: (memberId: string) => Promise<void> | void;
	onClose?: () => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

/** Member detail view (inline split-pane panel or modal) for inspecting role responsibilities, skills, and editing identity/Git author. */
export function MemberInspectorModal({
	member,
	memberIndex,
	template,
	inline = false,
	canEditIdentity = true,
	canDispatch = true,
	canSetPrimary = false,
	primaryActionLabel = "设为默认主联系",
	isPrimary,
	effectiveGitOverride = null,
	activeWorkspace,
	activeOrg,
	organizationName,
	onAssignTask,
	onSetPrimary,
	onExportMember,
	onClose,
	onRefresh,
	onNotice,
	onError,
}: MemberInspectorModalProps) {
	const [editDisplayName, setEditDisplayName] = useState("");
	const [editRoleTitle, setEditRoleTitle] = useState("");
	const [editGitName, setEditGitName] = useState("");
	const [editGitEmail, setEditGitEmail] = useState("");
	const [editIdentitySummary, setEditIdentitySummary] = useState("");
	const [savingIdentity, setSavingIdentity] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [previewSkillRef, setPreviewSkillRef] = useState<string | null>(null);
	const [previewSkillDetail, setPreviewSkillDetail] = useState<MemberSkillDetailDto | null>(null);
	const [previewSkillTab, setPreviewSkillTab] = useState<string>("SKILL.md");
	const [previewSkillMode, setPreviewSkillMode] = useState<"rendered" | "raw">("rendered");
	const [loadingSkill, setLoadingSkill] = useState(false);
	const [skillError, setSkillError] = useState<string | null>(null);

	useEffect(() => {
		if (!member) return;
		setEditDisplayName(member.displayName);
		setEditRoleTitle(member.roleTitle);
		setEditGitName(member.gitName || defaultMemberGitName(member));
		setEditGitEmail(member.gitEmail || `${member.id}@team.local`);
		setEditIdentitySummary(member.identitySummary || "");
		setPreviewSkillRef(null);
		setConfirmingDelete(false);
	}, [member]);

	if (!member) return null;

	const isArchitect = isArchitectMember(member) || template?.roleKind === "architect";
	const effectiveIsPrimary = isPrimary ?? member.isPrimaryContact;
	const canDeleteRole = canEditIdentity && !effectiveIsPrimary && !isArchitect;

	const handleOpenSkill = async (skillRef: string) => {
		setPreviewSkillRef(skillRef);
		setPreviewSkillDetail(null);
		setPreviewSkillTab("SKILL.md");
		setPreviewSkillMode("rendered");
		setSkillError(null);
		setLoadingSkill(true);
		try {
			const { detail } = await fetchMemberSkillDetail(member.id, skillRef);
			setPreviewSkillDetail(detail);
		} catch (err) {
			setSkillError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoadingSkill(false);
		}
	};

	const handleDelete = async () => {
		if (deleting) return;
		setDeleting(true);
		try {
			await deleteMember(member.id);
			onNotice(`已删除角色「${member.displayName}」`);
			setConfirmingDelete(false);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setDeleting(false);
		}
	};

	const theme = getBotTheme(memberIndex >= 0 ? memberIndex : 0);
	const effectiveMemberForGit =
		effectiveGitOverride?.gitNameOverride || effectiveGitOverride?.gitEmailOverride
			? {
					...member,
					gitName: effectiveGitOverride.gitNameOverride?.trim() || member.gitName,
					gitEmail: effectiveGitOverride.gitEmailOverride?.trim() || member.gitEmail,
				}
			: member;
	const gitIdentity = formatMemberGitIdentity(effectiveMemberForGit, activeOrg);

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
			if (!inline) onClose?.();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setSavingIdentity(false);
		}
	};

	const detailBody = (
		<>
			<div className="team-detail-header">
				<div className="member-ident">
					<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="lg" mood={isArchitect ? "thinking" : "idle"} />
					<div className="member-ident-copy">
						<div className="member-name-row">
							<strong>{member.displayName}</strong>
							{effectiveIsPrimary && (
								<span className="pill live">{isPrimary !== undefined ? "主联系" : "默认主联系"}</span>
							)}
							{isArchitect && <span className="pill">内置角色设计</span>}
							{(template?.roleKind === "solo" || member.id === "pi-default") && (
								<span className="pill">单兵 Pi</span>
							)}
							<span className={`pill role-scope-pill is-${getMemberScopeBadge(member, organizationName).scope}`}>
								{getMemberScopeBadge(member, organizationName).label}
							</span>
						</div>
						<div className="member-sub">
							{member.roleTitle} · ID：{member.id}
						</div>
					</div>
				</div>
				{inline ? (
					<div className="team-detail-actions">
						{canDispatch && onAssignTask && (
							<button type="button" className="btn-pill-dark btn-xs" onClick={() => onAssignTask(member.id)}>
								向 TA 派活
							</button>
						)}
						{onExportMember && (
							<button
								type="button"
								className="btn-pill-outline btn-xs"
								onClick={() => void onExportMember(member.id)}
							>
								导出角色包
							</button>
						)}
						{canSetPrimary && !effectiveIsPrimary && !isArchitect && onSetPrimary && (
							<button
								type="button"
								className="btn-pill-outline btn-xs"
								onClick={() => void onSetPrimary(member.id)}
							>
								{primaryActionLabel}
							</button>
						)}
						{canDeleteRole &&
							(confirmingDelete ? (
								<>
									<button
										type="button"
										className="btn-danger-inline"
										disabled={deleting}
										onClick={() => void handleDelete()}
									>
										{deleting ? "删除中…" : "确认删除"}
									</button>
									<button
										type="button"
										className="btn-inline btn-xs"
										disabled={deleting}
										onClick={() => setConfirmingDelete(false)}
									>
										取消
									</button>
								</>
							) : (
								<button type="button" className="btn-danger-inline" onClick={() => setConfirmingDelete(true)}>
									删除角色
								</button>
							))}
					</div>
				) : (
					<button type="button" className="btn-inline" onClick={onClose}>
						关闭
					</button>
				)}
			</div>

			<div className="architect-form-body">
				{template && (template.responsibilities || template.skills.length > 0 || template.keywords.length > 0) && (
					<div className="architect-preview-pane">
						<h4>核心职责与能力标签</h4>
						{template.responsibilities && (
							<p className="architect-preview-copy" style={{ whiteSpace: "pre-line" }}>
								{extractCoreResponsibilities(
									template.responsibilities,
									Boolean(template.antiJobs && template.antiJobs.length > 0),
								)}
							</p>
						)}
						{template.skills.length > 0 && (
							<div style={{ marginTop: 8 }}>
								<div className="muted-tiny" style={{ marginBottom: 4 }}>
									配套技能（点击浮窗查看 SKILL.md）
								</div>
								<div className="tag-list">
									{template.skills.map((sk) => (
										<button
											key={sk}
											type="button"
											className="tag-chip skill"
											style={{ cursor: "pointer", border: "none" }}
											title={`点击查看 ${sk}`}
											onClick={() => void handleOpenSkill(sk)}
										>
											{formatMemberSkillLabel(sk)}
										</button>
									))}
								</div>
							</div>
						)}
						{template.keywords.length > 0 && (
							<div className="tag-list" style={{ marginTop: 8 }}>
								{template.keywords.map((kw) => (
									<span key={kw} className="tag-chip">
										#{kw}
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

				<div className="identity-form-hint">
					{activeOrg?.useRoleGitIdentity ? (
						<>
							当前组织「{activeOrg.name}」已启用角色 Git 署名：提交 Author 为{" "}
							<strong>{gitIdentity.formatted}</strong>
							{activeWorkspace?.repoGitUser
								? `，Committer 保留仓库真实用户（${activeWorkspace.repoGitUser.name} <${activeWorkspace.repoGitUser.email}>）`
								: "，未检测到仓库 Git 配置时 Committer 回退为角色署名"}
							。可在「组织 → AI 角色」按组织覆盖或关闭。
						</>
					) : (
						<>
							默认使用仓库目录自身的 Git user.name / user.email 提交
							{activeWorkspace?.repoGitUser
								? `（当前仓库：${activeWorkspace.repoGitUser.name} <${activeWorkspace.repoGitUser.email}>）`
								: ""}
							，不注入角色 Git 信息；下方为角色默认署名档案，可在「组织 → AI 角色」中开启角色 Git
							署名并按组织重新配置。
						</>
					)}
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

				<div className="form-footer">
					<span className="muted-tiny">运行工具：共享 Pi 默认工具（边界由职责与 Anti-Jobs 约束）</span>
					<div className="ui-row-actions">
						{!inline && onClose && (
							<button type="button" className="btn-pill-outline" onClick={onClose}>
								{canEditIdentity ? "取消" : "关闭"}
							</button>
						)}
						{canEditIdentity && (
							<button
								type="button"
								className="btn-pill-dark btn-xs"
								disabled={savingIdentity}
								onClick={() => void handleSaveIdentity()}
							>
								{savingIdentity ? "保存中…" : "保存身份"}
							</button>
						)}
					</div>
				</div>
			</div>
		</>
	);

	const skillPreviewModal = (
		<ModalDialog
			open={Boolean(previewSkillRef)}
			title={previewSkillDetail ? previewSkillDetail.name : (previewSkillRef ?? "")}
			subtitle={previewSkillDetail?.filePath}
			size="lg"
			onClose={() => setPreviewSkillRef(null)}
			footer={
				<button type="button" className="btn-pill-outline btn-xs" onClick={() => setPreviewSkillRef(null)}>
					关闭
				</button>
			}
		>
			{loadingSkill ? (
				<p className="muted-sm">正在读取 SKILL.md 内容…</p>
			) : skillError ? (
				<div className="approval-card" role="alert">
					读取失败：{skillError}
				</div>
			) : previewSkillDetail ? (
				<div className="skills-preview-split">
					<aside className="skills-preview-nav" aria-label="Skill 目录文件">
						<div className="skills-preview-group">
							<span className="skills-preview-group-label">入口定义</span>
							<button
								type="button"
								className={`skills-preview-file-btn ${previewSkillTab === "SKILL.md" ? "active" : ""}`}
								onClick={() => setPreviewSkillTab("SKILL.md")}
							>
								<span>SKILL.md</span>
							</button>
						</div>
						{previewSkillDetail.scripts.length > 0 && (
							<div className="skills-preview-group">
								<span className="skills-preview-group-label">
									scripts/ ({previewSkillDetail.scripts.length})
								</span>
								{previewSkillDetail.scripts.map((script) => (
									<button
										key={script.path}
										type="button"
										className={`skills-preview-file-btn ${previewSkillTab === script.path ? "active" : ""}`}
										onClick={() => setPreviewSkillTab(script.path)}
										title={script.path}
									>
										<span>{script.path.replace(/^scripts\//, "")}</span>
									</button>
								))}
							</div>
						)}
					</aside>
					<div className="skills-preview-content">
						<div className="skills-preview-filebar">
							<code className="skills-preview-filepath">{previewSkillTab}</code>
							{previewSkillTab === "SKILL.md" && (
								<div className="skills-preview-mode-toggle" role="tablist" aria-label="查看模式">
									<button
										type="button"
										role="tab"
										aria-selected={previewSkillMode === "rendered"}
										className={`choice-chip ${previewSkillMode === "rendered" ? "active" : ""}`}
										onClick={() => setPreviewSkillMode("rendered")}
									>
										渲染
									</button>
									<button
										type="button"
										role="tab"
										aria-selected={previewSkillMode === "raw"}
										className={`choice-chip ${previewSkillMode === "raw" ? "active" : ""}`}
										onClick={() => setPreviewSkillMode("raw")}
									>
										源码
									</button>
								</div>
							)}
						</div>
						<div className="skills-preview-viewer">
							{previewSkillTab === "SKILL.md" && previewSkillMode === "rendered" ? (
								<div className="skills-preview-markdown">
									<MarkdownView
										content={previewSkillDetail.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "")}
									/>
								</div>
							) : (
								<pre className="pa-viz-code skills-modal-code">
									<code>
										{previewSkillTab === "SKILL.md"
											? previewSkillDetail.content
											: (previewSkillDetail.scripts.find((s) => s.path === previewSkillTab)?.content ?? "")}
									</code>
								</pre>
							)}
						</div>
					</div>
				</div>
			) : null}
		</ModalDialog>
	);

	if (inline) {
		return (
			<div className="ui-card team-detail-card">
				{detailBody}
				{skillPreviewModal}
			</div>
		);
	}

	return (
		<div className="architect-modal-backdrop">
			<button type="button" className="architect-modal-scrim" aria-label="关闭弹窗" onClick={onClose} />
			<div className="architect-modal-card" role="dialog" aria-modal="true" aria-label="成员详情管理">
				{detailBody}
			</div>
			{skillPreviewModal}
		</div>
	);
}
