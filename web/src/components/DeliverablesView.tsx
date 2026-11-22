import { useEffect, useMemo, useState } from "react";
import {
	type AccountUserDto,
	type BootstrapPayload,
	type CollaboratorDto,
	type DeliverableDto,
	type DistillRsiResult,
	type FeedbackRating,
	updateMatterVisibility,
} from "../api.ts";
import { groupDeliverableSeries } from "../utils/deliverableSeries.ts";
import { collectMatterParticipantIds, formatClockTime, parseDeliverableSummary } from "../utils.ts";
import { DeliverableCard } from "./DeliverableCard.tsx";
import { SpacePages } from "./SpacePages.tsx";
import { ViewFade } from "./ViewTransitions.tsx";

interface DeliverableFamily {
	key: string;
	title: string;
	matterId: string;
	orgId: string | null;
	workspaceId: string | null;
	visibility: "org" | "private";
	workspaceVisibility: "org" | "restricted";
	versions: DeliverableDto[];
	latest: DeliverableDto;
	hasFeedback: boolean;
}

interface DeliverablesViewProps {
	spaceRoute: { deliverableId?: string; pageId?: string };
	bootstrap: BootstrapPayload | null;
	currentUser?: CollaboratorDto | null;
	accountUser?: AccountUserDto | null;
	isSuperAdmin?: boolean;
	activeDeliverable: DeliverableDto | null;
	filteredDeliverables: DeliverableDto[];
	siblingVersions: DeliverableDto[];
	previewUrlFor: (deliverable: DeliverableDto | null) => string | null;
	memberName: (id: string) => string;
	workspaceName: (id: string | null) => string | null;
	organizationName: (id: string | null) => string | null;
	onSubmitFeedback: (
		deliverableId: string,
		payload: { feedback?: string; rating?: FeedbackRating; autoDistill?: boolean },
	) => Promise<void>;
	onDistillExperiences: (
		deliverable: DeliverableDto,
		feedback?: string,
		rating?: FeedbackRating,
	) => Promise<DistillRsiResult | undefined>;
	onCancelDistill?: (matterId: string) => void;
	onStopPreview: (previewId: string) => Promise<void>;
	onSelectDeliverable: (deliverableId: string, matterId?: string) => void;
	onRequestRevision: (deliverable: DeliverableDto) => void;
	onOpenMatterChat: (matterId: string) => void;
	onOpenTeam: () => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
	onNewTask: () => void;
}

export function DeliverablesView(props: DeliverablesViewProps) {
	const [section, setSection] = useState<"pages" | "deliverables">(
		props.spaceRoute.deliverableId ? "deliverables" : "pages",
	);
	useEffect(() => {
		setSection(props.spaceRoute.deliverableId ? "deliverables" : "pages");
	}, [props.spaceRoute]);
	return (
		<div className="subpage-scroll">
			<div className="subpage-inner wide">
				<div className="pane-header">
					<h1>资料空间</h1>
				</div>
				<div className="space-tabs" role="tablist" aria-label="资料空间">
					<button
						type="button"
						role="tab"
						aria-selected={section === "pages"}
						className={`choice-chip ${section === "pages" ? "active" : ""}`}
						onClick={() => setSection("pages")}
					>
						资料
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={section === "deliverables"}
						className={`choice-chip ${section === "deliverables" ? "active" : ""}`}
						onClick={() => setSection("deliverables")}
					>
						成果与版本
					</button>
				</div>
				{section === "pages" ? (
					<SpacePages
						bootstrap={props.bootstrap}
						pageId={props.spaceRoute.pageId}
						onOpenMatter={props.onOpenMatterChat}
						onOpenResult={props.onSelectDeliverable}
					/>
				) : (
					<DeliverablesArchive {...props} />
				)}
			</div>
		</div>
	);
}

