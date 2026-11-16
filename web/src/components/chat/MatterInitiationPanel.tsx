import { useState } from "react";
import type {
	CollaborationPresetMode,
	CollaboratorDto,
	MatterInitiationAssessmentDto,
	RoleGapSuggestionDto,
	RoleTemplateDto,
	TeamMemberDto,
} from "../../api.ts";

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
}

const PRESET_OPTIONS: Array<{ id: CollaborationPresetMode; label: string; hint: string }> = [
	{ id: "solo", label: "单兵直办 · 1 AI", hint: "仅 1 位专才直接完成，无跨岗委托与旁听" },
	{ id: "lead_consult", label: "主责 + 指定协同", hint: "1 位主责统筹，仅向勾选的同事内部请教" },
	{ id: "lead_review", label: "主责 + 定向旁听", hint: "精准指定 1~2 位关键角色做风险旁听" },
	{ id: "human_first", label: "人类先讨论定调", hint: "团队成员先对齐约束与分工，拍板后再派 AI" },
];

/** Pre-launch workflow framing bar for configuring human/AI team size, participation roles, and assessing role gaps. */
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
}: MatterInitiationPanelProps) {
	const [expandedRoster, setExpandedRoster] = useState(false);

	if (!isOwner) return null;

	const allAiIds = members.map((m) => m.id);
	const effectiveAiIds = draftAiMemberIds === null ? allAiIds : draftAiMemberIds;
	const primaryMember = members.find((m) => m.isPrimaryContact) ?? members[0] ?? null;
	const effectiveLeadId =
		selectedMemberId !== "auto" && members.some((m) => m.id === selectedMemberId)
			? selectedMemberId
			: (assessment?.recommendedLeadId ?? primaryMember?.id ?? null);
	const effectiveLead = members.find((m) => m.id === effectiveLeadId) ?? null;

	const activeConsultCount =
		draftPresetMode === "solo" || draftPresetMode === "human_first"
			? 0
			: effectiveAiIds.filter((id) => id !== effectiveLeadId && !draftObserverMemberIds.includes(id)).length;
	const activeObserverCount =
		draftPresetMode === "lead_review"
			? draftObserverMemberIds.filter((id) => id !== effectiveLeadId && effectiveAiIds.includes(id)).length
			: 0;

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
		// Remove from matter AI scope
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
		<section className="initiation-panel" aria-label="立项参与方式与角色适配">
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
					{expandedRoster
						? "收起站位配置"
						: `配置参与人选（${draftPresetMode === "human_first" ? `人类 ${1 + draftCollaboratorIds.length}` : `1 主责 · ${activeConsultCount} 协同 · ${activeObserverCount} 旁听`}）`}
				</button>
			</div>

			{expandedRoster && (
				<div className="initiation-roster-drawer">
					<div className="initiation-roster-group">
						<div className="initiation-roster-label">
							<span>AI 角色站位（点击非主责卡片可切换：协同 / 定向旁听 / 移出）</span>
							<button type="button" className="btn-inline" onClick={() => onOpenArchitect()}>
								+ 按流程设计新角色
							</button>
						</div>
						<div className="initiation-chip-grid">
							{members.map((member) => {
								const isLead = member.id === effectiveLeadId;
								const inGroup = effectiveAiIds.includes(member.id);
								const isObserver =
									draftPresetMode === "lead_review" && draftObserverMemberIds.includes(member.id) && !isLead;
								const tmpl = templateByRoleId.get(member.templateId);
								const toolTag =
									tmpl?.tools.includes("edit") || tmpl?.tools.includes("bash")
										? "读写代码"
										: tmpl?.tools.includes("read")
											? "只读核查"
											: "纯思考文稿";
								const standing =
									draftPresetMode === "human_first"
										? isLead
											? "待命主责"
											: "待命"
										: isLead
											? "主责"
											: !inGroup
												? "不参与"
												: isObserver
													? "定向旁听"
													: "内部协同";

								return (
									<div
										key={member.id}
										className={`initiation-member-chip ${isLead ? "is-lead" : !inGroup ? "is-excluded" : isObserver ? "is-observer" : ""}`}
									>
										<div className="initiation-member-top">
											<button
												type="button"
												className="initiation-member-main"
												onClick={() => cycleMemberStanding(member)}
												title={isLead ? "当前为主责负责人" : "点击切换该成员在本事项的参与站位"}
											>
												<strong>{member.displayName}</strong>
												<span className="initiation-standing-badge">{standing}</span>
											</button>
											{!isLead && draftPresetMode !== "human_first" && (
												<button
													type="button"
													className="btn-inline"
													onClick={() => {
														onSelectLeadMember(member.id);
														if (!inGroup) {
															onUpdateDraftAiMemberIds([...effectiveAiIds, member.id]);
														}
													}}
												>
													设为主责
												</button>
											)}
										</div>
										<span className="initiation-member-meta">
											{member.roleTitle} · {toolTag}
										</span>
									</div>
								);
							})}
						</div>
					</div>

					{nonOwnerCollaborators.length > 0 && (
						<div className="initiation-roster-group">
							<div className="initiation-roster-label">
								<span>预先拉入人类协同同事（含所有者共 {1 + draftCollaboratorIds.length} 人）</span>
							</div>
							<div className="initiation-human-row">
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
											{col.name}（{col.roleTitle}）
										</button>
									);
								})}
							</div>
						</div>
					)}
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
										<button
											type="button"
											className="btn-pill-dark btn-xs"
											onClick={() => onOpenArchitect(assessment.gapSuggestion)}
										>
											设计并补齐专职角色
										</button>
										<button
											type="button"
											className="btn-pill-outline btn-xs"
											onClick={() => {
												if (effectiveLead) onSelectLeadMember(effectiveLead.id);
												onApplyPresetMode("solo");
											}}
										>
											暂由「{effectiveLead?.displayName ?? "主联系人"}」先梳理
										</button>
										<button
											type="button"
											className="btn-inline"
											onClick={() => onApplyPresetMode("human_first")}
										>
											转为人类先讨论
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
