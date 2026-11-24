import { useEffect, useMemo, useRef, useState } from "react";
import {
	type AccountUserDto,
	type CollaboratorDto,
	createMember,
	designRoleDraft,
	type NewSkillDraftDto,
	type OrganizationDto,
	type RoleArchitectDraftDto,
	type RoleGapSuggestionDto,
	type RoleTemplateDto,
	type RoleWorkspaceScope,
	type TeamMemberDto,
} from "../../api.ts";
import { buildRoleScopeChoices, filterBusinessMembers } from "../../architectApi.ts";
import { BotFaceIcon } from "../../primitives/BotFaceIcon.tsx";
import { formatRoleToolTierLabel, getMemberThemeById, stripMarkdownFormatting } from "../../utils.ts";
import { NewSkillsDraftSection } from "./NewSkillsDraftSection.tsx";
import { RoleCapabilityDetails } from "./RoleDesignDetails.tsx";

interface RoleArchitectModalProps {
	open: boolean;
	seedGap?: RoleGapSuggestionDto | null;
	members: TeamMemberDto[];
	templateByRoleId: Map<string, RoleTemplateDto>;
	isSuperAdmin?: boolean;
	accountUser?: AccountUserDto | null;
	currentUser?: CollaboratorDto | null;
	organizations?: OrganizationDto[];
	defaultOrgId?: string | null;
	onClose: () => void;
	onOpenArchitectMatter?: () => void;
	onCreated: (member: TeamMemberDto) => Promise<void> | void;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

const SCOPE_CARDS: Array<{
	id: RoleWorkspaceScope;
	title: string;
	sub: string;
}> = [
	{ id: "no_repo_docs", title: "纯思考文稿", sub: "不接触项目文件" },
	{ id: "read_only_repo", title: "只看项目文件", sub: "核查资料，不改源码" },
	{ id: "read_write_code", title: "可改代码运行", sub: "读写文件并跑命令" },
];

const BOUNDARY_CHIPS = ["不直接修改代码", "无关键风险时静默", "不替团队拍板最终决策", "不编造未核查的数据"];

function cleanSectionLines(text: string | undefined): string[] {
	if (!text) return [];
	return text
		.split(/\r?\n/)
		.map((line) => stripMarkdownFormatting(line.trim()))
		.filter(Boolean);
}

/** Single-purpose offline quick role creator focusing on role identity, One Job, tool scope, keywords, and preview. */
export function RoleArchitectModal({
	open,
	seedGap,
	members,
	templateByRoleId,
	isSuperAdmin = false,
	accountUser = null,
	currentUser = null,
	organizations = [],
	defaultOrgId = null,
	onClose,
	onOpenArchitectMatter,
	onCreated,
	onNotice,
	onError,
}: RoleArchitectModalProps) {
	const [oneJob, setOneJob] = useState("");
	const [selectedBoundaries, setSelectedBoundaries] = useState<string[]>([]);
	const [extraBoundary, setExtraBoundary] = useState("");
	const [workspaceScope, setWorkspaceScope] = useState<RoleWorkspaceScope>("read_only_repo");
	const [workflowRules, setWorkflowRules] = useState("");
	const [roleName, setRoleName] = useState("");
	const [roleTitle, setRoleTitle] = useState("");
	const [keywordsText, setKeywordsText] = useState("");
	const [isPrimaryContact, setIsPrimaryContact] = useState(false);
	const [draft, setDraft] = useState<RoleArchitectDraftDto | null>(null);
	const [draftNewSkills, setDraftNewSkills] = useState<NewSkillDraftDto[]>([]);
	const [selectedNewSkillIndices, setSelectedNewSkillIndices] = useState<number[]>([]);
	const [generating, setGenerating] = useState(false);
	const [confirmAiDesign, setConfirmAiDesign] = useState(false);
	const [saving, setSaving] = useState(false);
	const designAbortRef = useRef<AbortController | null>(null);
	const scopeChoices = useMemo(
		() => buildRoleScopeChoices({ isSuperAdmin, accountUser, currentUser, organizations }),
		[isSuperAdmin, accountUser, currentUser, organizations],
	);
	const defaultScopeKey =
		(defaultOrgId && scopeChoices.find((c) => c.ownerOrgId === defaultOrgId)?.key) ||
		scopeChoices[0]?.key ||
		"personal";
	const [selectedScopeKey, setSelectedScopeKey] = useState<string>(defaultScopeKey);
	const activeScopeChoice = scopeChoices.find((c) => c.key === selectedScopeKey) ??
		scopeChoices[0] ?? { key: "personal", roleScope: "personal" as const, ownerOrgId: null, label: "个人私有" };

	useEffect(() => {
		if (!open) {
			designAbortRef.current?.abort();
			designAbortRef.current = null;
			setGenerating(false);
			setConfirmAiDesign(false);
			return;
		}
		setDraft(null);
		setDraftNewSkills([]);
		setSelectedNewSkillIndices([]);
		setConfirmAiDesign(false);
		setSelectedScopeKey(defaultScopeKey);
		if (seedGap) {
			setOneJob(seedGap.suggestedJob);
			setSelectedBoundaries(seedGap.suggestedAntiJobs.slice(0, 3));
			setExtraBoundary(seedGap.suggestedAntiJobs.slice(3).join("\n"));
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
			setWorkspaceScope("read_only_repo");
			setWorkflowRules("");
			setRoleName("");
			setRoleTitle("");
			setKeywordsText("");
			setIsPrimaryContact(false);
		}
	}, [open, seedGap, defaultScopeKey]);

	if (!open) return null;
	const businessMembers = filterBusinessMembers(members, templateByRoleId);

	const toggleBoundaryChip = (rule: string) => {
		setDraft(null);
		setSelectedBoundaries((prev) => (prev.includes(rule) ? prev.filter((item) => item !== rule) : [...prev, rule]));
	};

	const handleGenerateDraft = async () => {
		if (!oneJob.trim() || generating) return;
		designAbortRef.current?.abort();
		const controller = new AbortController();
		designAbortRef.current = controller;
		setGenerating(true);
		setConfirmAiDesign(false);
		const extraLines = extraBoundary
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean);
		try {
			const res = await designRoleDraft(
				{
					oneJob: oneJob.trim(),
					roleScope: activeScopeChoice.roleScope,
					ownerOrgId: activeScopeChoice.ownerOrgId,
					antiJobs: Array.from(new Set([...selectedBoundaries, ...extraLines])),
					interactionStyle: seedGap?.suggestedInteractionStyle ?? "mixed",
					workspaceScope,
					roleName: roleName.trim() || undefined,
					roleTitle: roleTitle.trim() || undefined,
					keywords: keywordsText
						.split(/[,，\s]+/)
						.map((s) => s.trim())
						.filter(Boolean),
					workflowRules: workflowRules.trim() || undefined,
					isPrimaryContact: activeScopeChoice.roleScope === "global" && isPrimaryContact,
					mode: "model",
				},
				controller.signal,
			);
			if (controller.signal.aborted) return;
			setDraft(res);
			const proposedSkills = res.newSkills ?? [];
			setDraftNewSkills(proposedSkills);
			setSelectedNewSkillIndices(proposedSkills.map((_, idx) => idx));
			setRoleName(res.template.name);
			setRoleTitle(res.template.title);
			setKeywordsText(res.template.keywords.join(", "));
		} catch (err: unknown) {
			if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			if (designAbortRef.current === controller) {
				designAbortRef.current = null;
				setGenerating(false);
			}
		}
	};

