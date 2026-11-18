import { useEffect, useMemo, useState } from "react";
import type {
	AccountUserDto,
	ApplyMatterRoleProposalsPayload,
	CollaboratorDto,
	NewSkillDraftDto,
	OrganizationDto,
	TeamMemberDto,
} from "../../api.ts";
import { buildRoleScopeChoices, type MatterRoleJoinMode, type RoleProposalPayloadDto } from "../../architectApi.ts";
import { formatRoleToolTierLabel } from "../../utils.ts";
import { NewSkillsDraftSection } from "../team/NewSkillsDraftSection.tsx";
import { RoleCapabilityDetails, RoleFindingEvidence } from "../team/RoleDesignDetails.tsx";

interface RoleProposalCardProps {
	matterId: string;
	messageId: string;
	proposals: RoleProposalPayloadDto;
	isArchitectMatter: boolean;
	isOwner: boolean;
	isSuperAdmin?: boolean;
	accountUser?: AccountUserDto | null;
	currentUser?: CollaboratorDto | null;
	organizations?: OrganizationDto[];
	matterOrgId?: string | null;
	isTurnRunning: boolean;
	members: TeamMemberDto[];
	memberName: (id: string) => string;
	onApply: (matterId: string, messageId: string, payload: ApplyMatterRoleProposalsPayload) => Promise<void>;
	onDismiss: (matterId: string, messageId: string) => Promise<void>;
	onQuickReply?: (text: string) => void;
	onLaunchWithNewRoles?: (memberIds: string[]) => void;
}

const MODE_LABELS: Record<string, string> = {
	solo: "单兵直办",
	lead_consult: "主责 + 指定协同",
	lead_review: "主责 + 定向旁听",
	human_first: "人类先讨论定调",
};

function extractOneJobSummary(responsibilities = ""): string {
	const coreLine = responsibilities
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0 && !line.includes("不做 / 边界"));
	if (!coreLine) return responsibilities;
	return coreLine.replace(/^[-*]\s*(?:\*\*核心唯一职责\*\*[：:]\s*)?/, "").trim();
}

