import { useId, useState } from "react";
import type {
	CollaborationPresetMode,
	MatterCollaborationMode,
	MatterInitiationAssessmentDto,
	MatterVisibility,
	OrganizationMemberDto,
	RoleTemplateDto,
	TeamMemberDto,
} from "../../api.ts";
import { filterBusinessMembers, isArchitectMemberId, isSoloMemberId } from "../../architectApi.ts";
import { Button, Select } from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";

interface MatterInitiationPanelProps {
	isOwner: boolean;
	members: TeamMemberDto[];
	orgMembers?: OrganizationMemberDto[];
	initiatorId?: string;
	initiatorName?: string;
	draftVisibility?: MatterVisibility;
	draftCollaborationMode?: MatterCollaborationMode;
	templateByRoleId: Map<string, RoleTemplateDto>;
	selectedMemberId: string;
	observersEnabled?: boolean;
	hasWorkspace?: boolean;
	hasPromptText?: boolean;
	draftAiMemberIds: string[] | null;
	draftConsultMemberIds?: string[] | null;
	draftObserverMemberIds: string[];
	draftCollaboratorIds: string[];
	assessment: MatterInitiationAssessmentDto | null;
	modelAssessing?: boolean;
	modelAssessmentError?: string | null;
	onSelectLeadMember: (memberId: string) => void;
	onSetScopeMode?: (scope: "solo" | "team") => void;
	onToggleObserverPreset?: () => void;
	onToggleDraftMemberConsult?: (memberId: string, enabled: boolean) => void;
	onToggleDraftMemberObserver?: (memberId: string, enabled: boolean, observerIds: string[]) => void;
	onApplyPresetMode: (mode: CollaborationPresetMode) => void;
	onUpdateDraftAiMemberIds: (ids: string[] | null) => void;
	onUpdateDraftObserverIds: (ids: string[]) => void;
	onUpdateDraftCollaboratorIds: (ids: string[]) => void;
	onUpdateDraftVisibility?: (visibility: MatterVisibility) => void;
	onUpdateDraftCollaborationMode?: (mode: MatterCollaborationMode) => void;
	onApplyRecommendation: () => void;
	onRequestModelAssessment?: (options?: { readRepo?: boolean }) => void;
	onCancelModelAssessment?: () => void;
	onStartArchitectMatter?: (seedText?: string) => void;
}

const sameIds = (a: string[], b: string[]) => [...new Set(a)].sort().join("\0") === [...new Set(b)].sort().join("\0");

const CHIP_BASE =
	"inline-flex items-center border rounded-pill px-2.5 py-1 text-xs cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-accent";
const CHIP_ACTIVE = "border-accent bg-accent-soft text-accent font-semibold";
const CHIP_IDLE = "border-line bg-stage text-ink-secondary hover:border-line-strong hover:text-ink";

