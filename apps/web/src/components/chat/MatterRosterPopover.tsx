import { type RefObject, useId, useState } from "react";
import type { CollaboratorDto, TeamMemberDto } from "../../api.ts";
import { filterBusinessMembers, isArchitectMember } from "../../architectApi.ts";
import { BotFaceIcon } from "../../primitives/BotFaceIcon.tsx";
import { getMemberThemeById } from "../../utils.ts";

interface MatterRosterPopoverProps {
	panelRef: RefObject<HTMLDivElement | null>;
	rosterMode: "view" | "add" | "remove";
	rosterSearch: string;
	isOwner: boolean;
	isTurnRunning: boolean;
	selectedMatterId: string | null;
	currentUser?: CollaboratorDto | null;
	ownerCollab: CollaboratorDto | null;
	nonOwnerCollaborators: CollaboratorDto[];
	matterHumanParticipants: CollaboratorDto[];
	assignedCollabIds: string[];
	members: TeamMemberDto[];
	inGroupAiMembers: TeamMemberDto[];
	nonLeadGroupAiMembers: TeamMemberDto[];
	removedAiMembers: TeamMemberDto[];
	leadAi: TeamMemberDto | null;
	observersEnabled?: boolean;
	observerAis: TeamMemberDto[];
	matterAiMemberIds: string[];
	matterConsultMemberIds?: string[] | null;
	onSearchChange: (value: string) => void;
	onModeChange: (mode: "view" | "add" | "remove") => void;
	onClose: () => void;
	onOpenTeam: () => void;
	onChangeLeadMember: (memberId: string) => void;
	onUpdateMatterAiMembers: (aiMemberIds: string[]) => void;
	onUpdateMatterConsultMembers?: (consultMemberIds: string[] | null) => void;
	onToggleObserversEnabled?: (enabled: boolean) => void;
	onUpdateMatterObservers?: (observerIds: string[]) => void;
	onUpdateMatterCollaborators?: (collaboratorIds: string[]) => void;
	onConsultArchitect?: () => void;
}

