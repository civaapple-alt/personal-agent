import type { MetaArchitectHealthFindingDto, RoleArchitectDraftDto } from "../../api.ts";
import { formatHashRoute } from "../../hashRouter.ts";
import { SettingsDisclosure } from "../../primitives/index.ts";

/** Renders structured capability, missing skill, and verification contract notes for a role blueprint. */
export function RoleCapabilityDetails({ draft }: { draft: RoleArchitectDraftDto }) {
	const missing =
		draft.capabilityReport?.skills.filter((skill) => skill.state === "missing").map((skill) => skill.name) ?? [];
	const bundledNewSkills = draft.newSkills ?? [];
	const skillsSummary =
		draft.template.skills.length > 0
			? draft.template.skills.join("、")
			: bundledNewSkills.length > 0
				? `将配套新建 ${bundledNewSkills.length} 个 Skill（${bundledNewSkills.map((skill) => skill.name).join("、")}）`
				: "未选择 Skill";
	return (
		<div className="flex flex-col gap-1.5 rounded-sm border border-line bg-sidebar px-3 py-2.5 text-xs text-ink-secondary leading-relaxed">
			<p className="m-0">工作方法：{skillsSummary}</p>
			{missing.length > 0 && (
				<p className="m-0 text-warn-text">缺少技能文件：{missing.join("、")}，执行前需配置。</p>
			)}
			{(draft.template.mcpDependencies?.length ?? 0) > 0 && (
				<p className="m-0">外部集成：{draft.template.mcpDependencies?.join("、")}，待运行核查。</p>
			)}
			<p className="m-0">验证约定：{draft.template.sections.deliveryAndVerification}</p>
			{draft.verificationPlanState === "missing" && (
				<p className="m-0 text-warn-text">尚未提供具体验证任务，履职前需补全。</p>
			)}
			<small className="text-micro text-ink-muted">技能文件存在与依赖声明不代表履职已验证。</small>
		</div>
	);
}

/** Renders expandable host-verified evidence links for a team health finding. */
export function RoleFindingEvidence({ finding }: { finding: MetaArchitectHealthFindingDto }) {
	if (!finding.evidence?.length) {
		return <small className="text-micro text-ink-muted">未关联具体依据，需核对。</small>;
	}
	return (
		<SettingsDisclosure summary={`查看依据（${finding.evidence.length}）`}>
			<ul className="m-0 pl-4 flex flex-col gap-1.5 list-disc text-xs text-ink-secondary">
				{finding.evidence.map((source) => (
					<li key={source.id}>
						<a
							href={
								source.matterId
									? formatHashRoute({ tab: "chats", matterId: source.matterId })
									: formatHashRoute({ tab: "team" })
							}
							className="font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent"
						>
							{source.label}
						</a>
						<p className="m-0 mt-0.5 text-xs text-ink-secondary leading-normal">{source.excerpt}</p>
					</li>
				))}
			</ul>
		</SettingsDisclosure>
	);
}
