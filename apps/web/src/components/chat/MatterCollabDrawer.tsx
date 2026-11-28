import { type ReactNode, type RefObject, useEffect, useMemo, useState } from "react";
import type { MatterDetailPayload } from "../../api.ts";
import { Button, Tabs } from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";
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
		<div
			ref={panelRef}
			role="dialog"
			tabIndex={-1}
			aria-label="事项协作面板"
			className="absolute top-16 right-6 max-lg:right-4 max-lg:w-[calc(100%-32px)] w-[min(740px,calc(100%-48px))] max-h-[min(76vh,calc(100%-88px))] z-30 flex flex-col border border-line rounded-xl bg-stage shadow-lg p-3.5 outline-none"
		>
			<div className="w-full min-h-0 flex flex-col text-xs">
				<div className="flex items-center justify-between gap-3 shrink-0">
					<Tabs
						variant="pill"
						size="sm"
						ariaLabel="协作面板视图"
						value={collabTab}
						onChange={(id) => {
							if (id === "delegations" || id === "events" || id === "deliverables") {
								onSelectTab(id);
							}
						}}
						items={[
							{ id: "delegations", label: "团队委托" },
							{ id: "events", label: "事项事件", count: matterDetail.noticeMessages.length },
							{ id: "deliverables", label: "资料空间" },
						]}
					/>
					<Button variant="inline" size="xs" onClick={onClose}>
						收起
					</Button>
				</div>
				<div className="mt-2.5 flex-1 min-h-0 max-h-[62vh] overflow-y-auto overscroll-contain flex flex-col gap-2.5 text-ink-secondary">
					{collabTab === "delegations" ? (
						delegationPanel
					) : collabTab === "deliverables" ? (
						<div className="flex flex-col gap-2">
							<h3 className="m-0 text-sm font-semibold text-ink">
								本事项空间资料{defaultSpace ? ` · ${defaultSpace.name}` : ""}
							</h3>
							{spaceDocuments.length === 0 ? (
								<p className="m-0 text-xs text-ink-muted">当前事项暂无空间资料。</p>
							) : (
								<ul className="list-none m-0 p-0">
									{spaceDocuments.map((doc) => (
										<li key={doc.id} className="py-2.5 border-t border-line break-words">
											<div className="flex items-start justify-between gap-2.5">
												<div className="flex flex-col gap-1 min-w-0">
													<strong className="text-ink font-semibold">{doc.title}</strong>
													<span className="text-xs text-ink-muted">
														rev {doc.revision} · {doc.headCommit.slice(0, 7)}
														{doc.linkedFilePath ? ` · ${doc.linkedFilePath}` : ""} ·{" "}
														{memberName(doc.updatedBy)} · {formatClockTime(doc.updatedAt)}
													</span>
												</div>
												<Button variant="secondary" size="xs" onClick={() => onOpenDeliverable(doc.id)}>
													查看资料
												</Button>
											</div>
										</li>
									))}
								</ul>
							)}
							<div>
								<Button
									variant="secondary"
									size="sm"
									className="mt-1.5"
									onClick={() => onOpenDeliverable(defaultSpace?.id)}
								>
									打开资料空间
								</Button>
							</div>
						</div>
					) : matterDetail.noticeMessages.length === 0 ? (
						<p className="m-0 text-xs text-ink-muted">当前事项暂无底层工具或过程事件。</p>
					) : (
						<div className="flex flex-col gap-2">
							<div className="flex items-center justify-between gap-2 flex-wrap">
								<div className="flex flex-wrap items-center gap-1.5">
									<button
										type="button"
										className={cn(
											"border rounded-pill px-2.5 py-0.5 text-xs cursor-pointer transition-colors",
											!eventsKeyOnly
												? "border-accent bg-accent-soft text-accent font-semibold"
												: "border-line bg-stage text-ink-secondary hover:text-ink",
										)}
										onClick={() => setEventsKeyOnly(false)}
									>
										全部事件 ({matterDetail.noticeMessages.length})
									</button>
									<button
										type="button"
										className={cn(
											"border rounded-pill px-2.5 py-0.5 text-xs cursor-pointer transition-colors",
											eventsKeyOnly
												? "border-accent bg-accent-soft text-accent font-semibold"
												: "border-line bg-stage text-ink-secondary hover:text-ink",
										)}
										onClick={() => setEventsKeyOnly(true)}
									>
										仅看关键/异常事件
									</button>
								</div>
								<span className="text-xs text-ink-muted">按最新时间倒序</span>
							</div>
							{visibleNotices.length === 0 ? (
								<p className="m-0 text-xs text-ink-muted">当前过滤条件下暂无关键或异常事件。</p>
							) : (
								<div className="flex flex-col gap-1.5">
									{visibleNotices.map((entry) => {
										const line = formatNoticeEventLine(entry.content);
										const isError = /异常|失败/.test(line);
										return (
											<div
												key={entry.id}
												className={cn(
													"grid grid-cols-1 sm:grid-cols-[160px_minmax(0,1fr)] gap-1 sm:gap-2.5 px-2.5 py-1.5 rounded-md border text-xs",
													isError
														? "border-danger-border bg-danger-bg text-danger-text"
														: "border-line bg-sidebar text-ink-secondary",
												)}
											>
												<span className="flex items-center gap-1.5 min-w-0 text-ink-muted">
													<strong className="text-ink truncate">{memberName(entry.senderId)}</strong>
													<span className="shrink-0">{formatClockTime(entry.createdAt)}</span>
												</span>
												<span className="break-words">{line}</span>
											</div>
										);
									})}
									{!showAllEvents && filteredNotices.length > visibleNotices.length && (
										<div className="pt-1">
											<Button variant="secondary" size="xs" onClick={() => setShowAllEvents(true)}>
												展开更早事件（剩余 {filteredNotices.length - visibleNotices.length} 条）
											</Button>
										</div>
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