function DeliverablesArchive({
	bootstrap,
	currentUser,
	accountUser = null,
	isSuperAdmin = false,
	activeDeliverable,
	filteredDeliverables,
	siblingVersions: _siblingVersions,
	previewUrlFor,
	memberName,
	workspaceName,
	organizationName,
	onSubmitFeedback,
	onDistillExperiences,
	onCancelDistill,
	onStopPreview,
	onSelectDeliverable,
	onRequestRevision,
	onOpenMatterChat,
	onOpenTeam,
	onRefresh,
	onNotice,
	onError,
	onNewTask,
}: DeliverablesViewProps) {
	const [orgFilter, setOrgFilter] = useState<string>("all");
	const [workspaceFilter, setWorkspaceFilter] = useState<string>("all");
	const [visibilityFilter, setVisibilityFilter] = useState<"all" | "org" | "private">("all");
	const [localSearch, setLocalSearch] = useState("");

	const workspaceById = useMemo(() => {
		const map = new Map<string, NonNullable<BootstrapPayload["workspaces"]>[number]>();
		for (const ws of bootstrap?.workspaces ?? []) {
			map.set(ws.id, ws);
		}
		return map;
	}, [bootstrap]);

	const matterMetaMap = useMemo(() => {
		const map = new Map<
			string,
			{
				orgId: string | null;
				workspaceId: string | null;
				visibility: "org" | "private";
				workspaceVisibility: "org" | "restricted";
				createdByUserId: string | null;
			}
		>();
		for (const m of bootstrap?.matters ?? []) {
			const ws = m.workspaceId ? (workspaceById.get(m.workspaceId) ?? null) : null;
			map.set(m.id, {
				orgId: m.orgId ?? ws?.orgId ?? null,
				workspaceId: m.workspaceId ?? null,
				visibility: m.visibility === "private" ? "private" : "org",
				workspaceVisibility: ws?.visibility === "restricted" ? "restricted" : "org",
				createdByUserId: m.createdByUserId ?? null,
			});
		}
		return map;
	}, [bootstrap, workspaceById]);

	const orgRoleById = useMemo(() => {
		const map = new Map<string, NonNullable<BootstrapPayload["organizations"]>[number]["orgRole"]>();
		for (const org of bootstrap?.organizations ?? []) {
			if (org.orgRole) map.set(org.id, org.orgRole);
		}
		return map;
	}, [bootstrap]);

	const allFamilies = useMemo<DeliverableFamily[]>(
		() =>
			groupDeliverableSeries(filteredDeliverables).map((series) => {
				const meta = matterMetaMap.get(series.latest.matterId);
				return {
					...series,
					title: series.latest.title,
					matterId: series.latest.matterId,
					orgId: meta?.orgId ?? null,
					workspaceId: meta?.workspaceId ?? null,
					visibility: meta?.visibility ?? "org",
					workspaceVisibility: meta?.workspaceVisibility ?? "org",
					hasFeedback: series.versions.some((version) => Boolean(version.feedback || version.feedbackRating)),
				};
			}),
		[filteredDeliverables, matterMetaMap],
	);

	const orgFilterOptions = useMemo(() => {
		const counts = new Map<string, number>();
		for (const fam of allFamilies) {
			const key = fam.orgId ?? "__none__";
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		const options: Array<{ key: string; label: string; count: number }> = [];
		for (const org of bootstrap?.organizations ?? []) {
			const count = counts.get(org.id) ?? 0;
			if (count > 0 || (bootstrap?.organizations.length ?? 0) > 1) {
				options.push({ key: org.id, label: org.name, count });
			}
		}
		const unboundCount = counts.get("__none__") ?? 0;
		if (unboundCount > 0) {
			options.push({ key: "__none__", label: "未归属组织", count: unboundCount });
		}
		return options;
	}, [allFamilies, bootstrap]);

	const orgMatchedFamilies = useMemo(() => {
		if (orgFilter === "all") return allFamilies;
		if (orgFilter === "__none__") return allFamilies.filter((fam) => fam.orgId === null);
		return allFamilies.filter((fam) => fam.orgId === orgFilter);
	}, [allFamilies, orgFilter]);

	const workspaceFilterOptions = useMemo(() => {
		const counts = new Map<string, number>();
		for (const fam of orgMatchedFamilies) {
			const wsKey = fam.workspaceId ?? "__none__";
			counts.set(wsKey, (counts.get(wsKey) ?? 0) + 1);
		}

		const options: Array<{ key: string; label: string; count: number }> = [];
		for (const ws of bootstrap?.workspaces ?? []) {
			if (orgFilter !== "all" && orgFilter !== "__none__" && ws.orgId !== orgFilter) continue;
			if (orgFilter === "__none__" && ws.orgId !== null) continue;
			const count = counts.get(ws.id) ?? 0;
			if (count > 0) {
				options.push({ key: ws.id, label: ws.name, count });
			}
		}
		const unboundCount = counts.get("__none__") ?? 0;
		if (unboundCount > 0) {
			options.push({ key: "__none__", label: "通用工作区", count: unboundCount });
		}
		return options;
	}, [orgMatchedFamilies, orgFilter, bootstrap]);

	const scopedVisibilityCounts = useMemo(() => {
		let orgCount = 0;
		let privateCount = 0;
		for (const fam of orgMatchedFamilies) {
			if (fam.visibility === "private" || fam.workspaceVisibility === "restricted") privateCount += 1;
			else orgCount += 1;
		}
		return { orgCount, privateCount };
	}, [orgMatchedFamilies]);

	const visibleFamilies = useMemo(() => {
		const q = localSearch.trim().toLowerCase();
		return orgMatchedFamilies.filter((fam) => {
			if (workspaceFilter === "__none__" && fam.workspaceId !== null) return false;
			if (workspaceFilter !== "all" && workspaceFilter !== "__none__" && fam.workspaceId !== workspaceFilter) {
				return false;
			}
			const isPrivateOrRestricted = fam.visibility === "private" || fam.workspaceVisibility === "restricted";
			if (visibilityFilter === "private" && !isPrivateOrRestricted) return false;
			if (visibilityFilter === "org" && isPrivateOrRestricted) return false;
			if (!q) return true;
			const who = memberName(fam.latest.memberId).toLowerCase();
			return fam.title.toLowerCase().includes(q) || fam.latest.summary.toLowerCase().includes(q) || who.includes(q);
		});
	}, [orgMatchedFamilies, workspaceFilter, visibilityFilter, localSearch, memberName]);

	// Group visible families by project (with org prefix when viewing all orgs).
	const groupedByProject = useMemo(() => {
		const groups = new Map<string, { key: string; label: string; families: DeliverableFamily[] }>();
		const showOrgPrefix = orgFilter === "all" && orgFilterOptions.length > 1;
		for (const fam of visibleFamilies) {
			const key = `${fam.orgId ?? "__none__"}::${fam.workspaceId ?? "__none__"}`;
			const wsLabel = fam.workspaceId ? `仓库：${workspaceName(fam.workspaceId) ?? fam.workspaceId}` : "通用工作区";
			const orgPrefix = showOrgPrefix
				? `${fam.orgId ? (organizationName(fam.orgId) ?? fam.orgId) : "未归属组织"} · `
				: "";
			const label = `${orgPrefix}${wsLabel}`;
			const group = groups.get(key);
			if (group) {
				group.families.push(fam);
			} else {
				groups.set(key, { key, label, families: [fam] });
			}
		}
		return [...groups.values()];
	}, [visibleFamilies, workspaceName, organizationName, orgFilter, orgFilterOptions.length]);

	const effectiveActiveDeliverable = useMemo(() => {
		if (visibleFamilies.length === 0) return null;
		if (activeDeliverable) {
			const matchingFamily = visibleFamilies.find(
				(fam) => fam.matterId === activeDeliverable.matterId && fam.title === activeDeliverable.title,
			);
			if (matchingFamily) {
				return matchingFamily.versions.find((ver) => ver.id === activeDeliverable.id) ?? matchingFamily.latest;
			}
		}
		return visibleFamilies[0]?.latest ?? null;
	}, [visibleFamilies, activeDeliverable]);

	const effectiveSiblingVersions = useMemo(() => {
		if (!bootstrap || !effectiveActiveDeliverable) return [];
		return bootstrap.deliverables
			.filter(
				(d) => d.matterId === effectiveActiveDeliverable.matterId && d.title === effectiveActiveDeliverable.title,
			)
			.sort((a, b) => a.version - b.version);
	}, [bootstrap, effectiveActiveDeliverable]);

	const activeFamilyKey = effectiveActiveDeliverable
		? `${effectiveActiveDeliverable.matterId}::${effectiveActiveDeliverable.title}`
		: null;

	const syncSelectionForFilters = (
		nextOrg: string,
		nextWorkspace: string,
		nextVisibility: "all" | "org" | "private",
	) => {
		const firstMatch = allFamilies.find((fam) => {
			if (nextOrg === "__none__" && fam.orgId !== null) return false;
			if (nextOrg !== "all" && nextOrg !== "__none__" && fam.orgId !== nextOrg) return false;
			if (nextWorkspace === "__none__" && fam.workspaceId !== null) return false;
			if (nextWorkspace !== "all" && nextWorkspace !== "__none__" && fam.workspaceId !== nextWorkspace) return false;
			const isPrivateOrRestricted = fam.visibility === "private" || fam.workspaceVisibility === "restricted";
			if (nextVisibility === "private" && !isPrivateOrRestricted) return false;
			if (nextVisibility === "org" && isPrivateOrRestricted) return false;
			return true;
		});
		if (firstMatch) {
			onSelectDeliverable(firstMatch.latest.id, firstMatch.matterId);
		}
	};

	const handleOrgFilterChange = (nextOrg: string) => {
		setOrgFilter(nextOrg);
		let nextWorkspace = workspaceFilter;
		if (nextOrg !== "all" && workspaceFilter !== "all" && workspaceFilter !== "__none__") {
			const ws = workspaceById.get(workspaceFilter);
			if (!ws || (nextOrg === "__none__" ? ws.orgId !== null : ws.orgId !== nextOrg)) {
				nextWorkspace = "all";
				setWorkspaceFilter("all");
			}
		}
		if (nextOrg !== "all") {
			syncSelectionForFilters(nextOrg, nextWorkspace, visibilityFilter);
		}
	};

	const handleFilterChange = (nextKey: string) => {
		setWorkspaceFilter(nextKey);
		if (nextKey !== "all") {
			syncSelectionForFilters(orgFilter, nextKey, visibilityFilter);
		}
	};

	const handleVisibilityFilterChange = (nextVis: "all" | "org" | "private") => {
		setVisibilityFilter(nextVis);
		if (nextVis !== "all") {
			syncSelectionForFilters(orgFilter, workspaceFilter, nextVis);
		}
	};

	const activeMatterMeta = effectiveActiveDeliverable
		? matterMetaMap.get(effectiveActiveDeliverable.matterId)
		: undefined;
	const activeOrgId = activeMatterMeta?.orgId ?? null;
	const activeOrgRole = activeOrgId ? (orgRoleById.get(activeOrgId) ?? null) : null;
	const activeCanManageDeliverable = Boolean(
		isSuperAdmin ||
			(!accountUser && currentUser?.permissionRole !== "collaborator") ||
			activeOrgRole === "org_owner" ||
			activeOrgRole === "org_admin",
	);
	const activeCanChangeVisibility = Boolean(
		activeMatterMeta &&
			(activeCanManageDeliverable ||
				(accountUser && activeMatterMeta.createdByUserId === accountUser.id && activeOrgRole !== "org_viewer")),
	);
	const activeCanInteract = accountUser ? accountUser.status === "active" && activeOrgRole !== "org_viewer" : true;

	const visiblePreviews = useMemo(() => {
		const previews = bootstrap?.previews ?? [];
		if (orgFilter === "all") return previews;
		return previews.filter((prev) => {
			if (!prev.deliverableId) return orgFilter === "__none__";
			const deliv = (bootstrap?.deliverables ?? []).find((d) => d.id === prev.deliverableId);
			const delivOrgId = deliv ? (matterMetaMap.get(deliv.matterId)?.orgId ?? null) : null;
			return orgFilter === "__none__" ? delivOrgId === null : delivOrgId === orgFilter;
		});
	}, [bootstrap, orgFilter, matterMetaMap]);

	const canStopPreviewItem = (deliverableId: string | null | undefined) => {
		if (isSuperAdmin || (!accountUser && currentUser?.permissionRole !== "collaborator")) return true;
		if (!deliverableId) return false;
		const deliv = (bootstrap?.deliverables ?? []).find((d) => d.id === deliverableId);
		const delivOrgId = deliv ? (matterMetaMap.get(deliv.matterId)?.orgId ?? null) : null;
		const role = delivOrgId ? orgRoleById.get(delivOrgId) : null;
		return role === "org_owner" || role === "org_admin";
	};

	const handleToggleDeliverableVisibility = async (matterId: string, nextVisibility: "org" | "private") => {
		try {
			await updateMatterVisibility(matterId, nextVisibility);
			await onRefresh();
			onNotice(
				nextVisibility === "private"
					? "访问范围已收紧为私密（仅发起人、受邀人及本组织管理员可见）"
					: "访问范围已设为所属组织内可见",
			);
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		}
	};

	return (
		<div>
			<div>
				<div className="pane-header-row">
					<div className="pane-header">
						<h2>成果与版本</h2>
						<p>
							{visibleFamilies.length !== allFamilies.length
								? `筛选显示 ${visibleFamilies.length} / ${allFamilies.length} 项成果 · 共 ${bootstrap?.deliverables.length ?? 0} 个版本`
								: `共 ${allFamilies.length} 项成果 · ${bootstrap?.deliverables.length ?? 0} 个版本（按组织、项目与版本自动收拢）`}
						</p>
					</div>
					<button type="button" className="btn-pill-dark" onClick={onNewTask}>
						+ 布置新任务
					</button>
				</div>

				{allFamilies.length > 0 && (
					<div className="deliverables-toolbar">
						<div className="deliverables-filter-bars">
							{orgFilterOptions.length > 0 && (
								<div className="project-filter-bar org-filter-bar">
									<button
										type="button"
										aria-pressed={orgFilter === "all"}
										className={`choice-chip ${orgFilter === "all" ? "active" : ""}`}
										onClick={() => handleOrgFilterChange("all")}
									>
										全部组织 ({allFamilies.length})
									</button>
									{orgFilterOptions.map((opt) => (
										<button
											key={opt.key}
											type="button"
											aria-pressed={orgFilter === opt.key}
											className={`choice-chip ${orgFilter === opt.key ? "active" : ""}`}
											onClick={() => handleOrgFilterChange(opt.key)}
										>
											{opt.label} ({opt.count})
										</button>
									))}
								</div>
							)}
							<div className="project-filter-bar">
								<button
									type="button"
									aria-pressed={workspaceFilter === "all"}
									className={`choice-chip ${workspaceFilter === "all" ? "active" : ""}`}
									onClick={() => handleFilterChange("all")}
								>
									全部项目 ({orgMatchedFamilies.length})
								</button>
								{workspaceFilterOptions.map((opt) => (
									<button
										key={opt.key}
										type="button"
										aria-pressed={workspaceFilter === opt.key}
										className={`choice-chip ${workspaceFilter === opt.key ? "active" : ""}`}
										onClick={() => handleFilterChange(opt.key)}
									>
										{opt.label} ({opt.count})
									</button>
								))}
								{scopedVisibilityCounts.privateCount > 0 && (
									<>
										<button
											type="button"
											aria-pressed={visibilityFilter === "org"}
											className={`choice-chip scope-chip ${visibilityFilter === "org" ? "active" : ""}`}
											onClick={() =>
												handleVisibilityFilterChange(visibilityFilter === "org" ? "all" : "org")
											}
										>
											组织共享 ({scopedVisibilityCounts.orgCount})
										</button>
										<button
											type="button"
											aria-pressed={visibilityFilter === "private"}
											className={`choice-chip scope-chip is-private ${visibilityFilter === "private" ? "active" : ""}`}
											onClick={() =>
												handleVisibilityFilterChange(visibilityFilter === "private" ? "all" : "private")
											}
										>
											仅限私密/受限 ({scopedVisibilityCounts.privateCount})
										</button>
									</>
								)}
							</div>
						</div>
						<input
							className="input-field deliverables-search"
							placeholder="按成果标题、摘要或负责人筛选…"
							value={localSearch}
							onChange={(e) => setLocalSearch(e.target.value)}
						/>
					</div>
				)}

				{allFamilies.length === 0 ? (
					<div className="ui-card">
						<p className="ui-empty-note">
							暂无交付记录。回到对话工作台发送需求或点选示范任务，完成后成果会自动归拢到这里。
						</p>
					</div>
				) : (
					<div className="deliverables-workspace">
						<div className="deliverables-master-col">
							{groupedByProject.length === 0 ? (
								<div className="ui-card">
									<p className="ui-empty-note compact">当前筛选条件下暂无匹配成果。</p>
								</div>
							) : (
								groupedByProject.map((group) => (
									<div key={group.key} className="deliverable-group">
										<div className="deliverable-group-header">
											<span>{group.label}</span>
											<span className="pill">{group.families.length}</span>
										</div>
										<div className="deliverable-family-list">
											{group.families.map((fam) => {
												const isActive = fam.key === activeFamilyKey;
												return (
													<button
														type="button"
														key={fam.key}
														className={`deliverable-family-item ${isActive ? "active" : ""}`}
														onClick={() => onSelectDeliverable(fam.latest.id, fam.matterId)}
													>
														<div className="deliverable-family-top">
															<span className="deliverable-family-title">{fam.title}</span>
															<span className="deliverable-version-badge">
																V{fam.latest.version}
																{fam.versions.length > 1 ? ` · ${fam.versions.length}版` : ""}
															</span>
														</div>
														<div className="deliverable-family-summary">
															{parseDeliverableSummary(fam.latest.summary).lead}
														</div>
														<div className="deliverable-family-meta">
															<span>
																{memberName(fam.latest.memberId)} ·{" "}
																{formatClockTime(fam.latest.createdAt)}
															</span>
															<span className="deliverable-family-badges">
																{fam.visibility === "private" ? (
																	<span className="scope-lock-pill is-private">私密</span>
																) : fam.workspaceVisibility === "restricted" ? (
																	<span className="scope-lock-pill is-restricted">受限</span>
																) : null}
																{fam.latest.feedbackRating === "positive" ? (
																	<span className="feedback-badge">✓ 认可采纳</span>
																) : fam.latest.feedbackRating === "negative" ? (
																	<span className="feedback-badge negative">↻ 需修订</span>
																) : fam.hasFeedback ? (
																	<span className="feedback-badge">✓ 已验收</span>
																) : null}
															</span>
														</div>
													</button>
												);
											})}
										</div>
									</div>
								))
							)}
						</div>

						<div className="deliverables-detail-col">
							{effectiveActiveDeliverable ? (
								<ViewFade key={effectiveActiveDeliverable.id} type="deliverable">
									<DeliverableCard
										deliverable={effectiveActiveDeliverable}
										siblingVersions={effectiveSiblingVersions}
										memberName={memberName(effectiveActiveDeliverable.memberId)}
										workspaceId={activeMatterMeta?.workspaceId ?? null}
										workspaceName={workspaceName(activeMatterMeta?.workspaceId ?? null)}
										organizationName={activeOrgId ? organizationName(activeOrgId) : null}
										visibility={activeMatterMeta?.visibility ?? "org"}
										workspaceVisibility={activeMatterMeta?.workspaceVisibility ?? "org"}
										members={bootstrap?.members ?? []}
										workspaces={bootstrap?.workspaces ?? []}
										organizations={bootstrap?.organizations ?? []}
										memoriesByMember={bootstrap?.memoriesByMember ?? {}}
										participantIds={collectMatterParticipantIds({
											matter:
												bootstrap?.matters.find((m) => m.id === effectiveActiveDeliverable.matterId) ??
												null,
											deliverables: (bootstrap?.deliverables ?? []).filter(
												(d) => d.matterId === effectiveActiveDeliverable.matterId,
											),
										})}
										resolveMemberName={memberName}
										resolveWorkspaceName={workspaceName}
										resolveOrganizationName={organizationName}
										viewUrl={previewUrlFor(effectiveActiveDeliverable)}
										isOwner={activeCanManageDeliverable}
										canInteract={activeCanInteract}
										canChangeVisibility={activeCanChangeVisibility}
										onChangeVisibility={(next) =>
											handleToggleDeliverableVisibility(effectiveActiveDeliverable.matterId, next)
										}
										onSubmitFeedback={onSubmitFeedback}
										onDistillExperiences={onDistillExperiences}
										onCancelDistill={
											onCancelDistill
												? () => onCancelDistill(effectiveActiveDeliverable.matterId)
												: undefined
										}
										onSelectVersion={(id) => onSelectDeliverable(id)}
										onRequestRevision={() => onRequestRevision(effectiveActiveDeliverable)}
										onOpenMatterChat={() => onOpenMatterChat(effectiveActiveDeliverable.matterId)}
										onOpenTeam={onOpenTeam}
										onRefresh={onRefresh}
										onNotice={onNotice}
										onError={onError}
									/>
								</ViewFade>
							) : (
								<div className="ui-card">
									<p className="ui-empty-note">
										{visibleFamilies.length === 0
											? "当前筛选条件下暂无资料详情。"
											: "请在左侧选择一条资料查看详情。"}
									</p>
								</div>
							)}

							{visiblePreviews.length > 0 && (
								<section className="ui-section">
									<div className="ui-section-head">
										<h2 className="ui-section-title">独立预览服务</h2>
									</div>
									{visiblePreviews.map((prev) => (
										<div key={prev.id} className="compact-row static">
											<div>
												<div className="ui-row-title">{prev.title}</div>
												<div className="ui-row-sub">
													{prev.url} · 状态：{prev.status}
												</div>
											</div>
											<div className="ui-row-actions">
												{prev.status === "running" && (
													<>
														<a className="btn-secondary" href={prev.url} target="_blank" rel="noreferrer">
															打开
														</a>
														{canStopPreviewItem(prev.deliverableId) && (
															<button
																type="button"
																className="btn-secondary"
																onClick={() => void onStopPreview(prev.id)}
															>
																停止
															</button>
														)}
													</>
												)}
											</div>
										</div>
									))}
								</section>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
