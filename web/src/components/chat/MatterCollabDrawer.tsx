import { type ReactNode, type RefObject, useEffect, useMemo, useState } from "react";
import type { MatterDetailPayload, MemberMemoryDto, OrganizationDto, TeamMemberDto, WorkspaceDto } from "../../api.ts";
import type { DeliverableSeries } from "../../utils/deliverableSeries.ts";
import { formatClockTime, formatNoticeEventLine, isKeyNoticeEvent } from "../../utils.ts";
import { InlineExperienceReviewSection } from "../ExperienceReviewPanel.tsx";
import { MatterDeliverablesPanel } from "./MatterDeliverablesPanel.tsx";

export type MatterCollabTab = "delegations" | "events" | "experiences" | "deliverables";

interface MatterCollabDrawerProps {
	panelRef: RefObject<HTMLDivElement | null>;
	collabTab: MatterCollabTab;
	matterDetail: MatterDetailPayload;
	deliverableSeries: DeliverableSeries[];
	selectedMemberId: string;
	delegationPanel: ReactNode;
	matterMemories: MemberMemoryDto[];
	matterParticipantIds: string[];
	members: TeamMemberDto[];
	workspaces: WorkspaceDto[];
	organizations: OrganizationDto[];
	distillingMatter: boolean;
	distillNote: string | null;
	memberName: (id: string) => string;
	workspaceName: (id: string | null) => string | null;
	organizationName: (id: string | null) => string | null;
	onSelectTab: (tab: MatterCollabTab) => void;
	onOpenDeliverable: (id: string) => void;
	onClose: () => void;
	onDistill: () => void;
	onCancelDistill?: () => void;
	onOpenTeam: () => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

/** Top dock panel housing internal delegations, tool/process notice logs, matter experience distillation, and deliverables. */
export function MatterCollabDrawer({
	panelRef,
	collabTab,
	matterDetail,
	deliverableSeries,
	selectedMemberId,
	delegationPanel,
	matterMemories,
	matterParticipantIds,
	members,
	workspaces,
	organizations,
	distillingMatter,
	distillNote,
	memberName,
	workspaceName,
	organizationName,
	onSelectTab,
	onOpenDeliverable,
	onClose,
	onDistill,
	onCancelDistill,
	onOpenTeam,
	onRefresh,
	onNotice,
	onError,
}: MatterCollabDrawerProps) {
	const [eventsKeyOnly, setEventsKeyOnly] = useState(false);
	const [showAllEvents, setShowAllEvents] = useState(false);
	useEffect(() => panelRef.current?.focus({ preventScroll: true }), [panelRef]);

	const filteredNotices = useMemo(() => {
		const ordered = [...matterDetail.noticeMessages].reverse();
		return eventsKeyOnly ? ordered.filter((entry) => isKeyNoticeEvent(entry.content)) : ordered;
	}, [matterDetail.noticeMessages, eventsKeyOnly]);

	const visibleNotices = useMemo(
		() => (showAllEvents ? filteredNotices : filteredNotices.slice(0, 80)),
		[filteredNotices, showAllEvents],
	);

	return (
		<div ref={panelRef} role="dialog" tabIndex={-1} aria-label="事项协作面板" className="collab-dock-panel">
			<div className="collab-dock-inner">
				<div className="collab-dock-head">
					<div className="collab-tabs">
						<button
							type="button"
							className={`collab-tab-btn ${collabTab === "delegations" ? "active" : ""}`}
							aria-pressed={collabTab === "delegations"}
							onClick={() => onSelectTab("delegations")}
						>
							团队委托
						</button>
						<button
							type="button"
							className={`collab-tab-btn ${collabTab === "events" ? "active" : ""}`}
							aria-pressed={collabTab === "events"}
							onClick={() => onSelectTab("events")}
						>
							事项事件 ({matterDetail.noticeMessages.length})
						</button>
						<button
							type="button"
							className={`collab-tab-btn ${collabTab === "experiences" ? "active" : ""}`}
							aria-pressed={collabTab === "experiences"}
							onClick={() => onSelectTab("experiences")}
						>
							经验复盘 ({matterMemories.length})
						</button>
						<button
							type="button"
							className={`collab-tab-btn ${collabTab === "deliverables" ? "active" : ""}`}
							aria-pressed={collabTab === "deliverables"}
							onClick={() => onSelectTab("deliverables")}
						>
							成果库 ({deliverableSeries.length})
						</button>
					</div>
					<button type="button" className="btn-inline" onClick={onClose}>
						收起
					</button>
				</div>
				<div className="collab-log">
					{collabTab === "experiences" ? (
						<InlineExperienceReviewSection
							matterId={matterDetail.matter.id}
							defaultMemberId={matterDetail.matter.leadMemberId ?? selectedMemberId}
							workspaceId={matterDetail.matter.workspaceId}
							participantIds={matterParticipantIds}
							memories={matterMemories}
							members={members}
							workspaces={workspaces}
							organizations={organizations}
							memberName={memberName}
							workspaceName={workspaceName}
							organizationName={organizationName}
							title="本事项团队经验复盘"
							lastDistillNote={distillNote}
							distilling={distillingMatter}
							onDistill={onDistill}
							onCancelDistill={onCancelDistill}
							onOpenTeam={onOpenTeam}
							onRefresh={onRefresh}
							onNotice={onNotice}
							onError={onError}
						/>
					) : collabTab === "delegations" ? (
						delegationPanel
					) : collabTab === "deliverables" ? (
						<MatterDeliverablesPanel
							series={deliverableSeries}
							memberName={memberName}
							onOpenDeliverable={onOpenDeliverable}
						/>
					) : matterDetail.noticeMessages.length === 0 ? (
						<p className="muted-hint">当前事项暂无底层工具或过程事件。</p>
					) : (
						<div className="collab-section">
							<div className="collab-events-toolbar">
								<div className="memory-filter-tabs">
									<button
										type="button"
										className={`choice-chip ${!eventsKeyOnly ? "active" : ""}`}
										onClick={() => setEventsKeyOnly(false)}
									>
										全部事件 ({matterDetail.noticeMessages.length})
									</button>
									<button
										type="button"
										className={`choice-chip ${eventsKeyOnly ? "active" : ""}`}
										onClick={() => setEventsKeyOnly(true)}
									>
										仅看关键/异常事件
									</button>
								</div>
								<span className="inline-participants-note">按最新时间倒序</span>
							</div>
							{visibleNotices.length === 0 ? (
								<p className="muted-hint">当前过滤条件下暂无关键或异常事件。</p>
							) : (
								<div className="collab-events-list">
									{visibleNotices.map((entry) => {
										const line = formatNoticeEventLine(entry.content);
										const isError = /异常|失败/.test(line);
										return (
											<div key={entry.id} className={`collab-event-row ${isError ? "is-error" : ""}`}>
												<span className="collab-event-meta">
													<strong>{memberName(entry.senderId)}</strong>
													<span>{formatClockTime(entry.createdAt)}</span>
												</span>
												<span className="collab-event-text">{line}</span>
											</div>
										);
									})}
									{!showAllEvents && filteredNotices.length > visibleNotices.length && (
										<button
											type="button"
											className="btn-pill-outline btn-xs"
											onClick={() => setShowAllEvents(true)}
										>
											展开更早事件（剩余 {filteredNotices.length - visibleNotices.length} 条）
										</button>
									)}
								</div>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
