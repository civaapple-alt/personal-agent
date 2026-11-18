import type { RefObject } from "react";
import type { CollaboratorDto, TeamMemberDto } from "../../api.ts";
import { filterBusinessMembers, isArchitectMember } from "../../architectApi.ts";
import { copyCollaboratorInviteUrl } from "../../clipboard.ts";
import { getMemberThemeById } from "../../utils.ts";
import { BotFaceIcon } from "../BotFaceIcon.tsx";

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
	observersEnabled: boolean;
	discussionAiEnabled?: boolean;
	observerAis: TeamMemberDto[];
	specialistIds: string[];
	matterAiMemberIds: string[];
	matterConsultMemberIds?: string[] | null;
	onSearchChange: (value: string) => void;
	onModeChange: (mode: "view" | "add" | "remove") => void;
	onClose: () => void;
	onOpenTeam: () => void;
	onNotice: (message: string) => void;
	onChangeLeadMember: (memberId: string) => void;
	onUpdateMatterAiMembers: (aiMemberIds: string[]) => void;
	onUpdateMatterConsultMembers?: (consultMemberIds: string[] | null) => void;
	onToggleDiscussionAiEnabled?: (enabled: boolean) => void;
	onToggleObserversEnabled: (enabled: boolean) => void;
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
	observersEnabled,
	discussionAiEnabled = false,
	observerAis,
	specialistIds,
	matterAiMemberIds,
	matterConsultMemberIds = null,
	onSearchChange,
	onModeChange,
	onClose,
	onOpenTeam,
	onNotice,
	onChangeLeadMember,
	onUpdateMatterAiMembers,
	onUpdateMatterConsultMembers,
	onToggleDiscussionAiEnabled,
	onToggleObserversEnabled,
	onUpdateMatterObservers,
	onUpdateMatterCollaborators,
	onConsultArchitect,
}: MatterRosterPopoverProps) {
	const query = rosterSearch.trim().toLowerCase();
	const matchesQuery = (...parts: Array<string | undefined>) =>
		!query || parts.some((part) => (part ?? "").toLowerCase().includes(query));
	const ownerLabel = ownerCollab?.name ?? "我";
	const showOwnerTile = matchesQuery(ownerLabel, "所有者");
	const filteredHumanTiles = matterHumanParticipants.filter((col) => matchesQuery(col.name, col.roleTitle, "同事"));
	const filteredAiTiles = inGroupAiMembers.filter((ai) => {
		const isLead = ai.id === leadAi?.id;
		const isObs = observerAis.some((obs) => obs.id === ai.id);
		const roleLabel = isLead ? "负责人" : isObs ? "定向旁听" : specialistIds.includes(ai.id) ? "协同" : "协作成员";
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
											{col.token && (
												<button
													type="button"
													className="wechat-copy-link"
													onClick={() => void copyCollaboratorInviteUrl(col, onNotice)}
												>
													复制链接
												</button>
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
									className={`wechat-member-tile ${canRemoveHuman || (isOwner && col.token) ? "interactive" : ""}`}
									title={
										canRemoveHuman
											? `移出 ${col.name}`
											: isOwner && col.token
												? `${col.name} · ${col.roleTitle}（点击复制邀请链接）`
												: `${col.name} · ${col.roleTitle}`
									}
									onClick={() => {
										if (canRemoveHuman && onUpdateMatterCollaborators) {
											onUpdateMatterCollaborators(assignedCollabIds.filter((id) => id !== col.id));
										} else if (isOwner && col.token) {
											void copyCollaboratorInviteUrl(col, onNotice);
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
							const isConsult =
								!isLead && (matterConsultMemberIds == null || matterConsultMemberIds.includes(ai.id));
							const canRemoveAi = rosterMode === "remove" && isOwner && !isLead;
							const canPromoteLead = rosterMode === "view" && isOwner && !isLead && !isTurnRunning;
							const canToggleObserver =
								rosterMode === "view" && isOwner && !isLead && Boolean(onUpdateMatterObservers);
							const canToggleConsult =
								rosterMode === "view" && isOwner && !isLead && Boolean(onUpdateMatterConsultMembers);
							const tagLabel = isLead
								? "负责人"
								: isConsult && isObs
									? "请教·旁听"
									: isObs
										? "仅旁听"
										: specialistIds.includes(ai.id)
											? "协同"
											: isConsult
												? "可请教"
												: "仅在组";
							const tagClass = isLead ? "lead" : isObs ? "observer" : "";
							return (
								<div key={`ai-${ai.id}`} className="wechat-member-tile-wrap">
									<button
										type="button"
										className={`wechat-member-tile ${canRemoveAi || canPromoteLead ? "interactive" : ""}`}
										title={
											canRemoveAi
												? `移出 ${ai.displayName}`
												: isLead
													? `${ai.displayName} · 当前事项负责人`
													: isTurnRunning
														? `${ai.displayName}（当前回合执行中，完成后可切换负责人）`
														: isOwner
															? `点击将「${ai.displayName}」设为当前事项负责人`
															: `${ai.displayName} · ${tagLabel}`
										}
										onClick={() => {
											if (canRemoveAi) {
												onUpdateMatterAiMembers(
													inGroupAiMembers.map((m) => m.id).filter((id) => id !== ai.id),
												);
											} else if (canPromoteLead) {
												onChangeLeadMember(ai.id);
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
									{(canToggleConsult || canToggleObserver) && (
										<div className="wechat-chip-row">
											{canToggleConsult && (
												<button
													type="button"
													className={`wechat-obs-chip ${isConsult ? "active" : ""}`}
													title={isConsult ? "关闭主责按需请教（不影响旁听）" : "允许主责按需请教该成员"}
													onClick={() => {
														const baseConsult =
															matterConsultMemberIds == null
																? nonLeadGroupAiMembers.map((m) => m.id)
																: matterConsultMemberIds.filter((id) => id !== leadAi?.id);
														const nextConsult = isConsult
															? baseConsult.filter((id) => id !== ai.id)
															: [...new Set([...baseConsult, ai.id])];
														onUpdateMatterConsultMembers?.(nextConsult);
													}}
												>
													{isConsult ? "可请教" : "+请教"}
												</button>
											)}
											{canToggleObserver && (
												<button
													type="button"
													className={`wechat-obs-chip ${isObs ? "active" : ""}`}
													title={isObs ? "取消定向旁听（不影响按需请教）" : "设为本事项定向旁听把关"}
													onClick={() => {
														const currentObs = observerAis.map((o) => o.id);
														const nextObs = isObs
															? currentObs.filter((id) => id !== ai.id)
															: [...currentObs, ai.id];
														onUpdateMatterObservers?.(nextObs);
													}}
												>
													{isObs ? "旁听中" : "+旁听"}
												</button>
											)}
										</div>
									)}
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
						<div className="wechat-roster-row">
							<span>
								AI 旁听
								{observersEnabled && observerAis.length > 0 && (
									<small className="wechat-row-sub">（{observerAis.length} 位）</small>
								)}
							</span>
							{isOwner ? (
								<button
									type="button"
									role="switch"
									aria-checked={observersEnabled}
									aria-label="开启或关闭事项 AI 旁听"
									className={`wechat-switch ${observersEnabled ? "on" : ""}`}
									title={
										observersEnabled
											? "开启中：本事项内非负责人 AI 将自动旁听补充"
											: "已关闭：仅当前事项负责人跟进答复"
									}
									onClick={() => onToggleObserversEnabled(!observersEnabled)}
								>
									<span className="wechat-switch-thumb" />
								</button>
							) : (
								<span className="wechat-row-val">
									{observersEnabled ? `已开启（${observerAis.length} 位）` : "未开启"}
								</span>
							)}
						</div>
						{onToggleDiscussionAiEnabled && (
							<div className="wechat-roster-row">
								<span>讨论时 AI 参与</span>
								{isOwner ? (
									<button
										type="button"
										role="switch"
										aria-checked={discussionAiEnabled}
										aria-label="开启或关闭讨论模式 AI 参与"
										className={`wechat-switch ${discussionAiEnabled ? "on" : ""}`}
										title={
											discussionAiEnabled
												? "开启中：在「团队聊天讨论」发言后，AI 成员可查证和交流"
												: "已关闭：「团队聊天讨论」仅人类交流，不调用 AI"
										}
										onClick={() => onToggleDiscussionAiEnabled(!discussionAiEnabled)}
									>
										<span className="wechat-switch-thumb" />
									</button>
								) : (
									<span className="wechat-row-val">{discussionAiEnabled ? "已开启" : "已关闭"}</span>
								)}
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