	const handleCancelAiDesign = () => {
		designAbortRef.current?.abort();
		designAbortRef.current = null;
		setGenerating(false);
	};

	const handleConfirmCreate = async () => {
		if (!draft || !roleName.trim() || !roleTitle.trim() || saving) return;
		setSaving(true);
		try {
			const confirmedNewSkills = selectedNewSkillIndices
				.map((idx) => draftNewSkills[idx])
				.filter((s): s is NewSkillDraftDto => Boolean(s?.name.trim() && s.description.trim() && s.body.trim()));
			const res = await createMember({
				id: draft.template.title === roleTitle.trim() ? draft.template.id : undefined,
				name: roleName.trim(),
				title: roleTitle.trim(),
				roleScope: activeScopeChoice.roleScope,
				ownerOrgId: activeScopeChoice.ownerOrgId,
				responsibilities: draft.template.sections.responsibilitiesAndBoundaries,
				keywords: keywordsText
					.split(/[,，\s]+/)
					.map((s) => s.trim())
					.filter(Boolean),
				skills: draft.template.skills,
				...(confirmedNewSkills.length > 0 ? { newSkills: confirmedNewSkills } : {}),
				mcpDependencies: draft.template.mcpDependencies,
				tools: draft.template.tools,
				antiJobs: draft.antiJobs,
				sections: draft.template.sections,
				isPrimaryContact: activeScopeChoice.roleScope === "global" && isPrimaryContact,
			});
			onNotice(
				`已创建「${res.member.displayName}」${confirmedNewSkills.length > 0 ? `并生成 ${confirmedNewSkills.length} 项 Skill` : ""}`,
			);
			await onCreated(res.member);
			onClose();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	const previewCoreJob =
		cleanSectionLines(draft?.template.sections.responsibilitiesAndBoundaries).find(
			(line) => !line.startsWith("不做 / 边界"),
		) ?? oneJob.trim();
	const previewMethods = cleanSectionLines(draft?.template.sections.skillsAndMethods);

	return (
		<div className="architect-modal-backdrop">
			<button type="button" className="architect-modal-scrim" aria-label="关闭弹窗" onClick={onClose} />
			<div className="architect-modal-card" role="dialog" aria-modal="true" aria-label="快速创建角色">
				<div className="banner-row">
					<div className="architect-header-title-wrap">
						<h2 className="ui-card-title architect-modal-title">快速创建单个角色</h2>
						<span className="pill">离线可用 · 现有 {businessMembers.length} 位业务成员</span>
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
								按工作流规划多个角色？进对话 →
							</button>
						)}
						<button type="button" className="btn-inline" onClick={onClose}>
							关闭
						</button>
					</div>
				</div>

				{businessMembers.length > 0 && (
					<section className="architect-roster-strip" aria-label="当前已有业务成员">
						{businessMembers.map((member) => {
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

				{seedGap && (
					<div className="notice-card architect-gap-banner">
						<strong>缺口提示：</strong>
						<span>{seedGap.reason}</span>
					</div>
				)}

				<div className="architect-form-body">
					<label className="identity-field">
						<span className="identity-field-label">角色使用范围（Role Scope）</span>
						<select
							className="input-field"
							value={activeScopeChoice.key}
							onChange={(e) => {
								setSelectedScopeKey(e.target.value);
								setDraft(null);
								setDraftNewSkills([]);
								setSelectedNewSkillIndices([]);
								setIsPrimaryContact(false);
							}}
						>
							{scopeChoices.map((choice) => (
								<option key={choice.key} value={choice.key}>
									{choice.label}
								</option>
							))}
						</select>
					</label>
					<div className="form-grid">
						<label className="identity-field">
							<span className="identity-field-label">角色名称（可选，不填按职责提炼）</span>
							<input
								className="input-field"
								placeholder="例如：发布部署官 / 合同风控官"
								value={roleName}
								onChange={(e) => {
									setRoleName(e.target.value);
									setDraft(null);
								}}
							/>
						</label>
						<label className="identity-field">
							<span className="identity-field-label">英文头衔（可选，决定标识与 Git 邮箱）</span>
							<input
								className="input-field"
								placeholder="例如：Release Ops / Compliance Reviewer"
								value={roleTitle}
								onChange={(e) => {
									setRoleTitle(e.target.value);
									setDraft(null);
								}}
							/>
						</label>
					</div>

					<label className="identity-field">
						<span className="identity-field-label">它专职负责哪件事？（One Job）</span>
						<input
							className="input-field"
							placeholder="例如：检查 CI 通过后的发布配置与上线执行；或：只负责合同条款合规核查"
							value={oneJob}
							onChange={(e) => {
								setOneJob(e.target.value);
								setDraft(null);
							}}
						/>
					</label>

					<div className="architect-section-block">
						<div className="banner-row">
							<span className="identity-field-label">允许使用的工具权限范围</span>
							<span className="muted-tiny">参与方式（主责 / 协同 / 旁听）可在每次发起或推进事项时灵活指派</span>
						</div>
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

					<div className="architect-advanced-grid">
						<label className="identity-field">
							<span className="identity-field-label">团队流程 / 门槛要求（可选）</span>
							<input
								className="input-field"
								placeholder="如：须 CI 通过后方可部署"
								value={workflowRules}
								onChange={(e) => {
									setWorkflowRules(e.target.value);
									setDraft(null);
								}}
							/>
						</label>
						<label className="identity-field">
							<span className="identity-field-label">附加不做边界（可选）</span>
							<input
								className="input-field"
								placeholder="如：不直接改动生产数据库"
								value={extraBoundary}
								onChange={(e) => {
									setExtraBoundary(e.target.value);
									setDraft(null);
								}}
							/>
						</label>
					</div>

					<div className="ui-row-actions">
						{generating ? (
							<>
								<button type="button" className="btn-pill-dark" disabled>
									AI 正在设计角色草案…
								</button>
								<button type="button" className="btn-stop-pill" onClick={handleCancelAiDesign}>
									取消生成
								</button>
							</>
						) : (
							<button
								type="button"
								className="btn-pill-dark"
								disabled={!oneJob.trim() || generating}
								onClick={() => setConfirmAiDesign(true)}
							>
								AI 智能设计草案
							</button>
						)}
					</div>
					{confirmAiDesign && !generating && (
						<div className="notice-card architect-gap-banner">
							<span>
								将调用 Pi 决策模型结合团队现有人选与已安装 Skills 生成名称、英文头衔、边界与验证计划（约数秒）：
							</span>
							<div className="ui-row-actions">
								<button
									type="button"
									className="btn-pill-dark btn-xs"
									onClick={() => void handleGenerateDraft()}
								>
									确认 AI 设计
								</button>
								<button type="button" className="btn-inline btn-xs" onClick={() => setConfirmAiDesign(false)}>
									取消
								</button>
							</div>
						</div>
					)}

					{draft && (
						<div className="architect-preview-box">
							<div className="architect-preview-head">
								<strong>确认并微调新角色配置</strong>
								<div className="architect-preview-badges">
									<span className={`pill ${draft.designSource === "model" ? "live" : ""}`}>
										{draft.designSource === "model" ? "AI 角色设计" : "模型不可用 · 本地草案"}
									</span>
									<span className="pill">ID：{draft.template.id}</span>
									<span className="pill">
										工具：{draft.template.tools.length > 0 ? draft.template.tools.join(", ") : "无工具"}
									</span>
								</div>
							</div>

							<RoleCapabilityDetails draft={draft} />
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
									<span className="identity-field-label">英文头衔</span>
									<input
										className="input-field"
										value={roleTitle}
										onChange={(e) => setRoleTitle(e.target.value)}
									/>
								</label>
							</div>

							<label className="identity-field">
								<span className="identity-field-label">自动派活触发关键词（逗号分隔）</span>
								<input
									className="input-field"
									placeholder="如：部署, CI, 发布, release"
									value={keywordsText}
									onChange={(e) => setKeywordsText(e.target.value)}
								/>
							</label>

							<div className="architect-preview-grid">
								<div className="architect-preview-pane">
									<h4>核心职责与工作约定</h4>
									<p className="architect-preview-copy">{previewCoreJob}</p>
									{previewMethods.length > 0 && (
										<ul className="architect-preview-list">
											{previewMethods.map((line) => (
												<li key={line}>{line}</li>
											))}
										</ul>
									)}
								</div>
								<div className="architect-preview-pane">
									<h4>不做边界（Anti-Jobs）与权限</h4>
									<p className="architect-preview-copy">{draft.toolSummary}</p>
									{draft.antiJobs.length > 0 && (
										<ul className="architect-preview-list">
											{draft.antiJobs.map((rule) => (
												<li key={rule}>{rule}</li>
											))}
										</ul>
									)}
								</div>
							</div>

							<NewSkillsDraftSection
								skills={draftNewSkills}
								selectedIndices={selectedNewSkillIndices}
								roleScope={activeScopeChoice.roleScope}
								isSuperAdmin={isSuperAdmin}
								disabled={saving}
								onToggle={(idx) =>
									setSelectedNewSkillIndices((prev) =>
										prev.includes(idx) ? prev.filter((item) => item !== idx) : [...prev, idx],
									)
								}
								onChangeSkills={setDraftNewSkills}
								onAddCustomSkill={() => {
									const nextIndex = draftNewSkills.length;
									const suffix = nextIndex > 0 ? `-${nextIndex + 1}` : "";
									setDraftNewSkills((prev) => [
										...prev,
										{
											name: `custom-skill${suffix}`,
											description: `${roleTitle.trim() || "Role"} SOP checklist`,
											body: `# Custom Method\n\n1. Verify inputs\n2. Produce structured verdict`,
											storageScope: "role_local",
										},
									]);
									setSelectedNewSkillIndices((prev) => [...prev, nextIndex]);
								}}
							/>

							<div className="form-footer">
								{activeScopeChoice.roleScope === "global" ? (
									<label className="checkbox-label">
										<input
											type="checkbox"
											checked={isPrimaryContact}
											onChange={(e) => setIsPrimaryContact(e.target.checked)}
										/>
										<span>设为默认主联系人</span>
									</label>
								) : (
									<span className="muted-tiny">当前使用范围：{activeScopeChoice.label}</span>
								)}
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
			</div>
		</div>
	);
}
