import { useId, useState } from "react";
import type {
	CollaborationPresetMode,
	CollaboratorDto,
	MatterInitiationAssessmentDto,
	RoleGapSuggestionDto,
	RoleTemplateDto,
	TeamMemberDto,
} from "../../api.ts";
import { filterBusinessMembers, isArchitectMemberId } from "../../architectApi.ts";

interface MatterInitiationPanelProps {
	isOwner: boolean;
	members: TeamMemberDto[];
	nonOwnerCollaborators: CollaboratorDto[];
	templateByRoleId: Map<string, RoleTemplateDto>;
	selectedMemberId: string;
	composerMode: "discussion" | "dispatch";
	hasWorkspace?: boolean;
	hasPromptText?: boolean;
	draftPresetMode: CollaborationPresetMode;
	draftAiMemberIds: string[] | null;
	draftObserverMemberIds: string[];
	draftCollaboratorIds: string[];
	assessment: MatterInitiationAssessmentDto | null;
	assessing: boolean;
	assessmentError?: string | null;
	modelAssessing?: boolean;
	modelAssessmentError?: string | null;
	onSelectLeadMember: (memberId: string) => void;
	onApplyPresetMode: (mode: CollaborationPresetMode) => void;
	onUpdateDraftAiMemberIds: (ids: string[] | null) => void;
	onUpdateDraftObserverIds: (ids: string[]) => void;
	onUpdateDraftCollaboratorIds: (ids: string[]) => void;
	onApplyRecommendation: () => void;
	onRequestModelAssessment?: (options?: { readRepo?: boolean }) => void;
	onCancelModelAssessment?: () => void;
	onOpenArchitect: (gap?: RoleGapSuggestionDto) => void;
	onStartArchitectMatter?: (seedText?: string) => void;
}

const PRESET_OPTIONS: Array<{ id: CollaborationPresetMode; label: string; hint: string }> = [
	{ id: "solo", label: "一人处理", hint: "一位主责处理，不委托其他成员，也不开启旁听" },
	{ id: "lead_consult", label: "按需请教", hint: "主责自行判断是否请教可参与成员，不会全员同时执行" },
	{ id: "lead_review", label: "加人旁听", hint: "主责完成回复后，指定成员按需检查风险并补充" },
	{ id: "human_first", label: "先讨论", hint: "仅发送团队讨论，不启动 AI" },
];
const sameIds = (a: string[], b: string[]) => [...new Set(a)].sort().join("\0") === [...new Set(b)].sort().join("\0");

