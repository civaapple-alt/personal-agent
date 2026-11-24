import { useState } from "react";
import { DecisionAnswerForm } from "./DecisionAnswerForm.tsx";

const OPTIONS = ["深海蓝", "暖杉绿"];

export function DecisionDemo() {
	const [answer, setAnswer] = useState("");
	return (
		<details className="human-decision-card human-decision-demo">
			<summary>试用「待你决定」</summary>
			<p className="human-decision-note">示例答复只在当前页面生效。</p>
			<p className="human-decision-question">你想选哪一种主色？</p>
			{answer ? (
				<>
					<p className="human-decision-answer">
						<output>已答复 · {answer}</output>
					</p>
					<p className="human-decision-note">正式事项会记录答复人和时间，并按所选方案接续执行。</p>
					<button className="btn-inline" type="button" onClick={() => setAnswer("")}>
						再试一次
					</button>
				</>
			) : (
				<DecisionAnswerForm options={OPTIONS} onAnswer={setAnswer} />
			)}
		</details>
	);
}
