import { useEffect, useMemo, useState } from "react";
import type {
	DeliverableDto,
	DistillRsiResult,
	FeedbackRating,
	MemberMemoryDto,
	TeamMemberDto,
	WorkspaceDto,
} from "../api.ts";
import { MarkdownView } from "../MarkdownView.tsx";
import { collectMatterMemories, FEEDBACK_RATING_LABELS, formatClockTime } from "../utils.ts";
import { InlineExperienceReviewSection } from "./ExperienceReviewPanel.tsx";

interface DeliverableCardProps {
	deliverable: DeliverableDto;
	siblingVersions: DeliverableDto[];
	memberName: string;
	workspaceId: string | null;
	workspaceName: string | null;
	members: TeamMemberDto[];
	workspaces: WorkspaceDto[];
	memoriesByMember: Record<string, MemberMemoryDto[]>;
	participantIds: string[];
	resolveMemberName: (id: string) => string;
	resolveWorkspaceName: (id: string | null) => string | null;
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
	compact?: boolean;
}

export function DeliverableCard(props: DeliverableCardProps) {
	const [memoryOpen, setMemoryOpen] = useState(false);
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

	return (
		<div className={`deliverable-card ${props.compact ? "compact" : ""}`}>
			<div className="success-banner">
				<span>✓ 已完成交付 · 由【{props.memberName}】产出</span>
				<div className="success-tags">
					{props.workspaceName && <span className="pill">仓库：{props.workspaceName}</span>}
					<span className="pill">{formatClockTime(props.deliverable.createdAt)}</span>
				</div>
			</div>

			<div className="deliverable-head-row">
				<div>
					<h3 className="deliverable-title">{props.deliverable.title}</h3>
					<div className="featured-meta">
						<span>{props.memberName}</span>
						<span>·</span>
						<span>V{props.deliverable.version}</span>
						<span>·</span>
						<span className="pill">{props.deliverable.type}</span>
					</div>
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

			{props.deliverable.summary && <div className="deliverable-summary-note">{props.deliverable.summary}</div>}

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
				{props.onOpenMatterChat && (
					<button type="button" className="btn-pill-outline" onClick={props.onOpenMatterChat}>
						查看原对话
					</button>
				)}
				<button type="button" className="btn-pill-outline" onClick={() => setMemoryOpen((prev) => !prev)}>
					{memoryOpen ? "收起经验沉淀" : "沉淀为角色经验"}
				</button>
				<button type="button" className="btn-pill-outline" disabled={distilling} onClick={handleDistillClick}>
					{distilling ? "复盘提炼中..." : "AI 提炼团队经验"}
				</button>
				{distilling && props.onCancelDistill && (
					<button type="button" className="btn-stop-pill" onClick={props.onCancelDistill}>
						取消提炼
					</button>
				)}
			</div>

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
					memberName={props.resolveMemberName}
					workspaceName={props.resolveWorkspaceName}
					lastDistillNote={lastDistillNote}
					distilling={distilling}
					onDistill={handleDistillClick}
					onCancelDistill={props.onCancelDistill}
					onOpenTeam={props.onOpenTeam}
					manualOpen={memoryOpen}
					onToggleManual={() => setMemoryOpen((prev) => !prev)}
					defaultManualContent={`关于「${props.deliverable.title}」的可复用经验：${props.deliverable.summary}`}
					hideEmptyPlaceholder={true}
					onRefresh={props.onRefresh}
					onNotice={props.onNotice}
					onError={props.onError}
				/>
			)}

			<div className="feedback-panel">
				{(props.deliverable.feedbackRating || props.deliverable.feedback) && (
					<div className="feedback-summary-line">
						{props.deliverable.feedbackRating && (
							<span className={`rsi-badge rsi-rating-${props.deliverable.feedbackRating}`}>
								{FEEDBACK_RATING_LABELS[props.deliverable.feedbackRating] ?? props.deliverable.feedbackRating}
							</span>
						)}
						{props.deliverable.feedback && (
							<span className="feedback-summary-text">验收记录：{props.deliverable.feedback}</span>
						)}
					</div>
				)}
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
					<label className="feedback-distill-toggle">
						<input type="checkbox" checked={autoDistill} onChange={(e) => setAutoDistill(e.target.checked)} />
						<span>保存后自动 AI 提炼经验</span>
					</label>
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
		</div>
	);
}
