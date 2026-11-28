import { useId, useState } from "react";
import { Button, Textarea } from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";

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
			className="grid gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				submitCurrent();
			}}
		>
			{options.length > 0 && (
				<fieldset className="flex flex-wrap gap-1.5 m-0 p-0 border-0" aria-label="选择答复">
					{options.map((option, index) => {
						const active = selected === index && !trimmed;
						return (
							<button
								key={option}
								type="button"
								className={cn(
									"appearance-none border rounded-pill px-3 py-1 text-xs leading-snug cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
									active
										? "border-cta bg-cta text-stage font-medium hover:opacity-90"
										: "border-line bg-stage text-ink hover:border-accent-border hover:bg-surface-accent",
								)}
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
			<div className="flex items-end gap-2">
				<Textarea
					id={inputId}
					className="flex-1 min-w-0 min-h-[34px] py-1.5 text-sm"
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
				<Button type="submit" variant="primary" size="xs" disabled={!selectedAnswer || submitting}>
					{submitting ? "提交中…" : "提交答案"}
				</Button>
			</div>
		</form>
	);
}