/** Popover showing the active matter's human & AI participants, lead selector, and observer toggle. */
export function MatterRosterPopover({
	panelRef,
	rosterMode,
	rosterSearch,
	isOwner,
	isTurnRunning,
	selectedMatterId,
	currentUser,
	ownerCollab,
	nonOwnerCollaborators,
	matterHumanParticipants,
	assignedCollabIds,
	members,
	inGroupAiMembers,
	nonLeadGroupAiMembers,
	removedAiMembers,
	leadAi,
	observersEnabled = false,
	observerAis,
	matterAiMemberIds,
	matterConsultMemberIds = null,
	onSearchChange,
	onModeChange,
	onClose,
	onOpenTeam,
	onChangeLeadMember,
	onUpdateMatterAiMembers,
	onUpdateMatterConsultMembers,
	onToggleObserversEnabled,
	onUpdateMatterObservers,
	onUpdateMatterCollaborators,
	onConsultArchitect,
}: MatterRosterPopoverProps) {
	const [settingsMemberId, setSettingsMemberId] = useState<string | null>(null);
	const observerHintId = useId();
	const selectedMember = nonLeadGroupAiMembers.find(({ id }) => id === settingsMemberId);
	const query = rosterSearch.trim().toLowerCase();
	const matchesQuery = (...parts: Array<string | undefined>) =>
		!query || parts.some((part) => (part ?? "").toLowerCase().includes(query));
	const ownerLabel = ownerCollab?.name ?? "我";
	const showOwnerTile = matchesQuery(ownerLabel, "所有者");
	const filteredHumanTiles = matterHumanParticipants.filter((col) => matchesQuery(col.name, col.roleTitle, "同事"));
	const filteredAiTiles = inGroupAiMembers.filter((ai) => {
		const isLead = ai.id === leadAi?.id;
		const isObs = observerAis.some((obs) => obs.id === ai.id);
		const roleLabel = isLead ? "负责人" : isObs ? "旁听" : "成员";
		return matchesQuery(ai.displayName, ai.roleTitle, roleLabel);
	});
	const hasRemovable =
		Boolean(selectedMatterId && onUpdateMatterCollaborators && matterHumanParticipants.length > 0) ||
		nonLeadGroupAiMembers.length > 0;
	const filteredCollabCandidates = nonOwnerCollaborators.filter((col) => matchesQuery(col.name, col.roleTitle));
	const removableBusinessPool = filterBusinessMembers(removedAiMembers);
	const allBusinessMemberIds = filterBusinessMembers(members).map((m) => m.id);
	const filteredRemovedAi = removableBusinessPool.filter((ai) => matchesQuery(ai.displayName, ai.roleTitle));

	return (
		<div
			ref={panelRef}
			role="dialog"
			aria-label="协作成员"
			className="collab-dock-panel unified-roster-panel wechat-roster-panel"
		>
			{rosterMode === "add" && isOwner ? (
				<>
					<div className="wechat-roster-nav">
						<button
							type="button"
							className="wechat-nav-btn"
							onClick={() => {
								onModeChange("view");
								onSearchChange("");
							}}
						>
							‹ 返回
						</button>
						<strong className="wechat-nav-title">添加协作成员</strong>
						<button
							type="button"
							className="wechat-nav-btn primary"
							onClick={() => {
								onModeChange("view");
								onSearchChange("");
							}}
						>
							完成
						</button>
					</div>

					<input
						type="search"
						className="wechat-roster-search"
						placeholder="搜索同事或 AI 角色"
						value={rosterSearch}
						onChange={(e) => onSearchChange(e.target.value)}
					/>

					<div className="wechat-add-scroll">
						<div className="wechat-add-group">
							<div className="wechat-add-head">
								<span>人类同事</span>
								<button
									type="button"
									className="btn-inline"
									onClick={() => {
										onClose();
										onOpenTeam();
									}}
								>
									团队页新增 ›
								</button>
							</div>
							{filteredCollabCandidates.length === 0 ? (
								<div className="wechat-empty-row">
									{nonOwnerCollaborators.length === 0 ? "暂无协同同事，可在团队页新增" : "无匹配同事"}
								</div>
							) : (
								filteredCollabCandidates.map((col) => {
									const inMatter = assignedCollabIds.includes(col.id);
									const canToggle = Boolean(selectedMatterId && onUpdateMatterCollaborators);
									return (
										<div key={col.id} className="wechat-pick-row">
											{canToggle ? (
												<button
													type="button"
													className="wechat-pick-main wechat-pick-toggle"
													aria-pressed={inMatter}
													aria-label={`邀请 ${col.name} 参与本事项`}
													onClick={() => {
														if (!onUpdateMatterCollaborators) return;
														const nextIds = inMatter
															? assignedCollabIds.filter((id) => id !== col.id)
															: [...assignedCollabIds, col.id];
														onUpdateMatterCollaborators(nextIds);
													}}
												>
													<span className={`wechat-check-box ${inMatter ? "checked" : ""}`}>
														{inMatter ? "✓" : ""}
													</span>
													<span className="wechat-mini-avatar human">
														{col.name.slice(0, 1).toUpperCase()}
													</span>
													<span className="wechat-pick-text">
														<strong>{col.name}</strong>
														<small>{col.roleTitle}</small>
													</span>
												</button>
											) : (
												<div className="wechat-pick-main">
													<span className="wechat-mini-avatar human">
														{col.name.slice(0, 1).toUpperCase()}
													</span>
													<span className="wechat-pick-text">
														<strong>{col.name}</strong>
														<small>{col.roleTitle}</small>
													</span>
												</div>
											)}
										</div>
									);
								})
							)}
						</div>

						<div className="wechat-add-group">
							<div className="wechat-add-head">
								<span>可添回的 AI 角色</span>
								{removableBusinessPool.length > 0 && (
									<button
										type="button"
										className="btn-inline"
										onClick={() => onUpdateMatterAiMembers(allBusinessMemberIds)}
									>
										全部添回
									</button>
								)}
							</div>
							{removableBusinessPool.length === 0 ? (
								<div className="wechat-empty-row">全部业务 AI 角色已参与当前事项</div>
							) : filteredRemovedAi.length === 0 ? (
								<div className="wechat-empty-row">无匹配 AI 角色</div>
							) : (
								filteredRemovedAi.map((peer) => {
									const theme = getMemberThemeById(members, peer.id);
									return (
										<button
											key={peer.id}
											type="button"
											className="wechat-pick-row clickable"
											onClick={() => onUpdateMatterAiMembers([...matterAiMemberIds, peer.id])}
										>
											<span className="wechat-pick-main">
												<span className="wechat-check-box">+</span>
												<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="xs" mood="idle" />
												<span className="wechat-pick-text">
													<strong>{peer.displayName}</strong>
													<small>{peer.roleTitle}</small>
												</span>
											</span>
										</button>
									);
								})
							)}
						</div>
					</div>
				</>
			) : (
				<>
					<input
						type="search"
						className="wechat-roster-search"
						placeholder="搜索协作成员 / AI"
						value={rosterSearch}
						onChange={(e) => onSearchChange(e.target.value)}
					/>

					<div className="wechat-member-grid">
						{showOwnerTile && (
							<div className="wechat-member-tile" title={`${ownerLabel} · 所有者`}>
								<div className="wechat-avatar-box owner">{ownerLabel.slice(0, 1).toUpperCase()}</div>
								<span className="wechat-tile-name">{ownerLabel}</span>
								<span className="wechat-tile-tag">
									所有者{!ownerCollab || currentUser?.id === ownerCollab.id ? " · 我" : ""}
								</span>
							</div>
						)}

						{filteredHumanTiles.map((col) => {
							const canRemoveHuman =
								rosterMode === "remove" && isOwner && Boolean(selectedMatterId && onUpdateMatterCollaborators);
							return (
								<button
									key={`human-${col.id}`}
									type="button"
									className={`wechat-member-tile ${canRemoveHuman ? "interactive" : ""}`}
									title={canRemoveHuman ? `移出 ${col.name}` : `${col.name} · ${col.roleTitle}`}
									onClick={() => {
										if (canRemoveHuman && onUpdateMatterCollaborators) {
											onUpdateMatterCollaborators(assignedCollabIds.filter((id) => id !== col.id));
										}
									}}
								>
									<div className="wechat-avatar-box human">
										{col.name.slice(0, 1).toUpperCase()}
										{canRemoveHuman && <span className="wechat-remove-badge">−</span>}
									</div>
									<span className="wechat-tile-name">{col.name}</span>
									<span className="wechat-tile-tag">{currentUser?.id === col.id ? "我" : col.roleTitle}</span>
								</button>
							);
						})}

						{filteredAiTiles.map((ai) => {
							const theme = getMemberThemeById(members, ai.id);
							const isLead = ai.id === leadAi?.id;
							const isObs = observerAis.some((obs) => obs.id === ai.id);
							const canRemoveAi = rosterMode === "remove" && isOwner && !isLead;
							const canConfigure = rosterMode === "view" && isOwner && !isLead;
							const tagLabel = isLead ? "负责人" : isObs ? "旁听" : "成员";
							const tagClass = isLead ? "lead" : isObs ? "observer" : "";
							return (
								<div key={`ai-${ai.id}`} className="wechat-member-tile-wrap">
									<button
										type="button"
										className={`wechat-member-tile ${canRemoveAi || canConfigure ? "interactive" : ""}`}
										aria-pressed={canConfigure ? selectedMember?.id === ai.id : undefined}
										title={
											canRemoveAi
												? `移出 ${ai.displayName}`
												: canConfigure
													? `设置 ${ai.displayName}`
													: tagLabel
										}
										onClick={() => {
											if (canRemoveAi) {
												onUpdateMatterAiMembers(
													inGroupAiMembers.map((m) => m.id).filter((id) => id !== ai.id),
												);
											} else if (canConfigure) {
												setSettingsMemberId((current) => (current === ai.id ? null : ai.id));
											}
										}}
									>
										<div className={`wechat-avatar-box ai ${isLead ? "is-lead" : ""}`}>
											<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="md" mood="idle" />
											{canRemoveAi && <span className="wechat-remove-badge">−</span>}
										</div>
										<span className="wechat-tile-name">{ai.displayName}</span>
										<span className={`wechat-tile-tag ${tagClass}`}>{tagLabel}</span>
									</button>
								</div>
							);
						})}

						{isOwner && !query && (
							<button
								type="button"
								className="wechat-member-tile interactive"
								title="邀请同事或添回已移出的 AI 角色"
								onClick={() => {
									onSearchChange("");
									onModeChange("add");
								}}
							>
								<div className="wechat-avatar-box action">+</div>
								<span className="wechat-tile-name">添加</span>
							</button>
						)}

						{isOwner && !query && hasRemovable && (
							<button
								type="button"
								className="wechat-member-tile interactive"
								title={rosterMode === "remove" ? "完成移出" : "移出协同同事或非负责人 AI"}
								onClick={() => onModeChange(rosterMode === "remove" ? "view" : "remove")}
							>
								<div className={`wechat-avatar-box action ${rosterMode === "remove" ? "active" : ""}`}>−</div>
								<span className="wechat-tile-name">{rosterMode === "remove" ? "完成" : "移出"}</span>
							</button>
						)}
					</div>

					<div className="wechat-roster-rows">
						<div className="wechat-roster-row">
							<span>事项负责人</span>
							{isOwner ? (
								<select
									className="wechat-row-select"
									aria-label="事项负责人"
									value={leadAi?.id ?? ""}
									disabled={isTurnRunning}
									title={isTurnRunning ? "当前回合执行中，完成后可更换负责人" : "切换当前事项负责人"}
									onChange={(e) => onChangeLeadMember(e.target.value)}
								>
									{inGroupAiMembers.map((ai) => (
										<option key={ai.id} value={ai.id}>
											{ai.displayName}
										</option>
									))}
								</select>
							) : (
								<span className="wechat-row-val">{leadAi?.displayName ?? "默认"}</span>
							)}
						</div>
						{selectedMember && isOwner && rosterMode === "view" && (
							<fieldset className="wechat-member-settings">
								<legend>{selectedMember.displayName}</legend>
								{onUpdateMatterConsultMembers && (
									<label className="wechat-roster-row">
										<span>允许主责委托</span>
										<input
											type="checkbox"
											checked={
												matterConsultMemberIds == null || matterConsultMemberIds.includes(selectedMember.id)
											}
											onChange={(event) => {
												const current = matterConsultMemberIds ?? nonLeadGroupAiMembers.map(({ id }) => id);
												onUpdateMatterConsultMembers(
													event.target.checked
														? [...new Set([...current, selectedMember.id])]
														: current.filter((id) => id !== selectedMember.id),
												);
											}}
										/>
									</label>
								)}
								{onUpdateMatterObservers && observersEnabled && (
									<label className="wechat-roster-row">
										<span>旁听补充</span>
										<input
											type="checkbox"
											checked={observerAis.some(({ id }) => id === selectedMember.id)}
											onChange={(event) => {
												const current = observerAis.map(({ id }) => id);
												onUpdateMatterObservers(
													event.target.checked
														? [...new Set([...current, selectedMember.id])]
														: current.filter((id) => id !== selectedMember.id),
												);
											}}
										/>
									</label>
								)}
							</fieldset>
						)}
						{onToggleObserversEnabled && (
							<div>
								<div className="wechat-roster-row">
									<span>AI 旁听</span>
									{isOwner ? (
										<button
											type="button"
											role="switch"
											aria-checked={observersEnabled}
											aria-label="AI 旁听"
											aria-describedby={observerHintId}
											className={`wechat-switch ${observersEnabled ? "on" : ""}`}
											onClick={() => onToggleObserversEnabled(!observersEnabled)}
										>
											<span className="wechat-switch-thumb" />
										</button>
									) : (
										<span className="wechat-row-val">{observersEnabled ? "已开启" : "已关闭"}</span>
									)}
								</div>
								<p className="wechat-roster-hint" id={observerHintId}>
									协作 AI 可主动补充，主责照常回应和委托。
								</p>
							</div>
						)}
						{isOwner ? (
							<div className="wechat-roster-row">
								<span>团队同事</span>
								<button
									type="button"
									className="wechat-row-action"
									onClick={() => {
										if (nonOwnerCollaborators.length > 0) {
											onSearchChange("");
											onModeChange("add");
										} else {
											onClose();
											onOpenTeam();
										}
									}}
								>
									{nonOwnerCollaborators.length > 0
										? `${matterHumanParticipants.length}/${nonOwnerCollaborators.length} 人`
										: "去团队页新增"}{" "}
									›
								</button>
							</div>
						) : (
							<div className="wechat-roster-row">
								<span>协同权限</span>
								<span className="wechat-row-val">AI 执行需所有者确认</span>
							</div>
						)}
						{isOwner && selectedMatterId && onConsultArchitect && !isArchitectMember(leadAi) && (
							<div className="wechat-roster-row is-architect-row">
								<span>缺少角色或需调整？</span>
								<button
									type="button"
									className="wechat-row-action"
									disabled={isTurnRunning}
									title={
										isTurnRunning
											? "请等待当前回合完成后邀请架构师"
											: "请角色架构师结合本事项对话诊断并生成可加入的新角色"
									}
									onClick={() => {
										onClose();
										onConsultArchitect();
									}}
								>
									请角色架构师介入 ›
								</button>
							</div>
						)}
					</div>
				</>
			)}
		</div>
	);
}
