import { useId, useState } from "react";
import type {
	CollaborationPresetMode,
	CollaboratorDto,
	MatterInitiationAssessmentDto,
	MatterVisibility,
	OrganizationMemberDto,
	RoleGapSuggestionDto,
	RoleTemplateDto,
	TeamMemberDto,
} from "../../api.ts";
import { filterBusinessMembers, isArchitectMemberId } from "../../architectApi.ts";

interface MatterInitiationPanelProps {
	isOwner: boolean;
	members: TeamMemberDto[];
	nonOwnerCollaborators: CollaboratorDto[];
	orgMembers?: OrganizationMemberDto[];
	draftVisibility?: MatterVisibility;
	templateByRoleId: Map<string, RoleTemplateDto>;
	selectedMemberId: string;
	composerMode: "discussion" | "dispatch";
	discussionAiEnabled?: boolean;
	hasWorkspace?: boolean;
	hasPromptText?: boolean;
	draftAiMemberIds: string[] | null;
	draftConsultMemberIds?: string[] | null;
	draftObserverMemberIds: string[];
	draftCollaboratorIds: string[];
	assessment: MatterInitiationAssessmentDto | null;
	assessing: boolean;
	assessmentError?: string | null;
	modelAssessing?: boolean;
	modelAssessmentError?: string | null;
	onSelectLeadMember: (memberId: string) => void;
	onSetScopeMode?: (scope: "solo" | "team") => void;
	onToggleObserverPreset?: () => void;
	onToggleDraftMemberConsult?: (memberId: string, enabled: boolean) => void;
	onToggleDraftMemberObserver?: (memberId: string, enabled: boolean) => void;
	onApplyPresetMode: (mode: CollaborationPresetMode) => void;
	onUpdateDraftAiMemberIds: (ids: string[] | null) => void;
	onUpdateDraftObserverIds: (ids: string[]) => void;
	onUpdateDraftCollaboratorIds: (ids: string[]) => void;
	onUpdateDraftVisibility?: (visibility: MatterVisibility) => void;
	onApplyRecommendation: () => void;
	onRequestModelAssessment?: (options?: { readRepo?: boolean }) => void;
	onCancelModelAssessment?: () => void;
	onOpenArchitect: (gap?: RoleGapSuggestionDto) => void;
	onStartArchitectMatter?: (seedText?: string) => void;
}

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
		discussionAiEnabled = true,
		hasWorkspace = false,
		hasPromptText = false,
		draftAiMemberIds,
		draftConsultMemberIds = null,
		draftObserverMemberIds,
		draftCollaboratorIds,
		assessment,
		assessing,
		assessmentError,
		modelAssessing = false,
		modelAssessmentError,
		onSelectLeadMember,
		onSetScopeMode,
		onToggleObserverPreset,
		onToggleDraftMemberConsult,
		onToggleDraftMemberObserver,
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
		orgMembers = [],
		draftVisibility = "org",
		onUpdateDraftVisibility,
	} = props;
	if (!isOwner || isArchitectMemberId(selectedMemberId, members, templateByRoleId)) return null;
	const business = filterBusinessMembers(members, templateByRoleId);
	const allowed = draftAiMemberIds ?? business.map((member) => member.id);
	const lead =
		business.find((member) => member.id === selectedMemberId) ??
		business.find((member) => member.isPrimaryContact && allowed.includes(member.id)) ??
		business.find((member) => allowed.includes(member.id));
	const leadId = lead?.id;
	const nonLeadIds = business.map((member) => member.id).filter((id) => id !== leadId);
	const observers = draftObserverMemberIds.filter((id) => nonLeadIds.includes(id) && allowed.includes(id));
	const consultIds =
		draftConsultMemberIds === null
			? allowed.filter((id) => id !== leadId && nonLeadIds.includes(id))
			: draftConsultMemberIds.filter((id) => id !== leadId && nonLeadIds.includes(id));
	const isDiscussion = composerMode === "discussion";
	const isSoloScope = consultIds.length === 0;
	const hasObservers = observers.length > 0;
	const consultCount = consultIds.length;
	const teamSummary =
		isSoloScope && !hasObservers
			? "仅一位主责，不委托其他成员，也不开启旁听。"
			: `${consultCount > 0 ? `可按需请教 ${consultCount} 位成员` : "不主动请教其他成员"}${observers.length ? `，${observers.length} 位成员旁听把关` : "，不自动旁听"}。`;
	const description = isDiscussion
		? discussionAiEnabled
			? `团队讨论已开启 AI 探讨（不自动改码交付）· ${teamSummary}`
			: "当前为纯人类聊天讨论，不调用 AI 模型（可随时切到上方开启 AI 参与）。"
		: teamSummary;
	const applied =
		assessment &&
		!assessing &&
		(isDiscussion
			? assessment.recommendedMode === "human_first"
			: (observers.length > 0 ? "lead_review" : consultIds.length > 0 ? "lead_consult" : "solo") ===
					assessment.recommendedMode &&
				selectedMemberId === assessment.recommendedLeadId &&
				sameIds(allowed, assessment.recommendedAiMemberIds) &&
				sameIds(observers, assessment.recommendedObserverIds));
	const setRoleFlag = (memberId: string, kind: "consult" | "observer", enabled: boolean) => {
		if (memberId === leadId) return;
		if (kind === "consult" && onToggleDraftMemberConsult) {
			onToggleDraftMemberConsult(memberId, enabled);
			return;
		}
		if (kind === "observer" && onToggleDraftMemberObserver) {
			onToggleDraftMemberObserver(memberId, enabled);
			return;
		}
		const nextConsult =
			kind === "consult"
				? enabled
					? [...new Set([...consultIds, memberId])]
					: consultIds.filter((id) => id !== memberId)
				: consultIds;
		const nextObservers =
			kind === "observer"
				? enabled
					? [...new Set([...observers, memberId])]
					: observers.filter((id) => id !== memberId)
				: observers;
		const nextAi = [...new Set([...(leadId ? [leadId] : []), ...nextConsult, ...nextObservers])];
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
							? discussionAiEnabled
								? `团队聊天讨论 · ${selectedMemberId === "auto" ? "主责自动匹配" : `${lead?.displayName ?? "主联系人"}主谈`}`
								: "团队聊天讨论 · 纯人类交流"
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
											<button
												type="button"
												className="btn-pill-outline btn-xs"
												onClick={() => {
													setReadRepoForDecision(hasWorkspace);
													setConfirmModel(true);
												}}
											>
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
											? `由 Pi 决策模型基于职责与不做边界判断${assessment.usedRepoRead ? `（已读取：${assessment.repoReadPaths?.join("、") ?? "仓库文件"}）` : assessment.repoReadEnabled ? "（已允许读取，但无成功读取仓库文件的记录）" : "（未读取仓库文件）"}。建议不会自动替换当前设置。`
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
					<div className="initiation-scope-bar">
						<fieldset className="initiation-mode-pills" aria-label="协作范围">
							<button
								type="button"
								className={`choice-chip ${isSoloScope ? "active" : ""}`}
								aria-pressed={isSoloScope}
								title="仅一位主责处理，保留旁听安排"
								onClick={() => (onSetScopeMode ? onSetScopeMode("solo") : onApplyPresetMode("solo"))}
							>
								一人处理
							</button>
							<button
								type="button"
								className={`choice-chip ${!isSoloScope ? "active" : ""}`}
								aria-pressed={!isSoloScope}
								title="团队分工协作，可自由勾选「按需请教」与「旁听把关」，两者可叠加"
								onClick={() => (onSetScopeMode ? onSetScopeMode("team") : onApplyPresetMode("lead_consult"))}
							>
								团队协作
							</button>
						</fieldset>
						<button
							type="button"
							className={`choice-chip initiation-observer-chip ${hasObservers ? "active" : ""}`}
							aria-pressed={hasObservers}
							title={
								hasObservers
									? "已启用旁听把关（不清空按需请教名单）；点击关闭全部旁听"
									: "叠加开启旁听把关，主责回复后由旁听成员检查风险，保留现有按需请教配置"
							}
							onClick={() =>
								onToggleObserverPreset ? onToggleObserverPreset() : onApplyPresetMode("lead_review")
							}
						>
							{hasObservers ? `✓ 旁听把关 (${observers.length})` : "+ 旁听把关"}
						</button>
					</div>
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
									const remainingObservers = observers.filter((id) => id !== next);
									onUpdateDraftAiMemberIds([
										...new Set([next, ...(isSoloScope ? remainingObservers : allowed)]),
									]);
									onUpdateDraftObserverIds(remainingObservers);
								}
							}}
						>
							{!isSoloScope && <option value="auto">按任务内容自动匹配</option>}
							{business.map((member) => (
								<option key={member.id} value={member.id}>
									{member.displayName}
								</option>
							))}
						</select>
					</label>
					{business.length > 1 && (
						<fieldset className="initiation-role-rows" aria-label="成员按需请教与旁听把关配置">
							{business
								.filter((member) => member.id !== leadId)
								.map((member) => {
									const isConsult = consultIds.includes(member.id);
									const isObserver = observers.includes(member.id);
									return (
										<div key={member.id} className="initiation-role-row">
											<span className="initiation-role-name">{member.displayName}</span>
											<div className="initiation-role-toggles">
												<label className={`role-flag-pill ${isConsult ? "active" : ""}`}>
													<input
														type="checkbox"
														checked={isConsult}
														aria-label={`${member.displayName}按需请教`}
														onChange={(e) => setRoleFlag(member.id, "consult", e.target.checked)}
													/>
													<span>按需请教</span>
												</label>
												<label className={`role-flag-pill observer ${isObserver ? "active" : ""}`}>
													<input
														type="checkbox"
														checked={isObserver}
														aria-label={`${member.displayName}旁听把关`}
														onChange={(e) => setRoleFlag(member.id, "observer", e.target.checked)}
													/>
													<span>旁听把关</span>
												</label>
											</div>
										</div>
									);
								})}
						</fieldset>
					)}
					<div className="initiation-compact-footer">
						{onUpdateDraftVisibility && (
							<div className="initiation-human-row">
								<span className="initiation-mini-label">事项范围</span>
								<button
									type="button"
									className={`choice-chip ${draftVisibility === "org" ? "active" : ""}`}
									aria-pressed={draftVisibility === "org"}
									onClick={() => onUpdateDraftVisibility("org")}
								>
									组织内可见
								</button>
								<button
									type="button"
									className={`choice-chip ${draftVisibility === "private" ? "active" : ""}`}
									aria-pressed={draftVisibility === "private"}
									onClick={() => onUpdateDraftVisibility("private")}
								>
									仅指定成员私密
								</button>
							</div>
						)}
						{(orgMembers.length > 0 || nonOwnerCollaborators.length > 0) && (
							<div className="initiation-human-row">
								<span className="initiation-mini-label">人类成员</span>
								{orgMembers.map((member) => (
									<button
										key={member.userId}
										type="button"
										className={`choice-chip ${draftCollaboratorIds.includes(member.userId) ? "active" : ""}`}
										aria-pressed={draftCollaboratorIds.includes(member.userId)}
										onClick={() =>
											onUpdateDraftCollaboratorIds(
												draftCollaboratorIds.includes(member.userId)
													? draftCollaboratorIds.filter((id) => id !== member.userId)
													: [...draftCollaboratorIds, member.userId],
											)
										}
									>
										{member.displayName ?? member.email ?? member.userId}
									</button>
								))}
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
