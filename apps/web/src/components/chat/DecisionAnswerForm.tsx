import { useId, useState } from "react";

export function DecisionAnswerForm({
	options,
	submitting = false,
	onAnswer,
}: {
	options: string[];
	submitting?: boolean;
	onAnswer: (answer: string) => void;
}) {
	const inputId = useId();
	const [selected, setSelected] = useState<number | null>(null);
	const [answer, setAnswer] = useState("");
	const trimmed = answer.trim();
	const selectedAnswer = trimmed || (selected === null ? "" : (options[selected] ?? ""));

	function submitCurrent() {
		if (selectedAnswer && !submitting) onAnswer(selectedAnswer);
	}

	return (
		<form
			className="decision-answer-form"
			onSubmit={(event) => {
				event.preventDefault();
				submitCurrent();
			}}
		>
			{options.length > 0 && (
				<fieldset className="decision-option-list" aria-label="选择答复">
					{options.map((option, index) => {
						const active = selected === index && !trimmed;
						return (
							<button
								key={option}
								type="button"
								className={`decision-option-btn${active ? " is-selected" : ""}`}
								aria-pressed={active}
								disabled={submitting}
								onClick={() => {
									if (active) {
										setSelected(null);
									} else {
										setSelected(index);
										setAnswer("");
									}
								}}
							>
								{option}
							</button>
						);
					})}
				</fieldset>
			)}
			<div className="decision-input-row">
				<textarea
					id={inputId}
					className="input-field decision-textarea"
					rows={options.length > 0 ? 1 : 2}
					value={answer}
					maxLength={4000}
					aria-label="你的答复"
					placeholder={options.length > 0 ? "或直接输入其他答复…" : "输入你的答复…"}
					disabled={submitting}
					onChange={(event) => {
						setAnswer(event.target.value);
						if (event.target.value.trim()) setSelected(null);
					}}
					onKeyDown={(event) => {
						if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
							event.preventDefault();
							submitCurrent();
						}
					}}
				/>
				<button type="submit" className="btn-pill-dark btn-xs" disabled={!selectedAnswer || submitting}>
					{submitting ? "提交中…" : "提交答案"}
				</button>
			</div>
		</form>
	);
}
