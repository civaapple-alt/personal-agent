import { useEffect, useMemo, useState } from "react";
import type {
	DeliverableDto,
	DistillRsiResult,
	FeedbackRating,
	MemberMemoryDto,
	OrganizationDto,
	TeamMemberDto,
	WorkspaceDto,
} from "../api.ts";
import { MarkdownView } from "../MarkdownView.tsx";
import {
	collectMatterMemories,
	DELIVERABLE_TYPE_LABELS,
	FEEDBACK_RATING_LABELS,
	formatClockTime,
	parseDeliverableSummary,
} from "../utils.ts";
import { InlineExperienceReviewSection } from "./ExperienceReviewPanel.tsx";

interface DeliverableCardProps {
	deliverable: DeliverableDto;
	siblingVersions: DeliverableDto[];
	memberName: string;
	workspaceId: string | null;
	workspaceName: string | null;
	members: TeamMemberDto[];
	workspaces: WorkspaceDto[];
	organizations?: OrganizationDto[];
	memoriesByMember: Record<string, MemberMemoryDto[]>;
	participantIds: string[];
	resolveMemberName: (id: string) => string;
	resolveWorkspaceName: (id: string | null) => string | null;
	resolveOrganizationName?: (id: string | null) => string | null;
	viewUrl: string | null;
	onSubmitFeedback: (
		deliverableId: string,
		payload: { feedback?: string; rating?: FeedbackRating; autoDistill?: boolean },
	) => Promise<void>;
	onDistillExperiences: (
		deliverable: DeliverableDto,
		feedback?: string,
		rating?: FeedbackRating,
	) => Promise<DistillRsiResult | undefined>;
	onCancelDistill?: () => void;
	onSelectVersion: (deliverableId: string) => void;
	onRequestRevision: () => void;
	onOpenMatterChat?: () => void;
	onOpenTeam?: () => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
	isOwner?: boolean;
	compact?: boolean;
}

