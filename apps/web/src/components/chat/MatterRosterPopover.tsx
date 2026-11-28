import { type RefObject, useId, useState } from "react";
import type { CollaboratorDto, TeamMemberDto } from "../../api.ts";
import { filterBusinessMembers, isArchitectMember } from "../../architectApi.ts";
import { BotFaceIcon, Button, Input, Select } from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";
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
			className="absolute top-16 right-6 max-lg:right-4 max-lg:w-[calc(100%-32px)] w-[min(348px,calc(100%-48px))] max-h-[min(76vh,calc(100%-88px))] z-30 flex flex-col gap-3 border border-line rounded-xl bg-stage shadow-lg p-3.5 overflow-hidden"
		>
			{rosterMode === "add" && isOwner ? (
				<>
					<div className="flex items-center justify-between gap-2">
						<button
							type="button"
							className="border-0 bg-transparent text-xs text-ink-secondary px-1 py-0.5 cursor-pointer hover:text-ink"
							onClick={() => {
								onModeChange("view");
								onSearchChange("");
							}}
						>
							‹ 返回
						</button>
						<strong className="text-sm font-semibold text-ink">添加协作成员</strong>
						<button
							type="button"
							className="border-0 bg-transparent text-xs text-accent font-semibold px-1 py-0.5 cursor-pointer hover:text-accent-hover"
							onClick={() => {
								onModeChange("view");
								onSearchChange("");
							}}
						>
							完成
						</button>
					</div>

					<Input
						type="search"
						size="sm"
						className="bg-sidebar"
						placeholder="搜索同事或 AI 角色"
						value={rosterSearch}
						onChange={(e) => onSearchChange(e.target.value)}
					/>

					<div className="flex flex-col gap-3 max-h-[320px] overflow-y-auto overscroll-contain">
						<div className="flex flex-col gap-1.5">
							<div className="flex items-center justify-between gap-2 text-micro font-semibold text-ink-muted">
								<span>人类同事</span>
								<Button
									variant="inline"
									size="xs"
									onClick={() => {
										onClose();
										onOpenTeam();
									}}
								>
									团队页新增 ›
								</Button>
							</div>
							{filteredCollabCandidates.length === 0 ? (
								<div className="text-xs text-ink-muted py-1 px-0.5">
									{nonOwnerCollaborators.length === 0 ? "暂无协同同事，可在团队页新增" : "无匹配同事"}
								</div>
							) : (
								filteredCollabCandidates.map((col) => {
									const inMatter = assignedCollabIds.includes(col.id);
									const canToggle = Boolean(selectedMatterId && onUpdateMatterCollaborators);
									return (
										<div
											key={col.id}
											className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-sidebar border border-transparent text-left"
										>
											{canToggle ? (
												<button
													type="button"
													className="flex items-center gap-2 min-w-0 flex-1 border-0 bg-transparent p-0 text-left cursor-pointer"
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
													<span
														className={cn(
															"size-4 rounded-xs border grid place-items-center text-micro font-bold shrink-0",
															inMatter
																? "bg-accent border-accent text-white"
																: "bg-stage border-line-strong text-transparent",
														)}
													>
														{inMatter ? "✓" : ""}
													</span>
													<span className="size-6 rounded-sm bg-info-bg text-info-text grid place-items-center text-micro font-bold shrink-0">
														{col.name.slice(0, 1).toUpperCase()}
													</span>
													<span className="flex flex-col min-w-0">
														<strong className="text-xs text-ink truncate">{col.name}</strong>
														<small className="text-micro text-ink-muted truncate">{col.roleTitle}</small>
													</span>
												</button>
											) : (
												<div className="flex items-center gap-2 min-w-0 flex-1">
													<span className="size-6 rounded-sm bg-info-bg text-info-text grid place-items-center text-micro font-bold shrink-0">
														{col.name.slice(0, 1).toUpperCase()}
													</span>
													<span className="flex flex-col min-w-0">
														<strong className="text-xs text-ink truncate">{col.name}</strong>
														<small className="text-micro text-ink-muted truncate">{col.roleTitle}</small>
													</span>
												</div>
											)}
										</div>
									);
								})
							)}
						</div>

						<div className="flex flex-col gap-1.5">
							<div className="flex items-center justify-between gap-2 text-micro font-semibold text-ink-muted">
								<span>可添回的 AI 角色</span>
								{removableBusinessPool.length > 0 && (
									<Button
										variant="inline"
										size="xs"
										onClick={() => onUpdateMatterAiMembers(allBusinessMemberIds)}
									>
										全部添回
									</Button>
								)}
							</div>
							{removableBusinessPool.length === 0 ? (
								<div className="text-xs text-ink-muted py-1 px-0.5">全部业务 AI 角色已参与当前事项</div>
							) : filteredRemovedAi.length === 0 ? (
								<div className="text-xs text-ink-muted py-1 px-0.5">无匹配 AI 角色</div>
							) : (
								filteredRemovedAi.map((peer) => {
									const theme = getMemberThemeById(members, peer.id);
									return (
										<button
											key={peer.id}
											type="button"
											className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-sidebar border border-transparent text-left w-full cursor-pointer hover:bg-hover transition-colors"
											onClick={() => onUpdateMatterAiMembers([...matterAiMemberIds, peer.id])}
										>
											<span className="flex items-center gap-2 min-w-0 flex-1">
												<span className="size-4 rounded-xs border border-line-strong bg-stage text-ink-secondary grid place-items-center text-micro font-bold shrink-0">
													+
												</span>
												<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="xs" mood="idle" />
												<span className="flex flex-col min-w-0">
													<strong className="text-xs text-ink truncate">{peer.displayName}</strong>
													<small className="text-micro text-ink-muted truncate">{peer.roleTitle}</small>
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
					<Input
						type="search"
						size="sm"
						className="bg-sidebar"
						placeholder="搜索协作成员 / AI"
						value={rosterSearch}
						onChange={(e) => onSearchChange(e.target.value)}
					/>

					<div className="grid grid-cols-4 gap-x-2 gap-y-3 max-h-[290px] overflow-y-auto overscroll-contain py-0.5">
						{showOwnerTile && (
							<div
								className="flex flex-col items-center gap-0.5 w-full min-w-0 overflow-hidden text-center"
								title={`${ownerLabel} · 所有者`}
							>
								<div className="relative size-11.5 rounded-lg grid place-items-center text-base font-bold bg-cta text-stage">
									{ownerLabel.slice(0, 1).toUpperCase()}
								</div>
								<span className="text-micro text-ink max-w-full truncate">{ownerLabel}</span>
								<span className="text-micro text-ink-muted leading-tight max-w-full truncate">
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
									className={cn(
										"group flex flex-col items-center gap-0.5 w-full min-w-0 overflow-hidden bg-transparent border-0 p-0 text-center",
										canRemoveHuman && "cursor-pointer",
									)}
									title={canRemoveHuman ? `移出 ${col.name}` : `${col.name} · ${col.roleTitle}`}
									onClick={() => {
										if (canRemoveHuman && onUpdateMatterCollaborators) {
											onUpdateMatterCollaborators(assignedCollabIds.filter((id) => id !== col.id));
										}
									}}
								>
									<div
										className={cn(
											"relative size-11.5 rounded-lg grid place-items-center text-base font-bold bg-info-bg text-info-text transition-all",
											canRemoveHuman && "group-hover:-translate-y-0.5 group-hover:shadow-md",
										)}
									>
										{col.name.slice(0, 1).toUpperCase()}
										{canRemoveHuman && (
											<span className="absolute -top-1 -right-1 size-4.5 rounded-full bg-danger-text text-white border border-stage text-xs font-bold leading-none grid place-items-center">
												−
											</span>
										)}
									</div>
									<span className="text-micro text-ink max-w-full truncate">{col.name}</span>
									<span className="text-micro text-ink-muted leading-tight max-w-full truncate">
										{currentUser?.id === col.id ? "我" : col.roleTitle}
									</span>
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
							return (
								<div
									key={`ai-${ai.id}`}
									className="flex flex-col items-center gap-1 w-full min-w-0 overflow-hidden"
								>
									<button
										type="button"
										className={cn(
											"group flex flex-col items-center gap-0.5 w-full min-w-0 overflow-hidden bg-transparent border-0 p-0 text-center",
											(canRemoveAi || canConfigure) && "cursor-pointer",
										)}
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
										<div
											className={cn(
												"relative size-11.5 grid place-items-center transition-all",
												isLead ? "ring-2 ring-accent rounded-xl" : "rounded-lg",
												(canRemoveAi || canConfigure) &&
													"group-hover:-translate-y-0.5 group-hover:shadow-md",
											)}
										>
											<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="md" mood="idle" />
											{canRemoveAi && (
												<span className="absolute -top-1 -right-1 size-4.5 rounded-full bg-danger-text text-white border border-stage text-xs font-bold leading-none grid place-items-center">
													−
												</span>
											)}
										</div>
										<span className="text-micro text-ink max-w-full truncate">{ai.displayName}</span>
										<span
											className={cn(
												"text-micro leading-tight max-w-full truncate",
												isLead
													? "text-accent font-semibold"
													: isObs
														? "text-observer-text"
														: "text-ink-muted",
											)}
										>
											{tagLabel}
										</span>
									</button>
								</div>
							);
						})}

						{isOwner && !query && (
							<button
								type="button"
								className="group flex flex-col items-center gap-0.5 w-full min-w-0 overflow-hidden bg-transparent border-0 p-0 text-center cursor-pointer"
								title="邀请同事或添回已移出的 AI 角色"
								onClick={() => {
									onSearchChange("");
									onModeChange("add");
								}}
							>
								<div className="relative size-11.5 rounded-lg grid place-items-center bg-stage border-[1.5px] border-dashed border-line-strong text-ink-muted text-xl font-normal transition-all group-hover:-translate-y-0.5 group-hover:shadow-md">
									+
								</div>
								<span className="text-micro text-ink max-w-full truncate">添加</span>
							</button>
						)}

						{isOwner && !query && hasRemovable && (
							<button
								type="button"
								className="group flex flex-col items-center gap-0.5 w-full min-w-0 overflow-hidden bg-transparent border-0 p-0 text-center cursor-pointer"
								title={rosterMode === "remove" ? "完成移出" : "移出协同同事或非负责人 AI"}
								onClick={() => onModeChange(rosterMode === "remove" ? "view" : "remove")}
							>
								<div
									className={cn(
										"relative size-11.5 rounded-lg grid place-items-center transition-all group-hover:-translate-y-0.5 group-hover:shadow-md",
										rosterMode === "remove"
											? "border border-danger-border text-danger-text bg-danger-bg text-xs font-semibold"
											: "bg-stage border-[1.5px] border-dashed border-line-strong text-ink-muted text-xl font-normal",
									)}
								>
									−
								</div>
								<span className="text-micro text-ink max-w-full truncate">
									{rosterMode === "remove" ? "完成" : "移出"}
								</span>
							</button>
						)}
					</div>

					<div className="flex flex-col gap-2 pt-2.5 border-t border-line">
						<div className="flex items-center justify-between gap-2.5 text-xs text-ink">
							<span className="whitespace-nowrap shrink-0">事项负责人</span>
							{isOwner ? (
								<Select
									size="sm"
									className="w-auto bg-sidebar"
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
								</Select>
							) : (
								<span className="text-xs text-ink-muted">{leadAi?.displayName ?? "默认"}</span>
							)}
						</div>
						{selectedMember && isOwner && rosterMode === "view" && (
							<fieldset className="m-0 min-w-0 px-2.5 py-1.5 border border-line rounded-md flex flex-col gap-1.5">
								<legend className="px-1 font-semibold text-xs text-ink">{selectedMember.displayName}</legend>
								{onUpdateMatterConsultMembers && (
									<label className="flex items-center justify-between gap-2.5 text-xs text-ink cursor-pointer">
										<span className="whitespace-nowrap shrink-0">允许主责委托</span>
										<input
											type="checkbox"
											className="size-3.5 accent-accent cursor-pointer"
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
									<label className="flex items-center justify-between gap-2.5 text-xs text-ink cursor-pointer">
										<span className="whitespace-nowrap shrink-0">旁听补充</span>
										<input
											type="checkbox"
											className="size-3.5 accent-accent cursor-pointer"
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
								<div className="flex items-center justify-between gap-2.5 text-xs text-ink">
									<span className="whitespace-nowrap shrink-0">AI 旁听</span>
									{isOwner ? (
										<button
											type="button"
											role="switch"
											aria-checked={observersEnabled}
											aria-label="AI 旁听"
											aria-describedby={observerHintId}
											className={cn(
												"relative w-9 h-5 rounded-pill border-0 p-0.5 cursor-pointer transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-accent",
												observersEnabled ? "bg-accent" : "bg-line-strong",
											)}
											onClick={() => onToggleObserversEnabled(!observersEnabled)}
										>
											<span
												className={cn(
													"block size-4 rounded-full bg-white shadow-sm transition-transform",
													observersEnabled && "translate-x-4",
												)}
											/>
										</button>
									) : (
										<span className="text-xs text-ink-muted">{observersEnabled ? "已开启" : "已关闭"}</span>
									)}
								</div>
								<p className="mt-1 mb-0 text-xs text-ink-muted" id={observerHintId}>
									协作 AI 可主动补充，主责照常回应和委托。
								</p>
							</div>
						)}
						{isOwner ? (
							<div className="flex items-center justify-between gap-2.5 text-xs text-ink">
								<span className="whitespace-nowrap shrink-0">团队同事</span>
								<button
									type="button"
									className="border-0 bg-transparent p-0 text-xs text-ink-muted cursor-pointer hover:text-ink"
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
							<div className="flex items-center justify-between gap-2.5 text-xs text-ink">
								<span className="whitespace-nowrap shrink-0">协同权限</span>
								<span className="text-xs text-ink-muted">AI 执行需所有者确认</span>
							</div>
						)}
						{isOwner && selectedMatterId && onConsultArchitect && !isArchitectMember(leadAi) && (
							<div className="flex items-center justify-between gap-2.5 text-xs text-ink pt-2 mt-0.5 border-t border-dashed border-line">
								<span className="whitespace-nowrap shrink-0">缺少角色或需调整？</span>
								<button
									type="button"
									className="border-0 bg-transparent p-0 text-xs text-ink-muted cursor-pointer hover:text-ink disabled:opacity-45 disabled:cursor-not-allowed"
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