/** Actual send configuration stays primary; optional local rule or explicit Pi LLM decision sits beside it. */
export function MatterInitiationPanel(props: MatterInitiationPanelProps) {
	const [expanded, setExpanded] = useState(false);
	const [confirmModel, setConfirmModel] = useState(false);
	const [readRepoForDecision, setReadRepoForDecision] = useState(false);
	const rosterId = useId();
	const {
		isOwner,
		members,
		templateByRoleId,
		selectedMemberId,
		composerMode,
		hasWorkspace = false,
		hasPromptText = false,
		draftPresetMode,
		draftAiMemberIds,
		draftObserverMemberIds,
		draftCollaboratorIds,
		assessment,
		assessing,
		assessmentError,
		modelAssessing = false,
		modelAssessmentError,
		onSelectLeadMember,
		onApplyPresetMode,
		onUpdateDraftAiMemberIds,
		onUpdateDraftObserverIds,
		onUpdateDraftCollaboratorIds,
		onApplyRecommendation,
		onRequestModelAssessment,
		onCancelModelAssessment,
		onOpenArchitect,
		onStartArchitectMatter,
		nonOwnerCollaborators,
	} = props;
	if (!isOwner || isArchitectMemberId(selectedMemberId, members, templateByRoleId)) return null;
	const business = filterBusinessMembers(members, templateByRoleId);
	const allowed = draftAiMemberIds ?? business.map((member) => member.id);
	const suggestedLead = business.find(
		(member) => member.id === assessment?.recommendedLeadId && allowed.includes(member.id),
	);
	const lead =
		business.find((member) => member.id === selectedMemberId) ??
		suggestedLead ??
		business.find((member) => member.isPrimaryContact && allowed.includes(member.id)) ??
		business.find((member) => allowed.includes(member.id));
	const leadId = lead?.id;
	const observers = draftObserverMemberIds.filter((id) => allowed.includes(id) && id !== leadId);
	const isDiscussion = composerMode === "discussion";
	const activeMode = isDiscussion
		? "human_first"
		: draftPresetMode === "human_first"
			? "lead_consult"
			: draftPresetMode;
	const consultCount = Math.max(0, allowed.filter((id) => id !== leadId && !observers.includes(id)).length);
	const description = isDiscussion
		? "这次只发给团队讨论，不启动 AI。"
		: activeMode === "solo"
			? "由一位 AI 处理，不委托其他成员，也不开启旁听。"
			: `${consultCount > 0 ? `可按需请教 ${consultCount} 位成员` : "由主责处理"}${observers.length ? `，${observers.length} 位成员旁听` : "，不自动旁听"}。`;
	const applied =
		assessment &&
		!assessing &&
		(isDiscussion
			? assessment.recommendedMode === "human_first"
			: activeMode === assessment.recommendedMode &&
				selectedMemberId === assessment.recommendedLeadId &&
				sameIds(allowed, assessment.recommendedAiMemberIds) &&
				sameIds(observers, assessment.recommendedObserverIds));
	const setStanding = (memberId: string, standing: string) => {
		if (memberId === leadId) return;
		const nextAi =
			standing === "excluded"
				? allowed.filter((id) => id !== memberId)
				: [...new Set([...(leadId ? [leadId] : []), ...allowed, memberId])];
		const nextObservers =
			standing === "observer" ? [...new Set([...observers, memberId])] : observers.filter((id) => id !== memberId);
		onUpdateDraftAiMemberIds(nextAi);
		onUpdateDraftObserverIds(nextObservers);
	};
	const name = (id: string | null) => business.find((member) => member.id === id)?.displayName ?? "主联系人";
	const recommendation =
		assessment?.recommendedMode === "human_first"
			? "先讨论，再决定是否安排 AI"
			: `${name(assessment?.recommendedLeadId ?? null)}${assessment?.recommendedMode === "solo" ? "独立处理" : assessment?.recommendedMode === "lead_review" ? "牵头，增加定向旁听" : "牵头，按需请教相关成员"}`;
	const isModelResult = assessment?.assessmentSource === "model";
	const confidenceLabel =
		assessment?.confidence === "high" ? "高把握" : assessment?.confidence === "low" ? "低把握" : "中把握";
	const showAssessmentBar =
		assessing || assessment || assessmentError || modelAssessing || modelAssessmentError || confirmModel;

	return (
		<section className="initiation-panel" aria-label="新事项参与安排">
			<div className="initiation-current-row">
				<div className="initiation-current-copy">
					<strong>
						{isDiscussion
							? "先和团队讨论"
							: selectedMemberId === "auto"
								? "主责自动匹配"
								: `${lead?.displayName ?? "主联系人"}负责`}
					</strong>
					<span>{description}</span>
				</div>
				<button
					type="button"
					className="btn-inline"
					aria-expanded={expanded}
					aria-controls={rosterId}
					onClick={() => setExpanded(!expanded)}
				>
					{expanded ? "收起设置" : "调整参与方式"}
				</button>
			</div>
			{showAssessmentBar && (
				<section
					className={`initiation-assessment-bar${assessment?.fitStatus === "gap_detected" ? " is-gap" : ""}`}
					aria-label="参与建议"
				>
					{modelAssessing ? (
						<div className="initiation-recommendation-row">
							<span className="initiation-assess-note">正在通过 Pi 决策模型分析需求与角色边界…</span>
							{onCancelModelAssessment && (
								<button type="button" className="btn-inline" onClick={onCancelModelAssessment}>
									取消分析
								</button>
							)}
						</div>
					) : assessing ? (
						<span className="initiation-assess-note">正在匹配文字建议…</span>
					) : assessmentError ? (
						<span className="initiation-assess-note">{assessmentError}</span>
					) : (
						assessment && (
							<>
								<div className="initiation-recommendation-row">
									<span className="initiation-recommend-text">
										{applied ? (
											"当前安排已采用建议"
										) : assessment.fitStatus === "gap_detected" ? (
											isModelResult ? (
												`AI 决策：岗位覆盖待确认 · ${assessment.gapSuggestion?.missingRoleTitle ?? "建议补齐角色"}`
											) : (
												"岗位覆盖待确认"
											)
										) : (
											<>
												{isModelResult ? `AI 决策建议（${confidenceLabel}）` : "可选建议（本地规则）"}：
												{recommendation}
											</>
										)}
									</span>
									<div className="initiation-recommend-actions">
										{!applied && assessment.fitStatus !== "gap_detected" && (
											<button type="button" className="btn-inline" onClick={onApplyRecommendation}>
												使用建议
											</button>
										)}
										{assessment.fitStatus === "gap_detected" && (
											<button
												type="button"
												className="btn-inline"
												onClick={() =>
													onStartArchitectMatter
														? onStartArchitectMatter(
																`请围绕这项工作规划角色：${assessment.gapSuggestion?.suggestedJob ?? assessment.headline}`,
															)
														: onOpenArchitect(assessment.gapSuggestion)
												}
											>
												请架构师协助
											</button>
										)}
										{onRequestModelAssessment && hasPromptText && !confirmModel && (
											<button type="button" className="btn-inline" onClick={() => setConfirmModel(true)}>
												{isModelResult ? "重新 AI 决策" : "请 AI 决策阵型"}
											</button>
										)}
									</div>
								</div>
								{confirmModel && hasPromptText && (
									<div className="initiation-model-confirm">
										<span>将调用 Pi 决策模型评估团队分工与阵型（约数秒）：</span>
										{hasWorkspace && (
											<label className="initiation-repo-check">
												<input
													type="checkbox"
													checked={readRepoForDecision}
													onChange={(e) => setReadRepoForDecision(e.target.checked)}
												/>
												<span>只读参考仓库入口文件</span>
											</label>
										)}
										<div className="initiation-recommend-actions">
											<button
												type="button"
												className="btn-pill-dark btn-xs"
												onClick={() => {
													setConfirmModel(false);
													onRequestModelAssessment?.({ readRepo: readRepoForDecision });
												}}
											>
												确认分析
											</button>
											<button type="button" className="btn-inline" onClick={() => setConfirmModel(false)}>
												取消
											</button>
										</div>
									</div>
								)}
								{modelAssessmentError && <p className="initiation-model-error">{modelAssessmentError}</p>}
								<details className="initiation-basis">
									<summary>为什么这样建议？</summary>
									<p>{assessment.explanation}</p>
									<p>
										{isModelResult
											? `由 Pi 决策模型基于职责与不做边界判断${assessment.usedRepoRead ? "（已开启只读仓库参考）" : "（未读取仓库文件）"}。建议不会自动替换当前设置。`
											: "以上为本地文字规则预判，不调用模型、不读取仓库；建议不会自动替换当前设置，未命中关键词不代表成员无法胜任。"}
									</p>
								</details>
							</>
						)
					)}
				</section>
			)}
			{expanded && (
				<div id={rosterId} className="initiation-roster-drawer compact">
					<fieldset className="initiation-mode-pills" aria-label="参与方式">
						{PRESET_OPTIONS.map((option) => (
							<button
								key={option.id}
								type="button"
								className={`choice-chip ${activeMode === option.id ? "active" : ""}`}
								aria-pressed={activeMode === option.id}
								title={option.hint}
								onClick={() => onApplyPresetMode(option.id)}
							>
								{option.label}
							</button>
						))}
					</fieldset>
					<label className="initiation-lead-picker">
						<span>主责</span>
						<select
							className="wechat-row-select"
							aria-label="新事项主责 AI"
							value={selectedMemberId === "auto" ? "auto" : (leadId ?? "")}
							onChange={(event) => {
								const next = event.target.value;
								onSelectLeadMember(next);
								if (next !== "auto") {
									onUpdateDraftAiMemberIds(activeMode === "solo" ? [next] : [...new Set([next, ...allowed])]);
									onUpdateDraftObserverIds(observers.filter((id) => id !== next));
								}
							}}
						>
							{activeMode !== "solo" && <option value="auto">按任务内容自动匹配</option>}
							{business.map((member) => (
								<option key={member.id} value={member.id}>
									{member.displayName}
								</option>
							))}
						</select>
					</label>
					{activeMode !== "solo" && activeMode !== "human_first" && (
						<div className="initiation-role-rows">
							{business
								.filter((member) => member.id !== leadId)
								.map((member) => (
									<label key={member.id} className="initiation-role-row">
										<span>{member.displayName}</span>
										<select
											className="select-pill"
											aria-label={`${member.displayName}参与方式`}
											value={
												!allowed.includes(member.id)
													? "excluded"
													: observers.includes(member.id)
														? "observer"
														: "consult"
											}
											onChange={(event) => setStanding(member.id, event.target.value)}
										>
											<option value="excluded">不参与</option>
											<option value="consult">按需请教</option>
											<option value="observer">旁听把关</option>
										</select>
									</label>
								))}
						</div>
					)}
					<div className="initiation-compact-footer">
						{nonOwnerCollaborators.length > 0 && (
							<div className="initiation-human-row">
								<span className="initiation-mini-label">人类同事</span>
								{nonOwnerCollaborators.map((collaborator) => (
									<button
										key={collaborator.id}
										type="button"
										className={`choice-chip ${draftCollaboratorIds.includes(collaborator.id) ? "active" : ""}`}
										aria-pressed={draftCollaboratorIds.includes(collaborator.id)}
										onClick={() =>
											onUpdateDraftCollaboratorIds(
												draftCollaboratorIds.includes(collaborator.id)
													? draftCollaboratorIds.filter((id) => id !== collaborator.id)
													: [...draftCollaboratorIds, collaborator.id],
											)
										}
									>
										{collaborator.name}
									</button>
								))}
							</div>
						)}
						<button
							type="button"
							className="btn-inline"
							onClick={() => (onStartArchitectMatter ? onStartArchitectMatter() : onOpenArchitect())}
						>
							需要补充专职角色？
						</button>
					</div>
				</div>
			)}
		</section>
	);
}
