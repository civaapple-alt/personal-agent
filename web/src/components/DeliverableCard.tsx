import { useEffect, useState } from "react";
import type { DeliverableDto, FeedbackRating, MemoryScope } from "../api.ts";
import { MarkdownView } from "../MarkdownView.tsx";
import { FEEDBACK_RATING_LABELS, formatClockTime } from "../utils.ts";

interface DeliverableCardProps {
	deliverable: DeliverableDto;
	siblingVersions: DeliverableDto[];
	memberName: string;
	workspaceName: string | null;
	hasWorkspace: boolean;
	viewUrl: string | null;
	onSubmitFeedback: (
		deliverableId: string,
		payload: { feedback?: string; rating?: FeedbackRating; autoDistill?: boolean },
	) => Promise<void>;
	onDistillExperiences: (deliverable: DeliverableDto, feedback?: string, rating?: FeedbackRating) => Promise<void>;
	onSelectVersion: (deliverableId: string) => void;
	onRequestRevision: () => void;
	onOpenMatterChat?: () => void;
	onSaveMemory: (input: {
		content: string;
		scope: MemoryScope;
		rationale?: string;
		status: "candidate" | "verified";
	}) => Promise<void>;
	compact?: boolean;
}

export function DeliverableCard(props: DeliverableCardProps) {
	const [memoryOpen, setMemoryOpen] = useState(false);
	const [memoryText, setMemoryText] = useState("");
	const [memoryRationale, setMemoryRationale] = useState("");
	const [memoryScope, setMemoryScope] = useState<MemoryScope>("role_general");
	const [memoryStatus, setMemoryStatus] = useState<"candidate" | "verified">("verified");
	const [feedbackText, setFeedbackText] = useState("");
	const [selectedRating, setSelectedRating] = useState<FeedbackRating | undefined>(
		props.deliverable.feedbackRating ?? undefined,
	);
	const [autoDistill, setAutoDistill] = useState(false);
	const [submittingFeedback, setSubmittingFeedback] = useState(false);
	const [distilling, setDistilling] = useState(false);

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
				<button
					type="button"
					className="btn-pill-outline"
					onClick={() => {
						setMemoryOpen((prev) => !prev);
						if (!memoryText) {
							setMemoryText(`关于「${props.deliverable.title}」的做法总结：${props.deliverable.summary}`);
						}
					}}
				>
					{memoryOpen ? "收起经验沉淀" : "沉淀为角色经验"}
				</button>
				<button type="button" className="btn-pill-outline" disabled={distilling} onClick={handleDistillClick}>
					{distilling ? "提炼中..." : "AI 提炼候选经验"}
				</button>
			</div>

			{memoryOpen && (
				<div className="memory-draft-box">
					<div className="memory-draft-head">
						<strong>沉淀为「{props.memberName}」的工作习惯</strong>
						<div className="memory-draft-controls">
							<select
								className="select-sm"
								value={memoryScope}
								onChange={(e) => setMemoryScope(e.target.value as MemoryScope)}
							>
								<option value="role_general">角色通用经验（跨项目可用）</option>
								<option value="company_private" disabled={!props.hasWorkspace}>
									个人私有经验{props.hasWorkspace ? "（仅当前工作区）" : "（需先关联仓库）"}
								</option>
								<option value="project_private" disabled={!props.hasWorkspace}>
									当前项目规范{props.hasWorkspace ? "（仅当前仓库生效）" : "（需先关联仓库）"}
								</option>
							</select>
							<select
								className="select-sm"
								value={memoryStatus}
								onChange={(e) => setMemoryStatus(e.target.value as "candidate" | "verified")}
							>
								<option value="verified">直接设为已验证</option>
								<option value="candidate">先存为待核验候选</option>
							</select>
						</div>
					</div>
					<input
						className="input-field input-field-spaced"
						value={memoryRationale}
						onChange={(e) => setMemoryRationale(e.target.value)}
						placeholder="沉淀依据/适用场景（可选，例如：用户验收时明确要求提供可运行验证命令）"
					/>
					<div className="feedback-row">
						<input
							className="input-field"
							value={memoryText}
							onChange={(e) => setMemoryText(e.target.value)}
							placeholder="例如：交付工程文档时优先列出可直接执行的启动命令..."
						/>
						<button
							type="button"
							className="btn-primary btn-sm"
							onClick={() => {
								if (!memoryText.trim()) return;
								void props
									.onSaveMemory({
										content: memoryText.trim(),
										scope: memoryScope,
										rationale: memoryRationale.trim() || undefined,
										status: memoryStatus,
									})
									.then(() => {
										setMemoryText("");
										setMemoryRationale("");
										setMemoryOpen(false);
									});
							}}
						>
							保存经验
						</button>
					</div>
				</div>
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
