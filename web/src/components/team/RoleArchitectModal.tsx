import { useEffect, useState } from "react";
import {
	createMember,
	designRoleDraft,
	type MetaArchitectFormationSuggestionDto,
	type RoleArchitectDraftDto,
	type RoleGapSuggestionDto,
	type RoleInteractionStyle,
	type RoleTemplateDto,
	type RoleWorkspaceScope,
	type TeamMemberDto,
} from "../../api.ts";
import { formatRoleToolTierLabel, getMemberThemeById } from "../../utils.ts";
import { BotFaceIcon } from "../BotFaceIcon.tsx";
import { MetaArchitectChatPane } from "./MetaArchitectChatPane.tsx";

interface RoleArchitectModalProps {
	open: boolean;
	seedGap?: RoleGapSuggestionDto | null;
	members: TeamMemberDto[];
	templateByRoleId: Map<string, RoleTemplateDto>;
	matterCount: number;
	matterPrompt?: string;
	workspaceId?: string | null;
	onClose: () => void;
	onOpenArchitectMatter?: () => void;
	onCreated: (member: TeamMemberDto) => Promise<void> | void;
	onCreatedBatch?: (members: TeamMemberDto[], formation?: MetaArchitectFormationSuggestionDto) => Promise<void> | void;
	onAppliedAdjustments?: () => Promise<void> | void;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

const INTERACTION_CARDS: Array<{
	id: RoleInteractionStyle;
	title: string;
	sub: string;
}> = [
	{ id: "lead_direct", title: "直接牵头", sub: "面向人沟通并交付" },
	{ id: "consult_specialist", title: "幕后专才", sub: "仅被请教时出主意" },
	{ id: "risk_observer", title: "静默旁听", sub: "无风险时不主动插话" },
];

const SCOPE_CARDS: Array<{
	id: RoleWorkspaceScope;
	title: string;
	sub: string;
}> = [
	{ id: "no_repo_docs", title: "纯思考文稿", sub: "不接触项目文件" },
	{ id: "read_only_repo", title: "只看项目文件", sub: "核查资料，不改源码" },
	{ id: "read_write_code", title: "可改代码运行", sub: "编辑代码并跑测试" },
];

const BOUNDARY_CHIPS = ["不直接修改代码", "无关键风险时静默", "不替团队拍板最终决策", "不编造未核查的数据"];

/** Visual role architect studio combining Meta-Bot workflow planning/audit and 3-choice visual quick card creation. */
export function RoleArchitectModal({
	open,
	seedGap,
	members,
	templateByRoleId,
	matterCount,
	matterPrompt,
	workspaceId,
	onClose,
	onOpenArchitectMatter,
	onCreated,
	onCreatedBatch,
	onAppliedAdjustments,
	onNotice,
	onError,
}: RoleArchitectModalProps) {
	const [architectMode, setArchitectMode] = useState<"meta_chat" | "quick_form">("meta_chat");
	const [oneJob, setOneJob] = useState("");
	const [selectedBoundaries, setSelectedBoundaries] = useState<string[]>([]);
	const [extraBoundary, setExtraBoundary] = useState("");
	const [interactionStyle, setInteractionStyle] = useState<RoleInteractionStyle>("consult_specialist");
	const [workspaceScope, setWorkspaceScope] = useState<RoleWorkspaceScope>("read_only_repo");
	const [workflowRules, setWorkflowRules] = useState("");
	const [roleName, setRoleName] = useState("");
	const [roleTitle, setRoleTitle] = useState("");
	const [keywordsText, setKeywordsText] = useState("");
	const [isPrimaryContact, setIsPrimaryContact] = useState(false);
	const [draft, setDraft] = useState<RoleArchitectDraftDto | null>(null);
	const [generating, setGenerating] = useState(false);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!open) return;
		setArchitectMode("meta_chat");
		setDraft(null);
		if (seedGap) {
			setOneJob(seedGap.suggestedJob);
			setSelectedBoundaries(seedGap.suggestedAntiJobs.slice(0, 3));
			setExtraBoundary(seedGap.suggestedAntiJobs.slice(3).join("\n"));
			setInteractionStyle(
				seedGap.suggestedInteractionStyle === "mixed" ? "lead_direct" : seedGap.suggestedInteractionStyle,
			);
			setWorkspaceScope(seedGap.suggestedWorkspaceScope);
			setRoleName(seedGap.missingRoleTitle);
			setRoleTitle("");
			setWorkflowRules("");
			setKeywordsText("");
			setIsPrimaryContact(false);
		} else {
			setOneJob("");
			setSelectedBoundaries([]);
			setExtraBoundary("");
			setInteractionStyle("consult_specialist");
			setWorkspaceScope("read_only_repo");
			setWorkflowRules("");
			setRoleName("");
			setRoleTitle("");
			setKeywordsText("");
			setIsPrimaryContact(false);
		}
	}, [open, seedGap]);

	if (!open) return null;

	const toggleBoundaryChip = (rule: string) => {
		setDraft(null);
		setSelectedBoundaries((prev) => (prev.includes(rule) ? prev.filter((item) => item !== rule) : [...prev, rule]));
	};

	const handleGenerateDraft = async () => {
		if (!oneJob.trim() || generating) return;
		setGenerating(true);
		const extraLines = extraBoundary
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean);
		try {
			const res = await designRoleDraft({
				oneJob: oneJob.trim(),
				antiJobs: Array.from(new Set([...selectedBoundaries, ...extraLines])),
				interactionStyle,
				workspaceScope,
				roleName: roleName.trim() || undefined,
				roleTitle: roleTitle.trim() || undefined,
				keywords: keywordsText
					.split(/[,，\s]+/)
					.map((s) => s.trim())
					.filter(Boolean),
				workflowRules: workflowRules.trim() || undefined,
				isPrimaryContact,
			});
			setDraft(res);
			setRoleName(res.template.name);
			setRoleTitle(res.template.title);
			setKeywordsText(res.template.keywords.join(", "));
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setGenerating(false);
		}
	};

	const handleConfirmCreate = async () => {
		if (!draft || !roleName.trim() || !roleTitle.trim() || saving) return;
		setSaving(true);
		try {
			const res = await createMember({
				name: roleName.trim(),
				title: roleTitle.trim(),
				responsibilities: draft.template.sections.responsibilitiesAndBoundaries,
				keywords: keywordsText
					.split(/[,，\s]+/)
					.map((s) => s.trim())
					.filter(Boolean),
				skills: draft.template.skills,
				tools: draft.template.tools,
				antiJobs: draft.antiJobs,
				sections: draft.template.sections,
				isPrimaryContact,
			});
			onNotice(`已创建「${res.member.displayName}」`);
			await onCreated(res.member);
			onClose();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="architect-modal-backdrop">
			<button type="button" className="architect-modal-scrim" aria-label="关闭弹窗" onClick={onClose} />
			<div className="architect-modal-card" role="dialog" aria-modal="true" aria-label="角色设计工作室">
				<div className="banner-row">
					<div className="architect-header-title-wrap">
						<h2 className="ui-card-title architect-modal-title">定制团队角色</h2>
						<span className="pill">当前 {members.length} 位成员</span>
					</div>
					<div className="actions-row compact">
						{onOpenArchitectMatter && (
							<button
								type="button"
								className="btn-pill-outline btn-xs"
								onClick={() => {
									onClose();
									onOpenArchitectMatter();
								}}
							>
								在持久化对话中规划/体检 →
							</button>
						)}
						<button type="button" className="btn-inline" onClick={onClose}>
							关闭
						</button>
					</div>
				</div>

				{members.length > 0 && (
					<section className="architect-roster-strip" aria-label="当前已有团队成员">
						{members.map((member) => {
							const theme = getMemberThemeById(members, member.id);
							const tpl = templateByRoleId.get(member.templateId);
							return (
								<div key={member.id} className="architect-roster-pill">
									<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="sm" />
									<span>{member.displayName}</span>
									<small>{formatRoleToolTierLabel(tpl?.tools)}</small>
								</div>
							);
						})}
					</section>
				)}

				<div className="architect-tabs" role="tablist" aria-label="设计方式切换">
					<button
						type="button"
						role="tab"
						aria-selected={architectMode === "meta_chat"}
						className={`choice-chip ${architectMode === "meta_chat" ? "active" : ""}`}
						onClick={() => setArchitectMode("meta_chat")}
					>
						对话规划 · 体检与分工
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={architectMode === "quick_form"}
						className={`choice-chip ${architectMode === "quick_form" ? "active" : ""}`}
						onClick={() => setArchitectMode("quick_form")}
					>
						快速卡片创建
					</button>
				</div>

				{seedGap && (
					<div className="notice-card architect-gap-banner">
						<strong>缺口提示：</strong>
						<span>{seedGap.reason}</span>
					</div>
				)}

				{architectMode === "meta_chat" ? (
					<MetaArchitectChatPane
						open={open}
						seedGap={seedGap}
						memberCount={members.length}
						matterCount={matterCount}
						matterPrompt={matterPrompt}
						workspaceId={workspaceId}
						onCreatedBatch={async (createdMembers, formation) => {
							if (onCreatedBatch) {
								await onCreatedBatch(createdMembers, formation);
							} else if (createdMembers[0]) {
								await onCreated(createdMembers[0]);
							}
						}}
						onAppliedAdjustments={onAppliedAdjustments}
						onClose={onClose}
						onSwitchQuickForm={() => setArchitectMode("quick_form")}
						onNotice={onNotice}
						onError={onError}
					/>
				) : (
					<div className="architect-form-body">
						<label className="identity-field">
							<span className="identity-field-label">它专职负责哪件事？</span>
							<input
								className="input-field"
								placeholder="例如：上线前合同风险把关 / 每日访谈痛点提炼"
								value={oneJob}
								onChange={(e) => {
									setOneJob(e.target.value);
									setDraft(null);
								}}
							/>
						</label>

						<div className="architect-section-block">
							<span className="identity-field-label">在团队中怎么配合</span>
							<div className="architect-option-grid">
								{INTERACTION_CARDS.map((card) => (
									<button
										key={card.id}
										type="button"
										className={`architect-option-card ${interactionStyle === card.id ? "active" : ""}`}
										onClick={() => {
											setInteractionStyle(card.id);
											setDraft(null);
										}}
									>
										<span className="architect-option-icon" aria-hidden="true">
											{card.id === "lead_direct" ? (
												<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
													<circle cx="10" cy="7" r="3" stroke="currentColor" strokeWidth="1.5" />
													<path
														d="M4.5 16.5c.8-2.6 3-4 5.5-4s4.7 1.4 5.5 4"
														stroke="currentColor"
														strokeWidth="1.5"
														strokeLinecap="round"
													/>
												</svg>
											) : card.id === "consult_specialist" ? (
												<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
													<path
														d="M4 5.5h12v7H8l-4 3v-10Z"
														stroke="currentColor"
														strokeWidth="1.5"
														strokeLinejoin="round"
													/>
												</svg>
											) : (
												<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
													<path
														d="M2.5 10s3-5 7.5-5 7.5 5 7.5 5-3 5-7.5 5-7.5-5-7.5-5Z"
														stroke="currentColor"
														strokeWidth="1.5"
													/>
													<circle cx="10" cy="10" r="2" stroke="currentColor" strokeWidth="1.5" />
												</svg>
											)}
										</span>
										<strong>{card.title}</strong>
										<small>{card.sub}</small>
									</button>
								))}
							</div>
						</div>

						<div className="architect-section-block">
							<span className="identity-field-label">允许使用的权限范围</span>
							<div className="architect-option-grid">
								{SCOPE_CARDS.map((card) => (
									<button
										key={card.id}
										type="button"
										className={`architect-option-card ${workspaceScope === card.id ? "active" : ""}`}
										onClick={() => {
											setWorkspaceScope(card.id);
											setDraft(null);
										}}
									>
										<span className="architect-option-icon" aria-hidden="true">
											{card.id === "no_repo_docs" ? (
												<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
													<rect
														x="4"
														y="3.5"
														width="12"
														height="13"
														rx="2"
														stroke="currentColor"
														strokeWidth="1.5"
													/>
													<path
														d="M7 7.5h6M7 10.5h6M7 13.5h4"
														stroke="currentColor"
														strokeWidth="1.5"
														strokeLinecap="round"
													/>
												</svg>
											) : card.id === "read_only_repo" ? (
												<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
													<circle cx="9" cy="9" r="4.5" stroke="currentColor" strokeWidth="1.5" />
													<path
														d="m12.5 12.5 4 4"
														stroke="currentColor"
														strokeWidth="1.5"
														strokeLinecap="round"
													/>
												</svg>
											) : (
												<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
													<path
														d="m7 6.5-3.5 3.5L7 13.5M13 6.5l3.5 3.5L13 13.5"
														stroke="currentColor"
														strokeWidth="1.5"
														strokeLinecap="round"
														strokeLinejoin="round"
													/>
												</svg>
											)}
										</span>
										<strong>{card.title}</strong>
										<small>{card.sub}</small>
									</button>
								))}
							</div>
						</div>

						<div className="architect-section-block">
							<span className="identity-field-label">边界约束（点选，可选）</span>
							<div className="architect-quick-chips">
								{BOUNDARY_CHIPS.map((rule) => {
									const active = selectedBoundaries.includes(rule);
									return (
										<button
											key={rule}
											type="button"
											className={`choice-chip ${active ? "active" : ""}`}
											onClick={() => toggleBoundaryChip(rule)}
										>
											{active ? "✓ " : "+ "}
											{rule}
										</button>
									);
								})}
							</div>
						</div>

						<details className="identity-rename-details">
							<summary>自定义附加约束或团队规则（可选）</summary>
							<div className="architect-advanced-grid">
								<input
									className="input-field"
									placeholder="附加不做项（如：不直接对外报价）"
									value={extraBoundary}
									onChange={(e) => {
										setExtraBoundary(e.target.value);
										setDraft(null);
									}}
								/>
								<input
									className="input-field"
									placeholder="团队流程要求（如：变更前须人确认）"
									value={workflowRules}
									onChange={(e) => {
										setWorkflowRules(e.target.value);
										setDraft(null);
									}}
								/>
							</div>
						</details>

						<div className="ui-row-actions">
							<button
								type="button"
								className="btn-pill-dark"
								disabled={!oneJob.trim() || generating}
								onClick={() => void handleGenerateDraft()}
							>
								{generating ? "生成预览中…" : draft ? "刷新预览" : "生成预览 →"}
							</button>
						</div>

						{draft && (
							<div className="architect-preview-box">
								<div className="architect-preview-head">
									<strong>确认角色名称与边界</strong>
									<span className="pill">{draft.toolSummary}</span>
								</div>

								<div className="form-grid">
									<label className="identity-field">
										<span className="identity-field-label">角色名称</span>
										<input
											className="input-field"
											value={roleName}
											onChange={(e) => setRoleName(e.target.value)}
										/>
									</label>
									<label className="identity-field">
										<span className="identity-field-label">头衔</span>
										<input
											className="input-field"
											value={roleTitle}
											onChange={(e) => setRoleTitle(e.target.value)}
										/>
									</label>
								</div>

								<div className="architect-preview-pane">
									<pre>{draft.template.sections.responsibilitiesAndBoundaries}</pre>
								</div>

								<div className="form-footer">
									<label className="checkbox-label">
										<input
											type="checkbox"
											checked={isPrimaryContact}
											onChange={(e) => setIsPrimaryContact(e.target.checked)}
										/>
										<span>设为默认主联系人</span>
									</label>
									<div className="ui-row-actions">
										<button type="button" className="btn-pill-outline" onClick={onClose}>
											取消
										</button>
										<button
											type="button"
											className="btn-pill-dark"
											disabled={!roleName.trim() || !roleTitle.trim() || saving}
											onClick={() => void handleConfirmCreate()}
										>
											{saving ? "创建中…" : "确认加入团队"}
										</button>
									</div>
								</div>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
