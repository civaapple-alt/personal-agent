import { useState } from "react";
import { Button } from "../../primitives/index.ts";
import { DecisionAnswerForm } from "./DecisionAnswerForm.tsx";

const OPTIONS = ["深海蓝", "暖杉绿"];

export function DecisionDemo() {
	const [answer, setAnswer] = useState("");
	return (
		<details className="w-full max-w-[34rem] mt-2 border border-line rounded-lg bg-sidebar px-3.5 py-2.5 text-sm text-ink [&[open]>summary]:mb-2">
			<summary className="cursor-pointer font-medium text-ink select-none">试用「待你决定」</summary>
			<p className="m-0 mb-2 text-xs text-ink-secondary">示例答复只在当前页面生效。</p>
			<p className="m-0 mb-2 font-semibold text-ink">你想选哪一种主色？</p>
			{answer ? (
				<div className="flex flex-col items-start gap-1.5">
					<p className="m-0 whitespace-pre-wrap text-ink">
						<output>已答复 · {answer}</output>
					</p>
					<p className="m-0 text-xs text-ink-secondary">正式事项会记录答复人和时间，并按所选方案接续执行。</p>
					<Button variant="inline" size="xs" onClick={() => setAnswer("")}>
						再试一次
					</Button>
				</div>
			) : (
				<DecisionAnswerForm options={OPTIONS} onAnswer={setAnswer} />
			)}
		</details>
	);
}
