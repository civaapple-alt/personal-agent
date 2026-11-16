import { useState } from "react";
import type {
	CollaborationPresetMode,
	CollaboratorDto,
	MatterInitiationAssessmentDto,
	RoleGapSuggestionDto,
	RoleTemplateDto,
	TeamMemberDto,
} from "../../api.ts";
import { filterBusinessMembers, isArchitectMemberId } from "../../architectApi.ts";

interface MatterInitiationPanelProps {
	isOwner: boolean;
	members: TeamMemberDto[];
	nonOwnerCollaborators: CollaboratorDto[];
	templateByRoleId: Map<string, RoleTemplateDto>;
	selectedMemberId: string;
	draftPresetMode: CollaborationPresetMode;
	draftAiMemberIds: string[] | null;
	draftObserverMemberIds: string[];
	draftCollaboratorIds: string[];
	assessment: MatterInitiationAssessmentDto | null;
	assessing: boolean;
	onSelectLeadMember: (memberId: string) => void;
	onApplyPresetMode: (mode: CollaborationPresetMode) => void;
	onUpdateDraftAiMemberIds: (ids: string[] | null) => void;
	onUpdateDraftObserverIds: (ids: string[]) => void;
	onUpdateDraftCollaboratorIds: (ids: string[]) => void;
	onApplyRecommendation: () => void;
	onOpenArchitect: (gap?: RoleGapSuggestionDto) => void;
	onStartArchitectMatter?: (seedText?: string) => void;
}

const PRESET_OPTIONS: Array<{ id: CollaborationPresetMode; label: string; hint: string }> = [
	{ id: "solo", label: "单人直办", hint: "仅 1 位主责 AI 直接完成，无跨岗委托与旁听" },
	{ id: "lead_consult", label: "按需协同", hint: "主责 AI 牵头，仅向保留的同僚按需内部请教" },
	{ id: "lead_review", label: "旁听把关", hint: "保留主责执行，同时指定关键角色进行风险旁听" },
];