/** Actual send configuration stays primary; optional local rule or explicit Pi LLM decision sits beside it. */
export function MatterInitiationPanel(props: MatterInitiationPanelProps) {
	const [expanded, setExpanded] = useState(false);
	const [confirmModel, setConfirmModel] = useState(false);
	const [readRepoForDecision, setReadRepoForDecision] = useState(false);
	const rosterId = useId();
	const leadSelectId = useId();
	const {
		isOwner,
		members,
		templateByRoleId,
		selectedMemberId,
		observersEnabled = false,
		hasWorkspace = false,
		hasPromptText = false,
		draftAiMemberIds,
		draftConsultMemberIds = null,
		draftObserverMemberIds,
		draftCollaboratorIds,
		assessment,
		modelAssessing = false,
		modelAssessmentError,
		onSelectLeadMember,
		onToggleDraftMemberConsult,
		onToggleDraftMemberObserver,
		onUpdateDraftAiMemberIds,
		onUpdateDraftObserverIds,
		onUpdateDraftCollaboratorIds,
		onApplyRecommendation,
		onRequestModelAssessment,
		onCancelModelAssessment,
		onStartArchitectMatter,
		orgMembers = [],
		initiatorId,
		initiatorName,
		draftVisibility = "org",
		draftCollaborationMode = "lead",
		onUpdateDraftVisibility,
		onUpdateDraftCollaborationMode,
	} = props;
	if (
		!isOwner ||
		isArchitectMemberId(selectedMemberId, members, templateByRoleId) ||
		isSoloMemberId(selectedMemberId, members, templateByRoleId)
	)
		return null;
	const business = filterBusinessMembers(members, templateByRoleId);
	const allowed = draftAiMemberIds ?? business.map((member) => member.id);
	const isAutoLead = selectedMemberId === "auto";
	const lead = isAutoLead
		? undefined
		: (business.find((member) => member.id === selectedMemberId) ??
			business.find((member) => member.isPrimaryContact && allowed.includes(member.id)) ??
			business.find((member) => allowed.includes(member.id)));
	const leadId = lead?.id;
	const nonLeadIds = leadId
		? business.map((member) => member.id).filter((id) => id !== leadId)
		: business.map((member) => member.id);
	const observers = draftObserverMemberIds.filter((id) => nonLeadIds.includes(id) && allowed.includes(id));
	const consultIds =
		draftConsultMemberIds === null
			? allowed.filter((id) => id !== leadId && nonLeadIds.includes(id))
			: draftConsultMemberIds.filter((id) => id !== leadId && nonLeadIds.includes(id));
	const isSoloScope = consultIds.length === 0;
	const activeObservers = observersEnabled
		? draftObserverMemberIds.length > 0
			? observers
			: allowed.filter((id) => nonLeadIds.includes(id))
		: [];
	const hasObservers = observersEnabled;
	const consultCount = consultIds.length;
	const teamSummary = isSoloScope
		? "由主责独立处理。"
		: `可按需委托 ${consultCount} 位成员${activeObservers.length ? `，${activeObservers.length} 位旁听` : ""}。`;
	const applied =
		assessment &&
		(assessment.recommendedMode === "human_first"
			? !observersEnabled
			: (hasObservers ? "lead_review" : consultIds.length > 0 ? "lead_consult" : "solo") ===
					assessment.recommendedMode &&
				selectedMemberId === assessment.recommendedLeadId &&
				sameIds(allowed, assessment.recommendedAiMemberIds) &&
				sameIds(activeObservers, assessment.recommendedObserverIds));

	const setRoleFlag = (memberId: string, kind: "consult" | "observer", enabled: boolean) => {
		if (memberId === leadId) return;
		if (kind === "consult" && onToggleDraftMemberConsult) {
			onToggleDraftMemberConsult(memberId, enabled);
			return;
		}
		if (kind === "observer" && onToggleDraftMemberObserver) {
			onToggleDraftMemberObserver(memberId, enabled, observersEnabled ? activeObservers : observers);
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
			? "由主责先澄清需求"
			: `${name(assessment?.recommendedLeadId ?? null)}${assessment?.recommendedMode === "solo" ? "独立处理" : assessment?.recommendedMode === "lead_review" ? "牵头，增加定向旁听" : "牵头，按需请教相关成员"}`;
	const isModelResult = assessment?.assessmentSource === "model";
	const confidenceLabel =
		assessment?.confidence === "high" ? "高把握" : assessment?.confidence === "low" ? "低把握" : "中把握";
	const otherOrgMembers = orgMembers.filter((member) => member.userId !== initiatorId);
	const isBoardMode = draftCollaborationMode === "board";
	const showAssessmentBar =
		!isBoardMode &&
		Boolean(assessment || modelAssessing || modelAssessmentError || confirmModel || onRequestModelAssessment);

	return (
		<section className="flex flex-col gap-3 pt-3.5 border-t border-line min-w-0" aria-label="新事项参与安排">
			<div className="flex items-start sm:items-center justify-between gap-3">
				<div className="flex flex-col gap-0.5 min-w-0">
					<strong className="text-sm font-semibold text-ink">
						{draftCollaborationMode === "board"
							? selectedMemberId === "auto"
								? "团队公告板 · 自动匹配总控"
								: `团队公告板 · ${lead?.displayName ?? "主联系人"}总控`
							: selectedMemberId === "auto"
								? "主责自动匹配"
								: `${lead?.displayName ?? "主联系人"}负责`}
					</strong>
					<span className="text-xs text-ink-secondary leading-normal">
						{draftCollaborationMode === "board"
							? "由 Coordinator 动态切分任务并组建 Builder / Verifier 通过公告板异步协同。"
							: teamSummary}
					</span>
				</div>
				<Button
					variant="inline"
					size="xs"
					aria-expanded={expanded}
					aria-controls={rosterId}
					onClick={() => setExpanded(!expanded)}
				>
					{expanded ? "收起设置" : "调整参与方式"}
				</Button>
			</div>
			{onUpdateDraftCollaborationMode && (
				<fieldset
					className="flex items-center justify-between gap-2 flex-wrap m-0 pt-1.5 border-0 border-t border-line-subtle"
					aria-label="协作模式"
				>
					<span className="text-xs text-ink-muted">协作模式</span>
					<div className="flex items-center gap-1.5 flex-wrap">
						<button
							type="button"
							className={cn(CHIP_BASE, draftCollaborationMode === "lead" ? CHIP_ACTIVE : CHIP_IDLE)}
							aria-pressed={draftCollaborationMode === "lead"}
							onClick={() => onUpdateDraftCollaborationMode("lead")}
						>
							轻量主责
						</button>
						<button
							type="button"
							className={cn(CHIP_BASE, draftCollaborationMode === "board" ? CHIP_ACTIVE : CHIP_IDLE)}
							aria-pressed={draftCollaborationMode === "board"}
							onClick={() => onUpdateDraftCollaborationMode("board")}
						>
							团队公告板 (Board)
						</button>
					</div>
				</fieldset>
			)}
			{showAssessmentBar && (
				<section
					className={cn(
						"px-3 py-2.5 rounded-sm text-xs text-ink-secondary",
						assessment?.fitStatus === "gap_detected" ? "bg-warn-bg text-warn-text" : "bg-sidebar",
					)}
					aria-label="参与建议"
				>
					{modelAssessing ? (
						<div className="flex items-center justify-between gap-3 flex-wrap">
							<span className="min-w-0 leading-normal">正在分析需求和角色分工…</span>
							{onCancelModelAssessment && (
								<Button variant="inline" size="xs" onClick={onCancelModelAssessment}>
									取消分析
								</Button>
							)}
						</div>
					) : (
						<>
							{!assessment && (!confirmModel || !hasPromptText) && onRequestModelAssessment && (
								<div className="flex items-center justify-between gap-3 flex-wrap">
									<span className="min-w-0 leading-normal">
										{hasPromptText
											? "可让 AI 根据需求推荐主责与可委托成员。"
											: "输入需求或添加文字附件后，可让 AI 推荐参与阵型。"}
									</span>
									<Button
										variant="secondary"
										size="xs"
										disabled={!hasPromptText}
										onClick={() => {
											if (hasWorkspace) {
												setReadRepoForDecision(false);
												setConfirmModel(true);
											} else {
												onRequestModelAssessment();
											}
										}}
									>
										请 AI 决策阵型
									</Button>
								</div>
							)}
							{assessment && (
								<>
									<div className="flex items-center justify-between gap-3 flex-wrap">
										<span className="min-w-0">
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
										<div className="inline-flex items-center gap-2 shrink-0 flex-wrap">
											{!applied && assessment.fitStatus !== "gap_detected" && (
												<Button variant="inline" size="xs" onClick={onApplyRecommendation}>
													使用建议
												</Button>
											)}
											{assessment.fitStatus === "gap_detected" && (
												<Button
													variant="inline"
													size="xs"
													onClick={() =>
														onStartArchitectMatter?.(
															`请围绕这项工作规划角色：${assessment.gapSuggestion?.suggestedJob ?? assessment.headline}`,
														)
													}
												>
													请架构师协助
												</Button>
											)}
											{onRequestModelAssessment && hasPromptText && !confirmModel && (
												<Button
													variant="secondary"
													size="xs"
													onClick={() => {
														if (hasWorkspace) {
															setReadRepoForDecision(false);
															setConfirmModel(true);
														} else {
															onRequestModelAssessment();
														}
													}}
												>
													{isModelResult ? "重新 AI 决策" : "请 AI 决策阵型"}
												</Button>
											)}
										</div>
									</div>
									<details className="mt-2">
										<summary className="w-fit cursor-pointer text-accent select-none">
											为什么这样建议？
										</summary>
										<p className="mt-2 mb-0 leading-relaxed">{assessment.explanation}</p>
										<p className="mt-2 mb-0 leading-relaxed">
											{isModelResult
												? `基于职责与协作边界判断${assessment.usedRepoRead ? `（已读取：${assessment.repoReadPaths?.join("、") ?? "仓库文件"}）` : assessment.repoReadEnabled ? "（已允许读取，但无成功读取仓库文件的记录）" : "（未读取仓库文件）"}。建议不会自动替换当前设置。`
												: "决策模型暂不可用时会给出本地建议。"}
										</p>
									</details>
								</>
							)}

							{confirmModel && hasPromptText && (
								<div className="mt-2 pt-2 border-t border-line flex items-center justify-between gap-2.5 flex-wrap">
									<span className="font-medium text-ink">分析团队分工</span>
									{hasWorkspace && (
										<label className="inline-flex items-center gap-1.5 cursor-pointer">
											<input
												type="checkbox"
												checked={readRepoForDecision}
												onChange={(e) => setReadRepoForDecision(e.target.checked)}
												className="size-3.5 accent-accent"
											/>
											<span>只读参考仓库入口文件</span>
										</label>
									)}
									<div className="inline-flex items-center gap-2 shrink-0 flex-wrap">
										<Button
											variant="primary"
											size="xs"
											onClick={() => {
												setConfirmModel(false);
												onRequestModelAssessment?.({ readRepo: readRepoForDecision });
											}}
										>
											确认分析
										</Button>
										<Button variant="inline" size="xs" onClick={() => setConfirmModel(false)}>
											取消
										</Button>
									</div>
								</div>
							)}
							{modelAssessmentError && (
								<p className="mt-2 mb-0 text-warn-text leading-normal">{modelAssessmentError}</p>
							)}
						</>
					)}
				</section>
			)}
			{expanded && (
				<div id={rosterId} className="p-3.5 border border-line rounded-md bg-stage flex flex-col gap-3.5">
					<label htmlFor={leadSelectId} className="flex items-center gap-3 text-sm">
						<span className="shrink-0 font-medium text-ink">{isBoardMode ? "交付总控" : "主责"}</span>
						<Select
							id={leadSelectId}
							size="sm"
							className="flex-1 min-w-0"
							aria-label={isBoardMode ? "新事项交付总控 AI" : "新事项主责 AI"}
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
						</Select>
					</label>
					{isBoardMode ? (
						<p className="m-0 text-xs text-ink-secondary leading-normal">
							总控将按任务切片动态组建 Builder 与只读
							Verifier（支持在看板中随时暂停、退场或待命热切换模型），无需预先勾选静态委托名单。
						</p>
					) : (
						business.length > 1 && (
							<fieldset
								className="grid grid-cols-1 sm:grid-cols-2 gap-x-4.5 gap-y-2.5 border-0 m-0 p-0 min-w-0"
								aria-label="可委托成员设置"
							>
								{business
									.filter((member) => member.id !== leadId)
									.map((member) => {
										const isConsult = consultIds.includes(member.id);
										return (
											<div
												key={member.id}
												className="flex justify-between items-center gap-2 text-xs min-w-0 flex-wrap"
											>
												<span className="break-words font-medium text-ink">{member.displayName}</span>
												<div className="inline-flex items-center gap-1.5 shrink-0">
													<button
														type="button"
														role="switch"
														aria-checked={isConsult}
														aria-label={`允许主责委托 ${member.displayName}`}
														title={
															isConsult
																? `已允许主责委托 ${member.displayName}`
																: `点击允许主责委托 ${member.displayName}`
														}
														className={cn(
															"relative w-9 h-5 rounded-pill border-0 p-0.5 cursor-pointer transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-accent",
															isConsult ? "bg-accent" : "bg-line-strong",
														)}
														onClick={() => setRoleFlag(member.id, "consult", !isConsult)}
													>
														<span
															className={cn(
																"block size-4 rounded-full bg-white shadow-sm transition-transform",
																isConsult && "translate-x-4",
															)}
														/>
													</button>
												</div>
											</div>
										);
									})}
							</fieldset>
						)
					)}
					<div className="flex flex-col gap-2.5 items-start">
						{otherOrgMembers.length > 0 && onUpdateDraftVisibility && (
							<div className="flex items-center flex-wrap gap-1.5">
								<span className="text-xs text-ink-muted">事项范围</span>
								<button
									type="button"
									className={cn(CHIP_BASE, draftVisibility === "org" ? CHIP_ACTIVE : CHIP_IDLE)}
									aria-pressed={draftVisibility === "org"}
									onClick={() => onUpdateDraftVisibility("org")}
								>
									组织内可见
								</button>
								<button
									type="button"
									className={cn(CHIP_BASE, draftVisibility === "private" ? CHIP_ACTIVE : CHIP_IDLE)}
									aria-pressed={draftVisibility === "private"}
									onClick={() => onUpdateDraftVisibility("private")}
								>
									仅指定成员私密
								</button>
							</div>
						)}
						{otherOrgMembers.length > 0 && (
							<div className="flex items-center flex-wrap gap-1.5">
								<span className="text-xs text-ink-muted">人类成员</span>
								{initiatorName && (
									<span className="px-2 py-1 text-xs text-ink-secondary">{initiatorName} · 发起人</span>
								)}
								{otherOrgMembers.map((member) => (
									<button
										key={member.userId}
										type="button"
										className={cn(
											CHIP_BASE,
											draftCollaboratorIds.includes(member.userId) ? CHIP_ACTIVE : CHIP_IDLE,
										)}
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
							</div>
						)}
						{onStartArchitectMatter && (
							<Button variant="inline" size="xs" onClick={() => onStartArchitectMatter()}>
								需要补充专职角色？
							</Button>
						)}
					</div>
				</div>
			)}
		</section>
	);
}
