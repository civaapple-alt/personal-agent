import { useState } from "react";
import {
	deleteMember,
	type MemberMemoryDto,
	type OrganizationDto,
	type RoleTemplateDto,
	type TeamMemberDto,
	type WorkspaceDto,
} from "../../api.ts";
import {
	countMemberMemoriesByScope,
	formatMemberGitIdentity,
	formatRoleToolTierLabel,
	getBotTheme,
	stripMarkdownFormatting,
} from "../../utils.ts";
import { BotFaceIcon } from "../BotFaceIcon.tsx";

interface MemberCardProps {
	member: TeamMemberDto;
	index: number;
	template?: RoleTemplateDto;
	memories: MemberMemoryDto[];
	activeWorkspace: WorkspaceDto | null;
	activeOrg: OrganizationDto | null;
	onAssignTask: (memberId: string) => void;
	onSetPrimary: (memberId: string) => Promise<void>;
	onExportMember: (memberId: string) => Promise<void>;
	onInspectMember: (memberId: string, tab: "identity" | "memories") => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

/** Compact, uniform AI team member card; detailed identity editing and memory curation open in a focused modal. */
export function MemberCard({
	member,
	index,
	template,
	memories,
	activeWorkspace,
	activeOrg,
	onAssignTask,
	onSetPrimary,
	onExportMember,
	onInspectMember,
	onRefresh,
	onNotice,
	onError,
}: MemberCardProps) {
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [deletingMember, setDeletingMember] = useState(false);

	const theme = getBotTheme(index);
	const scopeCounts = countMemberMemoriesByScope(memories);
	const gitIdentity = formatMemberGitIdentity(member, activeOrg);
	const verifiedCount = memories.filter((m) => m.status === "verified" || (!m.status && m.verified)).length;
	const candidateCount = memories.filter((m) => m.status === "candidate" || (!m.status && !m.verified)).length;

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
						onClick={() => onInspectMember(member.id, "identity")}
					>
						编辑身份
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
						{formatRoleToolTierLabel(template?.tools)}
					</span>
					{(template?.antiJobs?.length ?? 0) > 0 && (
						<span className="pill" title={template!.antiJobs!.join("；")}>
							边界 {template!.antiJobs!.length}
						</span>
					)}
				</div>
			</div>

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
						onClick={() => onInspectMember(member.id, "memories")}
					>
						管理经验 ({memories.length})
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
					{!member.isPrimaryContact &&
						(confirmDelete ? (
							<>
								<button
									type="button"
									className="btn-inline btn-xs"
									disabled={deletingMember}
									onClick={() => {
										setDeletingMember(true);
										void deleteMember(member.id)
											.then(async () => {
												onNotice(`已移除成员「${member.displayName}」`);
												await onRefresh();
											})
											.catch((err: unknown) => {
												onError(err instanceof Error ? err.message : String(err));
											})
											.finally(() => {
												setDeletingMember(false);
												setConfirmDelete(false);
											});
									}}
								>
									{deletingMember ? "移除中…" : "确认移除"}
								</button>
								<button type="button" className="btn-inline btn-xs" onClick={() => setConfirmDelete(false)}>
									取消
								</button>
							</>
						) : (
							<button type="button" className="btn-inline btn-xs" onClick={() => setConfirmDelete(true)}>
								移除角色
							</button>
						))}
				</div>
			</div>
		</div>
	);
}
