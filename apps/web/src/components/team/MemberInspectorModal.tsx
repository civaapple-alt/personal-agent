import { useEffect, useId, useState } from "react";
import {
	deleteMember,
	fetchMemberSkillDetail,
	type MemberSkillDetailDto,
	type OrganizationDto,
	type RoleScope,
	type RoleTemplateDto,
	type TeamMemberDto,
	updateMemberIdentity,
	type WorkspaceDto,
} from "../../api.ts";
import { getMemberScopeBadge, isArchitectMember } from "../../architectApi.ts";
import { MarkdownView } from "../../MarkdownView.tsx";
import {
	Badge,
	type BadgeTone,
	Banner,
	BotFaceIcon,
	Button,
	Card,
	FieldGroup,
	Input,
	ModalDialog,
	Tabs,
	Textarea,
} from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";
import { defaultMemberGitName, formatMemberGitIdentity, getBotTheme } from "../../utils.ts";

const SCOPE_BADGE_TONE: Record<RoleScope, BadgeTone> = {
	global: "neutral",
	org: "info",
	personal: "observer",
};

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
	const fieldBaseId = useId();
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
	const scopeBadge = getMemberScopeBadge(member, organizationName);

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

	const displayNameId = `${fieldBaseId}-display-name`;
	const roleTitleId = `${fieldBaseId}-role-title`;
	const gitNameId = `${fieldBaseId}-git-name`;
	const gitEmailId = `${fieldBaseId}-git-email`;
	const summaryId = `${fieldBaseId}-summary`;

	const detailBody = (
		<>
			<div className="flex items-start justify-between gap-3 flex-wrap pb-3 border-b border-line">
				<div className="flex items-center gap-2.5 min-w-0 flex-1">
					<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="lg" mood={isArchitect ? "thinking" : "idle"} />
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-1.5 flex-wrap">
							<strong className="text-base font-semibold text-ink">{member.displayName}</strong>
							{effectiveIsPrimary && (
								<Badge tone="success" dot>
									{isPrimary !== undefined ? "主联系" : "默认主联系"}
								</Badge>
							)}
							{isArchitect && <Badge tone="neutral">内置角色设计</Badge>}
							{(template?.roleKind === "solo" || member.id === "pi-default") && (
								<Badge tone="neutral">单兵 Pi</Badge>
							)}
							<Badge tone={SCOPE_BADGE_TONE[scopeBadge.scope]}>{scopeBadge.label}</Badge>
						</div>
						<div className="mt-0.5 text-xs text-ink-muted truncate">
							{member.roleTitle} · ID：{member.id}
						</div>
					</div>
				</div>
				{inline && (
					<div className="flex items-center gap-2 flex-wrap shrink-0">
						{canDispatch && onAssignTask && (
							<Button variant="primary" size="xs" onClick={() => onAssignTask(member.id)}>
								向 TA 派活
							</Button>
						)}
						{onExportMember && (
							<Button variant="secondary" size="xs" onClick={() => void onExportMember(member.id)}>
								导出角色包
							</Button>
						)}
						{canSetPrimary && !effectiveIsPrimary && !isArchitect && onSetPrimary && (
							<Button variant="secondary" size="xs" onClick={() => void onSetPrimary(member.id)}>
								{primaryActionLabel}
							</Button>
						)}
						{canDeleteRole &&
							(confirmingDelete ? (
								<>
									<Button variant="danger" size="xs" disabled={deleting} onClick={() => void handleDelete()}>
										{deleting ? "删除中…" : "确认删除"}
									</Button>
									<Button
										variant="inline"
										size="xs"
										disabled={deleting}
										onClick={() => setConfirmingDelete(false)}
									>
										取消
									</Button>
								</>
							) : (
								<Button
									variant="ghost"
									size="xs"
									className="text-danger-text hover:bg-danger-bg hover:text-danger-text"
									onClick={() => setConfirmingDelete(true)}
								>
									删除角色
								</Button>
							))}
					</div>
				)}
			</div>

			<div className="flex flex-col gap-3">
				{template && (template.responsibilities || template.skills.length > 0 || template.keywords.length > 0) && (
					<div className="rounded-md border border-line bg-sidebar p-3 flex flex-col gap-2">
						<h4 className="m-0 text-xs font-semibold text-ink-secondary">核心职责与能力标签</h4>
						{template.responsibilities && (
							<p className="m-0 text-xs text-ink leading-relaxed whitespace-pre-line">
								{extractCoreResponsibilities(
									template.responsibilities,
									Boolean(template.antiJobs && template.antiJobs.length > 0),
								)}
							</p>
						)}
						{template.skills.length > 0 && (
							<div className="flex flex-col gap-1.5">
								<div className="text-micro text-ink-muted">配套技能（点击浮窗查看 SKILL.md）</div>
								<div className="flex flex-wrap gap-1.5">
									{template.skills.map((sk) => (
										<button
											key={sk}
											type="button"
											title={`点击查看 ${sk}`}
											onClick={() => void handleOpenSkill(sk)}
											className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill border border-accent-border bg-accent-soft text-accent text-micro font-medium cursor-pointer hover:bg-surface-accent transition-colors focus-visible:outline-2 focus-visible:outline-accent"
										>
											{formatMemberSkillLabel(sk)}
										</button>
									))}
								</div>
							</div>
						)}
						{template.keywords.length > 0 && (
							<div className="flex flex-wrap gap-1.5">
								{template.keywords.map((kw) => (
									<Badge key={kw} tone="neutral">
										#{kw}
									</Badge>
								))}
							</div>
						)}
					</div>
				)}

				{template?.antiJobs && template.antiJobs.length > 0 && (
					<div className="rounded-md border border-line bg-sidebar p-3 flex flex-col gap-1.5">
						<h4 className="m-0 text-xs font-semibold text-ink-secondary">当前不做边界（Anti-Jobs）</h4>
						<ul className="m-0 pl-4 flex flex-col gap-1 text-micro text-ink-secondary leading-relaxed list-disc">
							{template.antiJobs.map((rule) => (
								<li key={rule}>{rule}</li>
							))}
						</ul>
					</div>
				)}

				<div className="text-xs text-ink-muted leading-relaxed">
					{activeOrg?.useRoleGitIdentity ? (
						<>
							当前组织「{activeOrg.name}」已启用角色 Git 署名：提交 Author 为{" "}
							<strong className="font-semibold text-ink">{gitIdentity.formatted}</strong>
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

				<div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
					<FieldGroup label="团队显示名" htmlFor={displayNameId}>
						<Input
							id={displayNameId}
							disabled={!canEditIdentity}
							value={editDisplayName}
							onChange={(e) => setEditDisplayName(e.target.value)}
						/>
					</FieldGroup>
					<FieldGroup label="职位头衔" htmlFor={roleTitleId}>
						<Input
							id={roleTitleId}
							disabled={!canEditIdentity}
							value={editRoleTitle}
							onChange={(e) => setEditRoleTitle(e.target.value)}
						/>
					</FieldGroup>
					<FieldGroup label="Git Author 名称" htmlFor={gitNameId}>
						<Input
							id={gitNameId}
							disabled={!canEditIdentity}
							placeholder="如：R&D Lead"
							value={editGitName}
							onChange={(e) => setEditGitName(e.target.value)}
						/>
					</FieldGroup>
					<FieldGroup label="Git Author 邮箱" htmlFor={gitEmailId}>
						<Input
							id={gitEmailId}
							disabled={!canEditIdentity}
							placeholder="如：rd@acme.dev"
							value={editGitEmail}
							onChange={(e) => setEditGitEmail(e.target.value)}
						/>
					</FieldGroup>
				</div>

				<FieldGroup label="角色定位与专长补充（私有，不随公开模板导出）" htmlFor={summaryId}>
					<Textarea
						id={summaryId}
						rows={3}
						disabled={!canEditIdentity}
						placeholder="补充该角色在当前团队/项目中的分工偏好、关注重点或边界说明"
						value={editIdentitySummary}
						onChange={(e) => setEditIdentitySummary(e.target.value)}
					/>
				</FieldGroup>

				<div className="pt-2 border-t border-line-subtle flex items-center justify-between gap-2.5 flex-wrap">
					<span className="text-micro text-ink-muted">
						运行工具：共享 Pi 默认工具（边界由职责与 Anti-Jobs 约束）
					</span>
					<div className="flex items-center gap-2 flex-wrap">
						{!inline && onClose && (
							<Button variant="secondary" size="xs" onClick={onClose}>
								{canEditIdentity ? "取消" : "关闭"}
							</Button>
						)}
						{canEditIdentity && (
							<Button
								variant="primary"
								size="xs"
								disabled={savingIdentity}
								onClick={() => void handleSaveIdentity()}
							>
								{savingIdentity ? "保存中…" : "保存身份"}
							</Button>
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
				<Button variant="secondary" size="xs" onClick={() => setPreviewSkillRef(null)}>
					关闭
				</Button>
			}
		>
			{loadingSkill ? (
				<p className="m-0 text-xs text-ink-secondary">正在读取 SKILL.md 内容…</p>
			) : skillError ? (
				<Banner tone="danger">读取失败：{skillError}</Banner>
			) : previewSkillDetail ? (
				<div className="grid grid-cols-1 md:grid-cols-[204px_minmax(0,1fr)] gap-3.5 items-start min-h-[360px]">
					<aside
						className="flex flex-col gap-2.5 md:pr-3 md:border-r border-b md:border-b-0 pb-2.5 md:pb-0 border-line max-h-[180px] md:max-h-[62vh] overflow-y-auto"
						aria-label="Skill 目录文件"
					>
						<div className="flex flex-col gap-0.5">
							<span className="text-micro font-semibold text-ink-muted px-1.5 py-0.5">入口定义</span>
							<button
								type="button"
								className={cn(
									"border-0 text-left px-2 py-1.5 rounded-sm text-xs cursor-pointer flex items-center min-w-0 transition-colors focus-visible:outline-2 focus-visible:outline-accent",
									previewSkillTab === "SKILL.md"
										? "bg-accent-soft text-accent font-semibold"
										: "bg-transparent text-ink-secondary hover:bg-subtle hover:text-ink",
								)}
								onClick={() => setPreviewSkillTab("SKILL.md")}
							>
								<span className="truncate">SKILL.md</span>
							</button>
						</div>
						{previewSkillDetail.scripts.length > 0 && (
							<div className="flex flex-col gap-0.5">
								<span className="text-micro font-semibold text-ink-muted px-1.5 py-0.5">
									scripts/ ({previewSkillDetail.scripts.length})
								</span>
								{previewSkillDetail.scripts.map((script) => (
									<button
										key={script.path}
										type="button"
										className={cn(
											"border-0 text-left px-2 py-1.5 rounded-sm text-xs cursor-pointer flex items-center min-w-0 transition-colors focus-visible:outline-2 focus-visible:outline-accent",
											previewSkillTab === script.path
												? "bg-accent-soft text-accent font-semibold"
												: "bg-transparent text-ink-secondary hover:bg-subtle hover:text-ink",
										)}
										onClick={() => setPreviewSkillTab(script.path)}
										title={script.path}
									>
										<span className="truncate">{script.path.replace(/^scripts\//, "")}</span>
									</button>
								))}
							</div>
						)}
					</aside>
					<div className="flex flex-col gap-2 min-w-0">
						<div className="flex items-center justify-between gap-2 flex-wrap pb-2 border-b border-line">
							<code className="px-2 py-0.5 rounded-sm bg-subtle font-mono text-xs text-ink">
								{previewSkillTab}
							</code>
							{previewSkillTab === "SKILL.md" && (
								<Tabs
									variant="pill"
									size="sm"
									ariaLabel="查看模式"
									value={previewSkillMode}
									onChange={(id) => setPreviewSkillMode(id as "rendered" | "raw")}
									items={[
										{ id: "rendered", label: "渲染" },
										{ id: "raw", label: "源码" },
									]}
								/>
							)}
						</div>
						<div className="max-h-[58vh] overflow-y-auto min-w-0">
							{previewSkillTab === "SKILL.md" && previewSkillMode === "rendered" ? (
								<div className="px-1.5 pt-1 pb-3 text-sm leading-relaxed text-ink">
									<MarkdownView
										content={previewSkillDetail.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "")}
									/>
								</div>
							) : (
								<pre className="m-0 p-3 rounded-sm border border-line bg-sidebar font-mono text-xs text-ink leading-relaxed max-h-[58vh] overflow-auto whitespace-pre-wrap break-words">
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
			<Card padding="md" className="flex flex-col gap-3.5 shadow-sm">
				{detailBody}
				{skillPreviewModal}
			</Card>
		);
	}

	return (
		<>
			<ModalDialog
				open={Boolean(member)}
				title={member.displayName}
				subtitle={`${member.roleTitle} · ID：${member.id}`}
				ariaLabel="成员详情管理"
				size="lg"
				onClose={onClose ?? (() => {})}
			>
				{detailBody}
			</ModalDialog>
			{skillPreviewModal}
		</>
	);
}
