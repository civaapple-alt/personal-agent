import { type ReactNode, type RefObject, useEffect, useMemo, useState } from "react";
import type { MatterDetailPayload } from "../../api.ts";
import { formatClockTime, formatNoticeEventLine, isKeyNoticeEvent } from "../../utils.ts";

export type MatterCollabTab = "delegations" | "events" | "deliverables";

interface MatterCollabDrawerProps {
	panelRef: RefObject<HTMLDivElement | null>;
	collabTab: MatterCollabTab;
	matterDetail: MatterDetailPayload;
	delegationPanel: ReactNode;
	memberName: (id: string) => string;
	onSelectTab: (tab: MatterCollabTab) => void;
	onOpenDeliverable: (id?: string) => void;
	onClose: () => void;
}

/** Top dock panel housing internal delegations, tool/process notice logs, and deliverables. */
export function MatterCollabDrawer({
	panelRef,
	collabTab,
	matterDetail,
	delegationPanel,
	memberName,
	onSelectTab,
	onOpenDeliverable,
	onClose,
}: MatterCollabDrawerProps) {
	const [eventsKeyOnly, setEventsKeyOnly] = useState(false);
	const [showAllEvents, setShowAllEvents] = useState(false);
	useEffect(() => panelRef.current?.focus({ preventScroll: true }), [panelRef]);
	const spaceDocuments = matterDetail.spaceDocuments ?? [];
	const defaultSpace = matterDetail.defaultSpace ?? null;

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
							className={`collab-tab-btn ${collabTab === "deliverables" ? "active" : ""}`}
							aria-pressed={collabTab === "deliverables"}
							onClick={() => onSelectTab("deliverables")}
						>
							资料空间
						</button>
					</div>
					<button type="button" className="btn-inline" onClick={onClose}>
						收起
					</button>
				</div>
				<div className="collab-log">
					{collabTab === "delegations" ? (
						delegationPanel
					) : collabTab === "deliverables" ? (
						<div className="collab-section">
							<h3>本事项空间资料{defaultSpace ? ` · ${defaultSpace.name}` : ""}</h3>
							{spaceDocuments.length === 0 ? (
								<p className="muted-hint">当前事项暂无空间资料。</p>
							) : (
								<ul className="matter-deliverables-list">
									{spaceDocuments.map((doc) => (
										<li key={doc.id} className="matter-deliverable">
											<div className="matter-deliverable-head">
												<div className="matter-deliverable-copy">
													<strong>{doc.title}</strong>
													<span className="matter-deliverable-meta">
														rev {doc.revision} · {doc.headCommit.slice(0, 7)}
														{doc.linkedFilePath ? ` · ${doc.linkedFilePath}` : ""} ·{" "}
														{memberName(doc.updatedBy)} · {formatClockTime(doc.updatedAt)}
													</span>
												</div>
												<button
													type="button"
													className="btn-pill-outline btn-xs"
													onClick={() => onOpenDeliverable(doc.id)}
												>
													查看资料
												</button>
											</div>
										</li>
									))}
								</ul>
							)}
							<button
								type="button"
								className="btn-secondary"
								style={{ marginTop: "10px" }}
								onClick={() => onOpenDeliverable(defaultSpace?.id)}
							>
								打开资料空间
							</button>
						</div>
					) : matterDetail.noticeMessages.length === 0 ? (
						<p className="muted-hint">当前事项暂无底层工具或过程事件。</p>
					) : (
						<div className="collab-section">
							<div className="collab-events-toolbar">
								<div className="flex flex-wrap items-center gap-1.5">
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
								<span className="text-xs text-ink-muted">按最新时间倒序</span>
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
