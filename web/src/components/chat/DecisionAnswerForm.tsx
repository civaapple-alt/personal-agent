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
	const selectedAnswer = selected === null ? answer.trim() : (options[selected] ?? "");
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				if (selectedAnswer && !submitting) onAnswer(selectedAnswer);
			}}
		>
			{options.length > 0 && (
				<fieldset>
					<legend>选择答复</legend>
					{options.map((option, index) => (
						<label key={option} className="checkbox-label">
							<input
								type="radio"
								name={inputId}
								checked={selected === index}
								onChange={() => setSelected(index)}
							/>
							{option}
						</label>
					))}
					<label className="checkbox-label">
						<input type="radio" name={inputId} checked={selected === null} onChange={() => setSelected(null)} />
						自行填写
					</label>
				</fieldset>
			)}
			{selected === null && (
				<label className="human-decision-input">
					<span>你的答复</span>
					<textarea
						className="input-field"
						rows={2}
						value={answer}
						maxLength={4000}
						onChange={(event) => setAnswer(event.target.value)}
					/>
				</label>
			)}
			<button type="submit" className="btn-pill-dark btn-xs" disabled={!selectedAnswer || submitting}>
				提交答案
			</button>
		</form>
	);
}