export function DeliverableCard(props: DeliverableCardProps) {
	const [memoryOpen, setMemoryOpen] = useState(false);
	const [processOpen, setProcessOpen] = useState(false);
	const [feedbackOpen, setFeedbackOpen] = useState(false);
	const [feedbackText, setFeedbackText] = useState("");
	const [selectedRating, setSelectedRating] = useState<FeedbackRating | undefined>(
		props.deliverable.feedbackRating ?? undefined,
	);
	const [autoDistill, setAutoDistill] = useState(false);
	const [submittingFeedback, setSubmittingFeedback] = useState(false);
	const [distilling, setDistilling] = useState(false);
	const [lastDistillNote, setLastDistillNote] = useState<string | null>(null);

	const associatedMemories = useMemo(
		() => collectMatterMemories(props.memoriesByMember, props.deliverable.matterId, props.deliverable.id),
		[props.memoriesByMember, props.deliverable.matterId, props.deliverable.id],
	);
	const parsedSummary = useMemo(() => parseDeliverableSummary(props.deliverable.summary), [props.deliverable.summary]);
	const participantNames = useMemo(
		() => props.participantIds.map((id) => props.resolveMemberName(id)).filter(Boolean),
		[props.participantIds, props.resolveMemberName],
	);
	const versionsDesc = useMemo(
		() => [...props.siblingVersions].sort((a, b) => b.version - a.version),
		[props.siblingVersions],
	);
	const hasProcessDetails = parsedSummary.details.length > 0 || props.siblingVersions.length > 1;

	useEffect(() => {
		setSelectedRating(props.deliverable.feedbackRating ?? undefined);
	}, [props.deliverable.feedbackRating]);

	const handleFeedbackSubmit = () => {
		const trimmed = feedbackText.trim();
		if (!trimmed && !selectedRating) return;
		setSubmittingFeedback(true);
		void props
			.onSubmitFeedback(props.deliverable.id, {
				feedback: trimmed || undefined,
				rating: selectedRating,
				autoDistill,
			})
			.then(() => {
				setFeedbackText("");
				setFeedbackOpen(false);
			})
			.finally(() => {
				setSubmittingFeedback(false);
			});
	};

	const handleDistillClick = () => {
		setDistilling(true);
		void props
			.onDistillExperiences(props.deliverable, feedbackText.trim() || undefined, selectedRating)
			.then((res) => {
				if (!res) return;
				if (res.aborted) {
					setLastDistillNote("已取消本次 AI 经验复盘。");
					return;
				}
				if (res.createdMemories.length > 0) {
					const roleNames = Array.from(
						new Set(res.createdMemories.map((m) => props.resolveMemberName(m.memberId))),
					);
					setLastDistillNote(
						`AI 复盘完成：已为 ${roleNames.join("、")} 提炼 ${res.createdMemories.length} 条经验，可在下方直接核验通过或修改归属岗位。`,
					);
				} else {
					setLastDistillNote(
						res.skippedDuplicates > 0
							? `AI 复盘完成：未新增重复条目（跳过 ${res.skippedDuplicates} 条相似经验）。`
							: `AI 复盘完成：${res.summary}`,
					);
				}
			})
			.finally(() => {
				setDistilling(false);
			});
	};

	const typeLabel = DELIVERABLE_TYPE_LABELS[props.deliverable.type] ?? props.deliverable.type;
	const ratingLabel = props.deliverable.feedbackRating
		? (FEEDBACK_RATING_LABELS[props.deliverable.feedbackRating] ?? props.deliverable.feedbackRating)
		: null;

	return (
		<div className={`deliverable-card ${props.compact ? "compact" : ""}`}>
			<div className="deliverable-head-row">
				<div className="deliverable-head-main">
					<div className="deliverable-eyebrow-row">
						{ratingLabel ? (
							<span className={`rsi-badge rsi-rating-${props.deliverable.feedbackRating}`}>{ratingLabel}</span>
						) : (
							<span className="deliverable-status-pill">✓ 已交付</span>
						)}
						{props.workspaceName && <span className="pill">仓库：{props.workspaceName}</span>}
						<span>{props.memberName}</span>
						<span>·</span>
						<span>{typeLabel}</span>
						<span>·</span>
						<span>{formatClockTime(props.deliverable.createdAt)}</span>
					</div>
					<h3 className="deliverable-title">{props.deliverable.title}</h3>
				</div>
				{props.siblingVersions.length > 1 && (
					<div className="version-bar" style={{ marginTop: 0 }}>
						{props.siblingVersions.map((ver) => (
							<button
								key={ver.id}
								type="button"
								className={`version-chip ${ver.id === props.deliverable.id ? "active" : ""}`}
								onClick={() => props.onSelectVersion(ver.id)}
							>
								V{ver.version}
							</button>
						))}
					</div>
				)}
			</div>

			{parsedSummary.lead && (
				<div className="deliverable-takeaway">
					<span className="deliverable-section-kicker">本版重点</span>
					<span className="deliverable-takeaway-text">{parsedSummary.lead}</span>
				</div>
			)}

			{(hasProcessDetails || participantNames.length > 0 || props.onOpenMatterChat) && (
				<div className="deliverable-process-wrap">
					<div className="deliverable-process-bar">
						<div className="deliverable-process-meta">
							<span className="deliverable-section-kicker muted">过程</span>
							{participantNames.length > 0 && <span>协作：{participantNames.join(" · ")}</span>}
							{props.siblingVersions.length > 1 && <span>· 共 {props.siblingVersions.length} 版演进</span>}
							{parsedSummary.details.length > 0 && <span>· 依据 {parsedSummary.details.length} 项</span>}
						</div>
						<div className="deliverable-process-actions">
							{hasProcessDetails && (
								<button
									type="button"
									className="btn-inline btn-xs"
									aria-expanded={processOpen}
									onClick={() => setProcessOpen((prev) => !prev)}
								>
									{processOpen ? "收起过程" : "查看依据与版本"}
								</button>
							)}
							{props.onOpenMatterChat && (
								<button type="button" className="btn-inline btn-xs" onClick={props.onOpenMatterChat}>
									原对话过程 →
								</button>
							)}
						</div>
					</div>
					{processOpen && hasProcessDetails && (
						<div className="deliverable-process-drawer">
							{parsedSummary.details.length > 0 && (
								<div className="deliverable-process-group">
									<div className="deliverable-process-group-title">本版依据与核查结论</div>
									<ul className="deliverable-process-list">
										{parsedSummary.details.map((item, idx) => (
											<li key={`${idx}-${item.slice(0, 12)}`}>{item}</li>
										))}
									</ul>
								</div>
							)}
							{versionsDesc.length > 1 && (
								<div className="deliverable-process-group">
									<div className="deliverable-process-group-title">版本演进</div>
									<div className="deliverable-version-timeline">
										{versionsDesc.map((ver) => {
											const isCurrent = ver.id === props.deliverable.id;
											const verLead = parseDeliverableSummary(ver.summary).lead;
											return (
												<button
													type="button"
													key={ver.id}
													className={`deliverable-version-step ${isCurrent ? "active" : ""}`}
													onClick={() => props.onSelectVersion(ver.id)}
												>
													<div className="deliverable-version-step-head">
														<strong>V{ver.version}</strong>
														<span>
															{props.resolveMemberName(ver.memberId)} · {formatClockTime(ver.createdAt)}
														</span>
													</div>
													{verLead && <div className="deliverable-version-step-note">{verLead}</div>}
												</button>
											);
										})}
									</div>
								</div>
							)}
						</div>
					)}
				</div>
			)}

			<div className="deliverable-body">
				<MarkdownView content={props.deliverable.contentOrPath} />
			</div>

			<div className="actions-row">
				{props.viewUrl && (
					<a className="btn-pill-dark" href={props.viewUrl} target="_blank" rel="noreferrer">
						打开查看 →
					</a>
				)}
				<button type="button" className="btn-pill-outline" onClick={props.onRequestRevision}>
					继续修改
				</button>
				<button
					type="button"
					className={`btn-pill-outline ${feedbackOpen ? "active" : ""}`}
					aria-expanded={feedbackOpen}
					onClick={() => setFeedbackOpen((prev) => !prev)}
				>
					{feedbackOpen ? "收起验收" : ratingLabel ? "修改验收" : "记录验收"}
				</button>
				{props.isOwner !== false && (
					<>
						<button type="button" className="btn-pill-outline" onClick={() => setMemoryOpen((prev) => !prev)}>
							{memoryOpen ? "收起手动沉淀" : "手动沉淀经验"}
						</button>
						<button type="button" className="btn-pill-outline" disabled={distilling} onClick={handleDistillClick}>
							{distilling ? "复盘提炼中..." : "AI 提炼团队经验"}
						</button>
					</>
				)}
				{distilling && props.onCancelDistill && (
					<button type="button" className="btn-stop-pill" onClick={props.onCancelDistill}>
						取消提炼
					</button>
				)}
			</div>

			{!feedbackOpen && props.deliverable.feedback && (
				<div className="feedback-inline-summary">
					{ratingLabel && (
						<span className={`rsi-badge rsi-rating-${props.deliverable.feedbackRating}`}>{ratingLabel}</span>
					)}
					<span className="feedback-summary-text">验收记录：{props.deliverable.feedback}</span>
				</div>
			)}

			{(associatedMemories.length > 0 || memoryOpen || lastDistillNote) && (
				<InlineExperienceReviewSection
					matterId={props.deliverable.matterId}
					deliverableId={props.deliverable.id}
					defaultMemberId={props.deliverable.memberId}
					workspaceId={props.workspaceId}
					participantIds={props.participantIds}
					memories={associatedMemories}
					members={props.members}
					workspaces={props.workspaces}
					organizations={props.organizations}
					memberName={props.resolveMemberName}
					workspaceName={props.resolveWorkspaceName}
					organizationName={props.resolveOrganizationName}
					lastDistillNote={lastDistillNote}
					onOpenTeam={props.onOpenTeam}
					manualOpen={memoryOpen}
					onToggleManual={() => setMemoryOpen((prev) => !prev)}
					showManualToggle={false}
					defaultManualContent={`关于「${props.deliverable.title}」的可复用经验：${parsedSummary.lead || props.deliverable.summary}`}
					hideEmptyPlaceholder={true}
					onRefresh={props.onRefresh}
					onNotice={props.onNotice}
					onError={props.onError}
				/>
			)}

			{feedbackOpen && (
				<div className="feedback-panel">
					<div className="feedback-rating-row">
						<span className="feedback-rating-label">验收结论：</span>
						{(["positive", "neutral", "negative"] as const).map((rating) => (
							<button
								key={rating}
								type="button"
								className={`choice-chip ${selectedRating === rating ? "active" : ""}`}
								onClick={() => setSelectedRating((prev) => (prev === rating ? undefined : rating))}
							>
								{FEEDBACK_RATING_LABELS[rating]}
							</button>
						))}
						{props.isOwner !== false && (
							<label className="feedback-distill-toggle">
								<input
									type="checkbox"
									checked={autoDistill}
									onChange={(e) => setAutoDistill(e.target.checked)}
								/>
								<span>保存后自动 AI 提炼经验</span>
							</label>
						)}
					</div>
					<div className="feedback-row">
						<input
							className="input-field"
							value={feedbackText}
							onChange={(e) => setFeedbackText(e.target.value)}
							placeholder={
								props.deliverable.feedback
									? `补充或更新反馈：${props.deliverable.feedback}`
									: "记录这条交付的验收反馈..."
							}
						/>
						<button
							type="button"
							className="btn-secondary btn-sm"
							disabled={submittingFeedback || (!feedbackText.trim() && !selectedRating)}
							onClick={handleFeedbackSubmit}
						>
							{submittingFeedback ? "保存中..." : "保存验收"}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
