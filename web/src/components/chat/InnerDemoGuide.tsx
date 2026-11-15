import type { InnerMatterStep, MatterDetailPayload } from "../../api.ts";
import { innerDemoProgress } from "../../innerDemo.ts";

export function InnerDemoGuide({
	detail,
	disabled,
	onChooseStep,
}: {
	detail: MatterDetailPayload;
	disabled: boolean;
	onChooseStep?: (step: InnerMatterStep) => void;
}) {
	const guide = detail.demoGuide;
	if (!guide) return null;
	const completed = innerDemoProgress(guide, detail);
	const currentIndex = completed.findIndex((done) => !done);
	return (
		<section className="inner-demo-guide" aria-label="内置演示引导">
			<div className="inner-demo-heading">
				<span className="pill">内置演示</span>
				<h2>{guide.title}</h2>
			</div>
			<p>用虚构资料体验一次完整协作。先填入提问，按需修改后发送；成果由团队实际执行产生。</p>
			<p className="inner-demo-flow">需求讨论 → 专业协作 → 阶段交付 → 反馈修订</p>
			<ol className="inner-demo-steps">
				{guide.steps.map((step, index) => (
					<li key={step.id} data-current={index === currentIndex}>
						<div>
							<strong>
								{index + 1}. {step.label}
							</strong>
							{completed[index] && <span className="pill">已有记录</span>}
						</div>
						<p>{step.description}</p>
						{onChooseStep && (
							<button
								type="button"
								className="btn-pill-outline btn-xs"
								disabled={disabled || completed[index] || completed.slice(0, index).some((done) => !done)}
								onClick={() => onChooseStep(step)}
							>
								{completed[index] ? "已有记录" : step.id === "revise" ? "记录反馈并填入修订要求" : "填入提问"}
							</button>
						)}
					</li>
				))}
			</ol>
			{completed.every(Boolean) && (
				<output>已形成 V1、反馈与 V2，可以到成果库比较版本，也可以继续在下方讨论。</output>
			)}
		</section>
	);
}
