import { useEffect, useState } from "react";
import {
	type OrganizationDto,
	type RoleTemplateDto,
	type TeamMemberDto,
	updateMemberIdentity,
	type WorkspaceDto,
} from "../../api.ts";
import { getMemberScopeBadge } from "../../architectApi.ts";
import { BotFaceIcon } from "../../primitives/BotFaceIcon.tsx";
import { defaultMemberGitName, formatMemberGitIdentity, getBotTheme } from "../../utils.ts";

interface MemberInspectorModalProps {
	member: TeamMemberDto | null;
	memberIndex: number;
	template?: RoleTemplateDto;
	canEditIdentity?: boolean;
	isPrimary?: boolean;
	effectiveGitOverride?: { gitNameOverride?: string | null; gitEmailOverride?: string | null } | null;
	activeWorkspace: WorkspaceDto | null;
	activeOrg: OrganizationDto | null;
	organizationName?: (id: string | null) => string | null;
	onClose: () => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

/** Spacious modal for inspecting role responsibilities and editing member identity/Git author. */
export function MemberInspectorModal({
	member,
	memberIndex,
	template,
	canEditIdentity = true,
	isPrimary,
	effectiveGitOverride = null,
	activeWorkspace,
	activeOrg,
	organizationName,
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

	useEffect(() => {
		if (!member) return;
		setEditDisplayName(member.displayName);
		setEditRoleTitle(member.roleTitle);
		setEditGitName(member.gitName || defaultMemberGitName(member));
		setEditGitEmail(member.gitEmail || `${member.id}@team.local`);
		setEditIdentitySummary(member.identitySummary || "");
	}, [member]);

	if (!member) return null;

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
			onClose();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setSavingIdentity(false);
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
								{(isPrimary ?? member.isPrimaryContact) && (
									<span className="pill live">{isPrimary !== undefined ? "主联系" : "默认主联系"}</span>
								)}
								<span
									className={`pill role-scope-pill is-${getMemberScopeBadge(member, organizationName).scope}`}
								>
									{getMemberScopeBadge(member, organizationName).label}
								</span>
							</div>
							<div className="member-sub">
								{member.roleTitle} · ID：{member.id}
							</div>
						</div>
					</div>
					<button type="button" className="btn-inline" onClick={onClose}>
						关闭
					</button>
				</div>

				<div className="architect-form-body">
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
							岗位建议工具：{template?.tools.length ? template.tools.join(", ") : "无"}（不限制运行工具）
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
			</div>
		</div>
	);
}
