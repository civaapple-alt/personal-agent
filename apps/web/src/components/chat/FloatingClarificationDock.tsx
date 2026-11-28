import { type HumanDecision, readHumanDecision } from "@pa/contracts/human-decision";
import { useState } from "react";
import { actOnHumanDecision, type MatterDto } from "../../api/matters.ts";
import { Banner, Button, IconButton } from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";

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
			<div className="w-[min(760px,calc(100%-32px))] mx-auto mb-2.5 shrink-0">
				<button
					type="button"
					className="flex items-center justify-between gap-2.5 w-full px-3.5 py-2 border border-line rounded-lg bg-surface text-xs text-ink cursor-pointer hover:border-line-strong transition-colors"
					onClick={() => setCollapsed(false)}
				>
					<span
						className="size-5.5 rounded-full border border-line inline-flex items-center justify-center text-xs font-bold text-accent shrink-0"
						aria-hidden="true"
					>
						?
					</span>
					<span>{`${requestedBy} 有 ${total} 个待确认问题（已选 ${answeredCount}/${total}）`}</span>
					<strong className="text-accent">展开作答 ↑</strong>
				</button>
			</div>
		);
	}

	return (
		<section
			className="w-[min(760px,calc(100%-32px))] mx-auto mb-2.5 shrink-0 border border-line rounded-xl bg-surface shadow-md px-4 pt-3.5 pb-3 flex flex-col gap-2.5"
			aria-label="待确认问题"
		>
			<div className="flex items-center justify-between gap-2.5">
				<div className="flex items-center gap-2 text-sm leading-snug text-ink min-w-0">
					<span
						className="size-5.5 rounded-full border border-line inline-flex items-center justify-center text-xs font-bold text-accent shrink-0"
						aria-hidden="true"
					>
						?
					</span>
					<strong>{currentReq.question}</strong>
				</div>
				<div className="inline-flex items-center gap-1 shrink-0">
					{total > 1 && (
						<>
							<IconButton
								variant="ghost"
								size="sm"
								aria-label="上一题"
								disabled={currentIndex === 0}
								onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
							>
								←
							</IconButton>
							<span className="text-xs text-ink-muted min-w-7 text-center tabular-nums">
								{currentIndex + 1}/{total}
							</span>
							<IconButton
								variant="ghost"
								size="sm"
								aria-label="下一题"
								disabled={isLastStep}
								onClick={() => setStepIndex((i) => Math.min(total - 1, i + 1))}
							>
								→
							</IconButton>
						</>
					)}
					<IconButton
						variant="ghost"
						size="sm"
						aria-label="收起问答条"
						title="收起"
						onClick={() => setCollapsed(true)}
					>
						⌄
					</IconButton>
				</div>
			</div>

			{currentReq.context && <p className="m-0 text-xs text-ink-secondary pl-7.5">{currentReq.context}</p>}

			<div className="flex flex-col gap-1.5">
				{options.map((opt, idx) => {
					const selected = !isOtherMode && currentAnswer === opt;
					return (
						<button
							type="button"
							key={`${idx}-${opt}`}
							className={cn(
								"flex items-center gap-2.5 w-full px-2.5 py-2 border rounded-md text-left text-sm cursor-pointer transition-colors disabled:opacity-50",
								selected
									? "bg-accent-soft border-accent-border text-ink"
									: "border-transparent bg-transparent text-ink hover:bg-hover/60",
							)}
							disabled={submitting || isRunning}
							onClick={() => selectOption(opt)}
						>
							<span
								className={cn(
									"size-5.5 rounded-sm border inline-flex items-center justify-center text-xs font-semibold shrink-0",
									selected ? "bg-accent border-accent text-white" : "bg-stage border-line text-ink-secondary",
								)}
							>
								{idx + 1}
							</span>
							<span className="leading-snug">{opt}</span>
						</button>
					);
				})}
				<div
					className={cn(
						"flex items-center gap-2.5 w-full px-2.5 py-2 border rounded-md transition-colors focus-within:border-accent-border focus-within:bg-accent-soft/60",
						isOtherMode ? "bg-accent-soft border-accent-border" : "border-transparent bg-transparent",
					)}
				>
					<span
						className={cn(
							"size-5.5 rounded-sm border inline-flex items-center justify-center text-xs font-semibold shrink-0",
							isOtherMode ? "bg-accent border-accent text-white" : "bg-stage border-line text-ink-secondary",
						)}
					>
						{options.length + 1}
					</span>
					<input
						className="flex-1 min-w-0 border-0 bg-transparent text-ink text-sm placeholder:text-ink-muted focus:outline-none focus-visible:outline-none"
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

			{error && <Banner tone="danger">{error}</Banner>}

			<div className="flex items-center justify-between gap-3 pt-1">
				<span className="text-xs text-ink-muted">来自 {requestedBy}</span>
				<div className="inline-flex items-center gap-2.5">
					<Button variant="inline" size="xs" disabled={submitting || isRunning} onClick={handleSkip}>
						{isLastStep ? "暂不处理" : "跳过"}
					</Button>
					<Button
						variant="primary"
						size="xs"
						disabled={submitting || isRunning || (isLastStep && answeredCount === 0)}
						onClick={handleNextOrSubmit}
					>
						{submitting ? "提交中…" : isLastStep ? "提交答复 ↵" : "继续 →"}
					</Button>
				</div>
			</div>
		</section>
	);
}
