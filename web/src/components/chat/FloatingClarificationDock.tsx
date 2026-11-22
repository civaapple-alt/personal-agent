import { useState } from "react";
import { type HumanDecision, readHumanDecision } from "../../../../src/orchestrator/human-decision.ts";
import { actOnHumanDecision, type MatterDto } from "../../api/matters.ts";

interface FloatingClarificationDockProps {
	matter: MatterDto;
	messageId: string;
	decision: HumanDecision;
	requestedBy: string;
	isRunning: boolean;
	onAnswered?: () => void;
}

/** Floating multi-step clarification card docked directly above the chat composer (supports 1/N pagination, numbered options, custom input, and skip/submit). */
export function FloatingClarificationDock({
	matter,
	messageId,
	decision,
	requestedBy,
	isRunning,
	onAnswered,
}: FloatingClarificationDockProps) {
	const [collapsed, setCollapsed] = useState(false);
	const [stepIndex, setStepIndex] = useState(0);
	const [answers, setAnswers] = useState<Record<number, string>>({});
	const [otherModes, setOtherModes] = useState<Record<number, boolean>>({});
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedDecision, setSavedDecision] = useState<HumanDecision | null>(null);

	const active = savedDecision && savedDecision.revision >= decision.revision ? savedDecision : decision;
	const requests = active.requests;
	const total = requests.length;

	if (active.status !== "pending" || total === 0) return null;

	const currentIndex = Math.min(stepIndex, total - 1);
	const currentReq = requests[currentIndex]!;
	const options = currentReq.options ?? [];
	const currentAnswer = answers[currentIndex] ?? "";
	const isOtherMode = Boolean(otherModes[currentIndex]) || options.length === 0;
	const isLastStep = currentIndex >= total - 1;

	const answeredCount = requests.reduce((count, _req, idx) => (answers[idx]?.trim() ? count + 1 : count), 0);

	const selectOption = (opt: string) => {
		setOtherModes((prev) => ({ ...prev, [currentIndex]: false }));
		setAnswers((prev) => ({ ...prev, [currentIndex]: opt }));
	};

	const setCustomAnswer = (value: string) => {
		setOtherModes((prev) => ({ ...prev, [currentIndex]: true }));
		setAnswers((prev) => ({ ...prev, [currentIndex]: value }));
	};

	const buildFormattedAnswer = (): string => {
		if (total === 1) {
			return (answers[0] ?? "").trim();
		}
		return requests
			.map((req, idx) => {
				const ans = (answers[idx] ?? "").trim();
				return ans ? `${idx + 1}. ${req.question}\n答：${ans}` : null;
			})
			.filter(Boolean)
			.join("\n\n");
	};

	const handleSubmit = async () => {
		const formatted = buildFormattedAnswer();
		if (!formatted) {
			setError("请至少选择或输入一项答复");
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const res = await actOnHumanDecision(matter.id, messageId, {
				action: "answer",
				revision: active.revision,
				answer: formatted,
			});
			const persisted = readHumanDecision(res.message.metadata);
			if (persisted) setSavedDecision(persisted);
			onAnswered?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	};

	const handleNextOrSubmit = () => {
		if (!isLastStep) {
			setStepIndex((i) => Math.min(total - 1, i + 1));
			setError(null);
			return;
		}
		void handleSubmit();
	};

	const handleSkip = () => {
		setAnswers((prev) => {
			const next = { ...prev };
			delete next[currentIndex];
			return next;
		});
		if (!isLastStep) {
			setStepIndex((i) => Math.min(total - 1, i + 1));
			setError(null);
		} else {
			setCollapsed(true);
		}
	};

	if (collapsed) {
		return (
			<div className="clarification-dock-collapsed">
				<button type="button" className="clarification-collapsed-pill" onClick={() => setCollapsed(false)}>
					<span className="clarification-q-icon" aria-hidden="true">
						?
					</span>
					<span>{`${requestedBy} 有 ${total} 个待确认问题（已选 ${answeredCount}/${total}）`}</span>
					<strong>展开作答 ↑</strong>
				</button>
			</div>
		);
	}

	return (
		<section className="clarification-dock" aria-label="待确认问题">
			<div className="clarification-dock-head">
				<div className="clarification-dock-title">
					<span className="clarification-q-icon" aria-hidden="true">
						?
					</span>
					<strong>{currentReq.question}</strong>
				</div>
				<div className="clarification-dock-nav">
					{total > 1 && (
						<>
							<button
								type="button"
								className="btn-icon-ghost"
								aria-label="上一题"
								disabled={currentIndex === 0}
								onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
							>
								←
							</button>
							<span className="clarification-step-counter">
								{currentIndex + 1}/{total}
							</span>
							<button
								type="button"
								className="btn-icon-ghost"
								aria-label="下一题"
								disabled={isLastStep}
								onClick={() => setStepIndex((i) => Math.min(total - 1, i + 1))}
							>
								→
							</button>
						</>
					)}
					<button
						type="button"
						className="btn-icon-ghost"
						aria-label="收起问答条"
						title="收起"
						onClick={() => setCollapsed(true)}
					>
						⌄
					</button>
				</div>
			</div>

			{currentReq.context && <p className="clarification-dock-context">{currentReq.context}</p>}

			<div className="clarification-options-list">
				{options.map((opt, idx) => {
					const selected = !isOtherMode && currentAnswer === opt;
					return (
						<button
							type="button"
							key={`${idx}-${opt}`}
							className={`clarification-option-row ${selected ? "selected" : ""}`}
							disabled={submitting || isRunning}
							onClick={() => selectOption(opt)}
						>
							<span className="clarification-option-num">{idx + 1}</span>
							<span className="clarification-option-text">{opt}</span>
						</button>
					);
				})}
				<div className={`clarification-option-row is-other ${isOtherMode ? "selected" : ""}`}>
					<span className="clarification-option-num">{options.length + 1}</span>
					<input
						className="clarification-other-input"
						type="text"
						value={isOtherMode ? currentAnswer : ""}
						placeholder={options.length > 0 ? "其他（输入你的回答…）" : "输入你的回答…"}
						disabled={submitting || isRunning}
						onFocus={() => setOtherModes((prev) => ({ ...prev, [currentIndex]: true }))}
						onChange={(e) => setCustomAnswer(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey && currentAnswer.trim()) {
								e.preventDefault();
								handleNextOrSubmit();
							}
						}}
					/>
				</div>
			</div>

			{error && (
				<p role="alert" className="clarification-dock-error">
					{error}
				</p>
			)}

			<div className="clarification-dock-footer">
				<span className="clarification-dock-source">来自 {requestedBy}</span>
				<div className="clarification-dock-actions">
					<button type="button" className="btn-inline" disabled={submitting || isRunning} onClick={handleSkip}>
						{isLastStep ? "暂不处理" : "跳过"}
					</button>
					<button
						type="button"
						className="btn-pill-dark btn-xs"
						disabled={submitting || isRunning || (isLastStep && answeredCount === 0)}
						onClick={handleNextOrSubmit}
					>
						{submitting ? "提交中…" : isLastStep ? "提交答复 ↵" : "继续 →"}
					</button>
				</div>
			</div>
		</section>
	);
}