/** Compact pre-launch collaboration framing bar with lightweight expandable participant pills. */
export function MatterInitiationPanel({
	isOwner,
	members,
	nonOwnerCollaborators,
	templateByRoleId,
	selectedMemberId,
	draftPresetMode,
	draftAiMemberIds,
	draftObserverMemberIds,
	draftCollaboratorIds,
	assessment,
	assessing,
	onSelectLeadMember,
	onApplyPresetMode,
	onUpdateDraftAiMemberIds,
	onUpdateDraftObserverIds,
	onUpdateDraftCollaboratorIds,
	onApplyRecommendation,
	onOpenArchitect,
	onStartArchitectMatter,
}: MatterInitiationPanelProps) {
	const [expandedRoster, setExpandedRoster] = useState(false);

	if (!isOwner || isArchitectMemberId(selectedMemberId, members, templateByRoleId)) return null;

	const businessMembers = filterBusinessMembers(members, templateByRoleId);
	const allAiIds = businessMembers.map((m) => m.id);
	const effectiveAiIds = draftAiMemberIds === null ? allAiIds : draftAiMemberIds;
	const primaryMember = businessMembers.find((m) => m.isPrimaryContact) ?? businessMembers[0] ?? null;
	const effectiveLeadId =
		selectedMemberId !== "auto" && businessMembers.some((m) => m.id === selectedMemberId)
			? selectedMemberId
			: (assessment?.recommendedLeadId ?? primaryMember?.id ?? null);
	const effectiveLead = businessMembers.find((m) => m.id === effectiveLeadId) ?? null;
	const otherMembers = businessMembers.filter((m) => m.id !== effectiveLeadId);

	const participatingAiCount =
		draftPresetMode === "solo"
			? effectiveLeadId
				? 1
				: 0
			: effectiveAiIds.filter((id) => businessMembers.some((m) => m.id === id)).length;
	const activeObserverCount =
		draftPresetMode === "lead_review"
			? draftObserverMemberIds.filter((id) => id !== effectiveLeadId && effectiveAiIds.includes(id)).length
			: 0;

	const summaryText = expandedRoster
		? "收起"
		: [
				`${participatingAiCount} AI`,
				activeObserverCount > 0 ? `${activeObserverCount} 旁听` : null,
				draftCollaboratorIds.length > 0 ? `${draftCollaboratorIds.length} 同事` : null,
			]
				.filter(Boolean)
				.join(" · ");

	const cycleMemberStanding = (member: TeamMemberDto) => {
		if (member.id === effectiveLeadId) return;
		const inGroup = effectiveAiIds.includes(member.id);
		const isObserver = draftObserverMemberIds.includes(member.id);

		if (draftPresetMode === "solo") {
			onSelectLeadMember(member.id);
			onUpdateDraftAiMemberIds([member.id]);
			onUpdateDraftObserverIds([]);
			return;
		}
		if (!inGroup) {
			onUpdateDraftAiMemberIds(
				Array.from(new Set([...(effectiveLeadId ? [effectiveLeadId] : []), ...effectiveAiIds, member.id])),
			);
			return;
		}
		if (draftPresetMode === "lead_review" && !isObserver) {
			onUpdateDraftObserverIds(Array.from(new Set([...draftObserverMemberIds, member.id])));
			return;
		}
		const nextAi = effectiveAiIds.filter((id) => id !== member.id);
		onUpdateDraftAiMemberIds(nextAi.length > 0 ? nextAi : effectiveLeadId ? [effectiveLeadId] : [member.id]);
		if (isObserver) {
			onUpdateDraftObserverIds(draftObserverMemberIds.filter((id) => id !== member.id));
		}
	};

	const toggleHumanCollaborator = (collabId: string) => {
		if (draftCollaboratorIds.includes(collabId)) {
			onUpdateDraftCollaboratorIds(draftCollaboratorIds.filter((id) => id !== collabId));
		} else {
			onUpdateDraftCollaboratorIds([...draftCollaboratorIds, collabId]);
		}
	};

	return (
		<section className="initiation-panel" aria-label="立项参与方式">
			<div className="initiation-mode-row">
				<div className="initiation-mode-pills">
					{PRESET_OPTIONS.map((opt) => (
						<button
							key={opt.id}
							type="button"
							title={opt.hint}
							className={`choice-chip ${draftPresetMode === opt.id ? "active" : ""}`}
							onClick={() => onApplyPresetMode(opt.id)}
						>
							{opt.label}
						</button>
					))}
				</div>
				<button type="button" className="btn-inline" onClick={() => setExpandedRoster((v) => !v)}>
					{expandedRoster ? "收起 ▴" : `调整人选（${summaryText}）▾`}
				</button>
			</div>

			{expandedRoster && (
				<div className="initiation-roster-drawer compact">
					<div className="initiation-compact-row">
						<label className="initiation-lead-picker">
							<span>主责：</span>
							<select
								className="wechat-row-select"
								aria-label="新事项主责 AI"
								value={effectiveLeadId ?? ""}
								onChange={(e) => {
									const nextLead = e.target.value;
									if (!nextLead) return;
									onSelectLeadMember(nextLead);
									if (draftPresetMode === "solo") {
										onUpdateDraftAiMemberIds([nextLead]);
									} else if (!effectiveAiIds.includes(nextLead)) {
										onUpdateDraftAiMemberIds([nextLead, ...effectiveAiIds]);
									}
								}}
							>
								{businessMembers.map((m) => (
									<option key={m.id} value={m.id}>
										{m.displayName}
									</option>
								))}
							</select>
						</label>

						<div className="initiation-inline-chips">
							{otherMembers.map((member) => {
								const inGroup = draftPresetMode !== "solo" && effectiveAiIds.includes(member.id);
								const isObserver =
									draftPresetMode === "lead_review" && inGroup && draftObserverMemberIds.includes(member.id);
								const badge = !inGroup ? "不参与" : isObserver ? "旁听" : "协同";
								return (
									<button
										key={member.id}
										type="button"
										className={`choice-chip ${inGroup ? "active" : ""}${isObserver ? " is-observer" : ""}`}
										title="点击切换：协同 / 旁听 / 不参与"
										onClick={() => cycleMemberStanding(member)}
									>
										{member.displayName} · {badge}
									</button>
								);
							})}
						</div>
					</div>

					<div className="initiation-compact-footer">
						{nonOwnerCollaborators.length > 0 ? (
							<div className="initiation-human-row">
								<span className="initiation-mini-label">人类同事：</span>
								{nonOwnerCollaborators.map((col) => {
									const selected = draftCollaboratorIds.includes(col.id);
									return (
										<button
											key={col.id}
											type="button"
											className={`choice-chip ${selected ? "active" : ""}`}
											onClick={() => toggleHumanCollaborator(col.id)}
										>
											{selected ? "✓ " : "+ "}
											{col.name}
										</button>
									);
								})}
							</div>
						) : (
							<span className="initiation-mini-label">提示：点击成员标签可切换协同、旁听或不参与</span>
						)}
						{onStartArchitectMatter ? (
							<button type="button" className="btn-inline" onClick={() => onStartArchitectMatter()}>
								缺少专职角色？请角色架构师规划 →
							</button>
						) : (
							<button type="button" className="btn-inline" onClick={() => onOpenArchitect()}>
								+ 快速建角色
							</button>
						)}
					</div>
				</div>
			)}

			{(assessing || assessment) && (
				<div className={`initiation-assessment-bar ${assessment?.fitStatus === "gap_detected" ? "is-gap" : ""}`}>
					{assessing && !assessment ? (
						<span className="initiation-assess-note">正在评估最合适的参与角色与阵型…</span>
					) : assessment ? (
						<>
							<div className="initiation-assess-copy">
								<strong>{assessment.headline}</strong>
								<span>{assessment.explanation}</span>
							</div>
							<div className="initiation-assess-actions">
								{assessment.fitStatus === "gap_detected" ? (
									<>
										{onStartArchitectMatter && (
											<button
												type="button"
												className="btn-pill-dark btn-xs"
												onClick={() =>
													onStartArchitectMatter(
														assessment.gapSuggestion
															? `我打算发起一项新任务，当前缺少「${assessment.gapSuggestion.missingRoleTitle}」（${assessment.gapSuggestion.suggestedJob}），请帮我设计最小可行角色与参与阵型。`
															: undefined,
													)
												}
											>
												请架构师规划角色
											</button>
										)}
										<button
											type="button"
											className={onStartArchitectMatter ? "btn-pill-outline btn-xs" : "btn-pill-dark btn-xs"}
											onClick={() => onOpenArchitect(assessment.gapSuggestion)}
										>
											快速建角色
										</button>
										<button
											type="button"
											className="btn-pill-outline btn-xs"
											onClick={() => {
												if (effectiveLead) onSelectLeadMember(effectiveLead.id);
												onApplyPresetMode("solo");
											}}
										>
											先由{effectiveLead?.displayName ?? "主联系人"}接手
										</button>
									</>
								) : (
									<button type="button" className="btn-pill-outline btn-xs" onClick={onApplyRecommendation}>
										采纳推荐阵型
									</button>
								)}
							</div>
						</>
					) : null}
				</div>
			)}
		</section>
	);
}
