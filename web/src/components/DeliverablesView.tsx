import { useMemo, useState } from "react";
import type { BootstrapPayload, CollaboratorDto, DeliverableDto, DistillRsiResult, FeedbackRating } from "../api.ts";
import { collectMatterParticipantIds, formatClockTime, parseDeliverableSummary } from "../utils.ts";
import { DeliverableCard } from "./DeliverableCard.tsx";

interface DeliverableFamily {
	key: string;
	title: string;
	matterId: string;
	workspaceId: string | null;
	versions: DeliverableDto[];
	latest: DeliverableDto;
	hasFeedback: boolean;
}

interface DeliverablesViewProps {
	bootstrap: BootstrapPayload | null;
	currentUser?: CollaboratorDto | null;
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

export function DeliverablesView({
	bootstrap,
	currentUser,
	activeDeliverable,
	filteredDeliverables,
	siblingVersions,
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
	const [workspaceFilter, setWorkspaceFilter] = useState<string>("all");
	const [localSearch, setLocalSearch] = useState("");

	const matterWorkspaceMap = useMemo(() => {
		const map = new Map<string, string | null>();
		for (const m of bootstrap?.matters ?? []) {
			map.set(m.id, m.workspaceId);
		}
		return map;
	}, [bootstrap]);

	// Collapse V1/V2/V3 of the same deliverable (`matterId::title`) into one entry.
	const allFamilies = useMemo(() => {
		const map = new Map<string, DeliverableDto[]>();
		for (const deliv of filteredDeliverables) {
			const key = `${deliv.matterId}::${deliv.title}`;
			const existing = map.get(key);
			if (existing) {
				existing.push(deliv);
			} else {
				map.set(key, [deliv]);
			}
		}

		const families: DeliverableFamily[] = [];
		for (const [key, list] of map.entries()) {
			const versions = [...list].sort((a, b) => a.version - b.version);
			const latest = versions[versions.length - 1];
			if (!latest) continue;
			families.push({
				key,
				title: latest.title,
				matterId: latest.matterId,
				workspaceId: matterWorkspaceMap.get(latest.matterId) ?? null,
				versions,
				latest,
				hasFeedback: versions.some((v) => Boolean(v.feedback || v.feedbackRating)),
			});
		}

		families.sort((a, b) => b.latest.createdAt.localeCompare(a.latest.createdAt));
		return families;
	}, [filteredDeliverables, matterWorkspaceMap]);

	const workspaceFilterOptions = useMemo(() => {
		const counts = new Map<string, number>();
		for (const fam of allFamilies) {
			const wsKey = fam.workspaceId ?? "__none__";
			counts.set(wsKey, (counts.get(wsKey) ?? 0) + 1);
		}

		const options: Array<{ key: string; label: string; count: number }> = [];
		for (const ws of bootstrap?.workspaces ?? []) {
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
	}, [allFamilies, bootstrap]);

	const visibleFamilies = useMemo(() => {
		const q = localSearch.trim().toLowerCase();
		return allFamilies.filter((fam) => {
			if (workspaceFilter === "__none__" && fam.workspaceId !== null) return false;
			if (workspaceFilter !== "all" && workspaceFilter !== "__none__" && fam.workspaceId !== workspaceFilter) {
				return false;
			}
			if (!q) return true;
			const who = memberName(fam.latest.memberId).toLowerCase();
			return fam.title.toLowerCase().includes(q) || fam.latest.summary.toLowerCase().includes(q) || who.includes(q);
		});
	}, [allFamilies, workspaceFilter, localSearch, memberName]);

	// Group visible families by project so multiple projects stay visually separated.
	const groupedByProject = useMemo(() => {
		const groups = new Map<string, { key: string; label: string; families: DeliverableFamily[] }>();
		for (const fam of visibleFamilies) {
			const key = fam.workspaceId ?? "__none__";
			const label = fam.workspaceId ? `仓库：${workspaceName(fam.workspaceId) ?? fam.workspaceId}` : "通用工作区";
			const group = groups.get(key);
			if (group) {
				group.families.push(fam);
			} else {
				groups.set(key, { key, label, families: [fam] });
			}
		}
		return [...groups.values()];
	}, [visibleFamilies, workspaceName]);

	const activeFamilyKey = activeDeliverable ? `${activeDeliverable.matterId}::${activeDeliverable.title}` : null;

	const handleFilterChange = (nextKey: string) => {
		setWorkspaceFilter(nextKey);
		const firstMatch = allFamilies.find((fam) => {
			if (nextKey === "all") return true;
			if (nextKey === "__none__") return fam.workspaceId === null;
			return fam.workspaceId === nextKey;
		});
		if (
			firstMatch &&
			(!activeDeliverable || (matterWorkspaceMap.get(activeDeliverable.matterId) ?? "__none__") !== nextKey)
		) {
			if (nextKey !== "all") {
				onSelectDeliverable(firstMatch.latest.id, firstMatch.matterId);
			}
		}
	};

	return (
		<div className="subpage-scroll">
			<div className="subpage-inner wide">
				<div className="pane-header-row">
					<div className="pane-header">
						<h1>交付成果库</h1>
						<p>
							共 {allFamilies.length} 项成果 · {bootstrap?.deliverables.length ?? 0}{" "}
							个版本（按项目与版本自动收拢）
						</p>
					</div>
					<button type="button" className="btn-pill-dark" onClick={onNewTask}>
						+ 布置新任务
					</button>
				</div>

				{allFamilies.length > 0 && (
					<div className="deliverables-toolbar">
						<div className="project-filter-bar">
							<button
								type="button"
								className={`choice-chip ${workspaceFilter === "all" ? "active" : ""}`}
								onClick={() => handleFilterChange("all")}
							>
								全部项目 ({allFamilies.length})
							</button>
							{workspaceFilterOptions.map((opt) => (
								<button
									key={opt.key}
									type="button"
									className={`choice-chip ${workspaceFilter === opt.key ? "active" : ""}`}
									onClick={() => handleFilterChange(opt.key)}
								>
									{opt.label} ({opt.count})
								</button>
							))}
						</div>
						<input
							className="input-field deliverables-search"
							placeholder="按成果标题、摘要或负责人筛选..."
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
															{fam.latest.feedbackRating === "positive" ? (
																<span className="feedback-badge">✓ 认可采纳</span>
															) : fam.latest.feedbackRating === "negative" ? (
																<span className="feedback-badge negative">↻ 需修订</span>
															) : fam.hasFeedback ? (
																<span className="feedback-badge">✓ 已验收</span>
															) : null}
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
							{activeDeliverable ? (
								<DeliverableCard
									key={activeDeliverable.id}
									deliverable={activeDeliverable}
									siblingVersions={siblingVersions}
									memberName={memberName(activeDeliverable.memberId)}
									workspaceId={matterWorkspaceMap.get(activeDeliverable.matterId) ?? null}
									workspaceName={workspaceName(matterWorkspaceMap.get(activeDeliverable.matterId) ?? null)}
									members={bootstrap?.members ?? []}
									workspaces={bootstrap?.workspaces ?? []}
									organizations={bootstrap?.organizations ?? []}
									memoriesByMember={bootstrap?.memoriesByMember ?? {}}
									participantIds={collectMatterParticipantIds({
										matter: bootstrap?.matters.find((m) => m.id === activeDeliverable.matterId) ?? null,
										deliverables: (bootstrap?.deliverables ?? []).filter(
											(d) => d.matterId === activeDeliverable.matterId,
										),
									})}
									resolveMemberName={memberName}
									resolveWorkspaceName={workspaceName}
									resolveOrganizationName={organizationName}
									viewUrl={previewUrlFor(activeDeliverable)}
									isOwner={currentUser?.permissionRole !== "collaborator"}
									onSubmitFeedback={onSubmitFeedback}
									onDistillExperiences={onDistillExperiences}
									onCancelDistill={
										onCancelDistill ? () => onCancelDistill(activeDeliverable.matterId) : undefined
									}
									onSelectVersion={(id) => onSelectDeliverable(id)}
									onRequestRevision={() => onRequestRevision(activeDeliverable)}
									onOpenMatterChat={() => onOpenMatterChat(activeDeliverable.matterId)}
									onOpenTeam={onOpenTeam}
									onRefresh={onRefresh}
									onNotice={onNotice}
									onError={onError}
								/>
							) : (
								<div className="ui-card">
									<p className="ui-empty-note">请在左侧选择一条交付成果查看详情。</p>
								</div>
							)}

							{bootstrap && bootstrap.previews.length > 0 && (
								<section className="ui-section">
									<div className="ui-section-head">
										<h2 className="ui-section-title">独立预览服务</h2>
									</div>
									{bootstrap.previews.map((prev) => (
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
														{currentUser?.permissionRole !== "collaborator" && (
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