/** Inline interactive proposal confirmation card rendered below Role Architect messages. */
export function RoleProposalCard({
	matterId,
	messageId,
	proposals,
	isArchitectMatter,
	isOwner,
	isSuperAdmin = false,
	accountUser = null,
	currentUser = null,
	organizations = [],
	matterOrgId = null,
	isTurnRunning,
	members,
	memberName,
	onApply,
	onDismiss,
	onQuickReply,
	onLaunchWithNewRoles,
}: RoleProposalCardProps) {
	const [selectedBlueprintIndices, setSelectedBlueprintIndices] = useState<number[]>(() =>
		proposals.blueprints.map((_, idx) => idx),
	);
	const [selectedAdjustIds, setSelectedAdjustIds] = useState<string[]>(() =>
		(proposals.roleAdjustments ?? []).map((adj) => adj.memberId),
	);
	const [joinMode, setJoinMode] = useState<MatterRoleJoinMode>(() =>
		proposals.isMidMatterConsult || !isArchitectMatter ? "consult" : "none",
	);
	const [newSkillsByBlueprint, setNewSkillsByBlueprint] = useState<Record<number, NewSkillDraftDto[]>>(() =>
		Object.fromEntries(proposals.blueprints.map((bp, idx) => [idx, bp.draft.newSkills ?? []])),
	);
	const [selectedNewSkillsByBlueprint, setSelectedNewSkillsByBlueprint] = useState<Record<number, number[]>>(() =>
		Object.fromEntries(
			proposals.blueprints.map((bp, idx) => [idx, (bp.draft.newSkills ?? []).map((_, skillIdx) => skillIdx)]),
		),
	);
	const scopeChoices = useMemo(
		() => buildRoleScopeChoices({ isSuperAdmin, accountUser, currentUser, organizations }),
		[isSuperAdmin, accountUser, currentUser, organizations],
	);
	const preferredScopeKey =
		(matterOrgId && scopeChoices.find((c) => c.ownerOrgId === matterOrgId)?.key) ||
		scopeChoices[0]?.key ||
		"personal";
	const [selectedScopeKey, setSelectedScopeKey] = useState<string>(preferredScopeKey);
	const activeScopeChoice = scopeChoices.find((c) => c.key === selectedScopeKey) ??
		scopeChoices[0] ?? { key: "personal", roleScope: "personal" as const, ownerOrgId: null, label: "个人私有" };
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		setSelectedBlueprintIndices(proposals.blueprints.map((_, idx) => idx));
		setSelectedAdjustIds((proposals.roleAdjustments ?? []).map((adj) => adj.memberId));
		setNewSkillsByBlueprint(
			Object.fromEntries(proposals.blueprints.map((bp, idx) => [idx, bp.draft.newSkills ?? []])),
		);
		setSelectedNewSkillsByBlueprint(
			Object.fromEntries(
				proposals.blueprints.map((bp, idx) => [idx, (bp.draft.newSkills ?? []).map((_, skillIdx) => skillIdx)]),
			),
		);
	}, [proposals.blueprints, proposals.roleAdjustments]);

	useEffect(() => {
		if (!scopeChoices.some((c) => c.key === selectedScopeKey)) {
			setSelectedScopeKey(preferredScopeKey);
		}
	}, [scopeChoices, selectedScopeKey, preferredScopeKey]);

	const toggleBlueprint = (idx: number) => {
		setSelectedBlueprintIndices((prev) =>
			prev.includes(idx) ? prev.filter((item) => item !== idx) : [...prev, idx],
		);
	};

	const toggleAdjustment = (memberId: string) => {
		setSelectedAdjustIds((prev) =>
			prev.includes(memberId) ? prev.filter((item) => item !== memberId) : [...prev, memberId],
		);
	};

	const canManageScopeOrgs =
		isSuperAdmin ||
		organizations.some((o) => o.orgRole === "org_owner" || o.orgRole === "org_admin") ||
		(!accountUser && currentUser?.permissionRole !== "collaborator");
	const canApplyBlueprints = isOwner && scopeChoices.length > 0;
	const canApplyAdjustments = isOwner && canManageScopeOrgs;
	const totalSelected = selectedBlueprintIndices.length + (canApplyAdjustments ? selectedAdjustIds.length : 0);
	const existingMemberIds = new Set(members.map((m) => m.id));
	const appliedValidIds = (proposals.appliedMemberIds ?? []).filter((id) => existingMemberIds.has(id));

	const handleConfirmApply = async () => {
		if (busy || totalSelected === 0) return;
		setBusy(true);
		try {
			const selectedMembers = selectedBlueprintIndices
				.map((idx) => {
					const bp = proposals.blueprints[idx];
					if (!bp) return null;
					const { draft } = bp;
					const editedSkills = newSkillsByBlueprint[idx] ?? draft.newSkills ?? [];
					const chosenIndices = selectedNewSkillsByBlueprint[idx] ?? [];
					const confirmedNewSkills = chosenIndices
						.map((sIdx) => editedSkills[sIdx])
						.filter((s): s is NewSkillDraftDto =>
							Boolean(s?.name.trim() && s.description.trim() && s.body.trim()),
						);
					return {
						id: draft.template.id,
						name: draft.template.name,
						title: draft.template.title,
						roleScope: activeScopeChoice.roleScope,
						ownerOrgId: activeScopeChoice.ownerOrgId,
						responsibilities: draft.template.sections.responsibilitiesAndBoundaries,
						keywords: draft.template.keywords,
						skills: draft.template.skills,
						...(confirmedNewSkills.length > 0 ? { newSkills: confirmedNewSkills } : {}),
						mcpDependencies: draft.template.mcpDependencies,
						tools: draft.template.tools,
						antiJobs: draft.antiJobs,
						sections: draft.template.sections,
						isPrimaryContact: false,
					};
				})
				.filter((item): item is NonNullable<typeof item> => Boolean(item));
			const selectedAdjustments = (proposals.roleAdjustments ?? [])
				.filter((adj) => canApplyAdjustments && selectedAdjustIds.includes(adj.memberId))
				.map((adj) => ({
					memberId: adj.memberId,
					...(adj.suggestedTools ? { tools: adj.suggestedTools } : {}),
					...(adj.addAntiJobs?.length ? { addAntiJobs: adj.addAntiJobs } : {}),
					...(adj.workflowNote ? { workflowNote: adj.workflowNote } : {}),
				}));
			await onApply(matterId, messageId, {
				action: "apply",
				members: selectedMembers,
				adjustments: selectedAdjustments,
				matterJoinMode: !isArchitectMatter && selectedMembers.length > 0 ? joinMode : "none",
			});
		} finally {
			setBusy(false);
		}
	};

	const handleDismiss = async () => {
		if (busy) return;
		setBusy(true);
		try {
			await onDismiss(matterId, messageId);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="role-proposal-card">
			{proposals.healthFindings && proposals.healthFindings.length > 0 && (
				<div className="architect-findings-list">
					{proposals.healthFindings.map((finding, idx) => (
						<div key={`${finding.title}-${idx}`} className={`architect-finding-card is-${finding.status}`}>
							<div className="architect-finding-head">
								<span className={`architect-finding-badge is-${finding.status}`}>
									{finding.status === "ok" ? "✓ 正常" : "! 需注意"}
								</span>
								<strong>{finding.title}</strong>
							</div>
							<p>{finding.detail}</p>
							<RoleFindingEvidence finding={finding} />
						</div>
					))}
				</div>
			)}

			{proposals.roleAdjustments && proposals.roleAdjustments.length > 0 && (
				<div className="architect-blueprints">
					<div className="architect-blueprints-head">
						<strong>建议调整现有角色（勾选确认后生效）</strong>
					</div>
					{proposals.roleAdjustments.map((adj) => {
						const checked = canApplyAdjustments && selectedAdjustIds.includes(adj.memberId);
						const disabled = proposals.status !== "pending" || !canApplyAdjustments;
						return (
							<label
								key={adj.memberId}
								className={`architect-blueprint-card adjustment ${checked ? "selected" : ""}`}
							>
								<input
									type="checkbox"
									checked={checked}
									disabled={disabled}
									onChange={() => toggleAdjustment(adj.memberId)}
								/>
								<div className="architect-blueprint-body">
									<div className="architect-blueprint-top">
										<strong>{adj.memberName}</strong>
										<span className="pill">
											{formatRoleToolTierLabel(adj.currentTools)} →{" "}
											{adj.suggestedTools
												? formatRoleToolTierLabel(adj.suggestedTools)
												: formatRoleToolTierLabel(adj.currentTools)}
										</span>
									</div>
									{adj.rationale && <p>{adj.rationale}</p>}
									{adj.addAntiJobs && adj.addAntiJobs.length > 0 && (
										<div className="architect-blueprint-anti">
											<strong>补充不做边界：</strong>
											{adj.addAntiJobs.join("；")}
										</div>
									)}
									{adj.workflowNote && (
										<div className="architect-blueprint-anti">
											<strong>新增协同约束：</strong>
											{adj.workflowNote}
										</div>
									)}
								</div>
							</label>
						);
					})}
				</div>
			)}

			{proposals.blueprints.length > 0 && (
				<div className="architect-blueprints">
					<div className="architect-blueprints-head">
						<strong>建议新建专职角色（勾选确认后创建）</strong>
					</div>
					{proposals.blueprints.map((bp, idx) => {
						const checked = selectedBlueprintIndices.includes(idx);
						const disabled = proposals.status !== "pending" || !canApplyBlueprints;
						const bpNewSkills = newSkillsByBlueprint[idx] ?? bp.draft.newSkills ?? [];
						const bpSelectedSkillIndices = selectedNewSkillsByBlueprint[idx] ?? [];
						return (
							<div
								key={`${bp.draft.template.id}-${idx}`}
								className={`architect-blueprint-card ${checked ? "selected" : ""}`}
							>
								<input
									type="checkbox"
									checked={checked}
									disabled={disabled}
									aria-label={`选择角色 ${bp.draft.template.name}`}
									onChange={() => toggleBlueprint(idx)}
								/>
								<div className="architect-blueprint-body">
									<div className="architect-blueprint-top">
										<strong>
											{bp.draft.template.name}
											<small> ({bp.draft.template.title})</small>
										</strong>
										<span className="pill">{bp.draft.toolSummary}</span>
									</div>
									<p>{extractOneJobSummary(bp.draft.template.sections.responsibilitiesAndBoundaries)}</p>
									<RoleCapabilityDetails draft={bp.draft} />
									{bp.draft.antiJobs.length > 0 && (
										<div className="architect-blueprint-anti">
											<strong>不做边界：</strong>
											{bp.draft.antiJobs.join("；")}
										</div>
									)}
									{bp.rationale && (
										<div className="architect-blueprint-rationale">定位理由：{bp.rationale}</div>
									)}
									{checked && (
										<NewSkillsDraftSection
											skills={bpNewSkills}
											selectedIndices={bpSelectedSkillIndices}
											roleScope={activeScopeChoice.roleScope}
											isSuperAdmin={isSuperAdmin}
											disabled={disabled}
											onToggle={(skillIdx) =>
												setSelectedNewSkillsByBlueprint((prev) => {
													const current = prev[idx] ?? [];
													return {
														...prev,
														[idx]: current.includes(skillIdx)
															? current.filter((item) => item !== skillIdx)
															: [...current, skillIdx],
													};
												})
											}
											onChangeSkills={(next) =>
												setNewSkillsByBlueprint((prev) => ({ ...prev, [idx]: next }))
											}
										/>
									)}
								</div>
							</div>
						);
					})}
				</div>
			)}

			{proposals.recommendedFormation && (
				<div className="architect-formation-box">
					<strong>
						建议阵型 · {MODE_LABELS[proposals.recommendedFormation.mode] ?? proposals.recommendedFormation.mode}：
					</strong>
					<span>
						{proposals.recommendedFormation.rationale}
						{proposals.recommendedFormation.existingMemberIds.length > 0 &&
							`（可复用现有成员：${proposals.recommendedFormation.existingMemberIds.map(memberName).join("、")}）`}
					</span>
				</div>
			)}

			{proposals.status === "pending" && proposals.followUpQuestions.length > 0 && isOwner && onQuickReply && (
				<div className="architect-quick-replies">
					{proposals.followUpQuestions.map((question) => (
						<button
							key={question}
							type="button"
							className="choice-chip"
							disabled={isTurnRunning}
							onClick={() => onQuickReply(question)}
						>
							{question}
						</button>
					))}
				</div>
			)}

			{proposals.status === "pending" && totalSelected > 0 && (canApplyBlueprints || canApplyAdjustments) && (
				<div className="role-proposal-footer">
					{selectedBlueprintIndices.length > 0 && scopeChoices.length > 0 && (
						<label className="role-proposal-join-select">
							<span>使用范围：</span>
							<select
								className="wechat-row-select"
								value={activeScopeChoice.key}
								onChange={(e) => setSelectedScopeKey(e.target.value)}
							>
								{scopeChoices.map((choice) => (
									<option key={choice.key} value={choice.key}>
										{choice.label}
									</option>
								))}
							</select>
						</label>
					)}
					{!isArchitectMatter && selectedBlueprintIndices.length > 0 && (
						<label className="role-proposal-join-select">
							<span>新建角色加入本事项：</span>
							<select
								className="wechat-row-select"
								value={joinMode}
								onChange={(e) => setJoinMode(e.target.value as MatterRoleJoinMode)}
							>
								<option value="consult">设为内部协同</option>
								<option value="observer">设为定向旁听</option>
								<option value="lead">设为主责接手</option>
								<option value="none">仅存入团队库</option>
							</select>
						</label>
					)}
					<div className="role-proposal-actions">
						<button
							type="button"
							className="btn-pill-dark btn-xs"
							disabled={busy || (joinMode !== "none" && isTurnRunning)}
							onClick={() => void handleConfirmApply()}
						>
							{busy
								? "应用中…"
								: !isArchitectMatter && selectedBlueprintIndices.length > 0 && joinMode !== "none"
									? "确认创建并加入本事项"
									: "确认执行所选提案"}
						</button>
						<button
							type="button"
							className="btn-pill-outline btn-xs"
							disabled={busy}
							onClick={() => void handleDismiss()}
						>
							暂不处理
						</button>
					</div>
				</div>
			)}

			{proposals.status === "applied" && (
				<div className="role-proposal-status-bar applied">
					<span>
						✓ 已生效
						{proposals.appliedMemberIds?.length ? ` · 新建 ${proposals.appliedMemberIds.length} 位角色` : ""}
						{proposals.appliedAdjustmentIds?.length
							? ` · 调整 ${proposals.appliedAdjustmentIds.length} 位成员`
							: ""}
						{proposals.appliedMatterJoinMode && proposals.appliedMatterJoinMode !== "none"
							? " · 已加入当前事项"
							: ""}
					</span>
					{isArchitectMatter && appliedValidIds.length > 0 && onLaunchWithNewRoles && (
						<button
							type="button"
							className="btn-pill-outline btn-xs"
							onClick={() => onLaunchWithNewRoles(appliedValidIds)}
						>
							携新角色开新事项 →
						</button>
					)}
				</div>
			)}

			{proposals.status === "dismissed" && (
				<div className="role-proposal-status-bar dismissed">已忽略本条角色建议，可继续补充描述调整方案</div>
			)}
		</div>
	);
}
