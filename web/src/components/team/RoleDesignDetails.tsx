import type { MetaArchitectHealthFindingDto, RoleArchitectDraftDto } from "../../api.ts";
import { formatHashRoute } from "../../hashRouter.ts";

export function RoleCapabilityDetails({ draft }: { draft: RoleArchitectDraftDto }) {
	const missing =
		draft.capabilityReport?.skills.filter((skill) => skill.state === "missing").map((skill) => skill.name) ?? [];
	return (
		<div className="architect-blueprint-anti">
			<p>工作方法：{draft.template.skills.join("、") || "未选择 Skill"}</p>
			{missing.length > 0 && <p>缺少技能文件：{missing.join("、")}，执行前需配置。</p>}
			{(draft.template.mcpDependencies?.length ?? 0) > 0 && (
				<p>外部集成：{draft.template.mcpDependencies?.join("、")}，待运行核查。</p>
			)}
			<p>验证约定：{draft.template.sections.deliveryAndVerification}</p>
			<small>技能文件存在与依赖声明不代表履职已验证。</small>
		</div>
	);
}

export function RoleFindingEvidence({ finding }: { finding: MetaArchitectHealthFindingDto }) {
	if (!finding.evidence?.length) return <small>未关联具体依据，需核对。</small>;
	return (
		<details>
			<summary>查看依据（{finding.evidence.length}）</summary>
			<ul>
				{finding.evidence.map((source) => (
					<li key={source.id}>
						<a
							href={
								source.matterId
									? formatHashRoute({ tab: "chats", matterId: source.matterId })
									: formatHashRoute({ tab: "team" })
							}
						>
							{source.label}
						</a>
						<p>{source.excerpt}</p>
					</li>
				))}
			</ul>
		</details>
	);
}
