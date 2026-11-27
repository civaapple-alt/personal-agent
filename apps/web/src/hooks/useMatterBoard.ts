import type { SseEventPayloadMap } from "@pa/contracts/sse-events";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type BoardMemberDto,
	type BoardMemberStatus,
	type BoardPostDto,
	type BoardPostKind,
	type BoardPostSummaryDto,
	type BoardRole,
	type CreateBoardPostInput,
	createBoardPost,
	fetchBoardPost,
	fetchMatterBoard,
	fetchMatterEvents,
	type MatterBoardSnapshotDto,
	type MatterCollaborationMode,
	type MatterEventDto,
	type MatterEventType,
	type UpdateBoardMemberControlInput,
	updateBoardMemberControl,
} from "../api.ts";
import { subscribeBoardSseEvents } from "./useMatterEventSync.ts";

export interface BoardMemberGroup {
	status: BoardMemberStatus;
	label: string;
	members: BoardMemberDto[];
}

export interface BoardStatusSummary {
	working: number;
	waiting: number;
	blockedHuman: number;
	stopped: number;
	retired: number;
	total: number;
	label: string;
	tone: "working" | "blocked" | "idle";
}

const STATUS_GROUP_ORDER: ReadonlyArray<{ status: BoardMemberStatus; label: string }> = [
	{ status: "working", label: "执行中" },
	{ status: "blocked_human", label: "待人工确认" },
	{ status: "waiting", label: "待命" },
	{ status: "stopped", label: "已暂停" },
	{ status: "retired", label: "已退场" },
];

/** Summarizes live board member counts into a compact status pill label and semantic tone. */
export function summarizeBoardStatus(members: readonly BoardMemberDto[], postCount: number): BoardStatusSummary {
	let working = 0;
	let waiting = 0;
	let blockedHuman = 0;
	let stopped = 0;
	let retired = 0;
	for (const member of members) {
		if (member.status === "working") working += 1;
		else if (member.status === "waiting") waiting += 1;
		else if (member.status === "blocked_human") blockedHuman += 1;
		else if (member.status === "stopped") stopped += 1;
		else if (member.status === "retired") retired += 1;
	}
	const total = members.length;
	if (blockedHuman > 0) {
		return {
			working,
			waiting,
			blockedHuman,
			stopped,
			retired,
			total,
			label: `Board · 待人工确认 (${blockedHuman})`,
			tone: "blocked",
		};
	}
	if (working > 0) {
		return {
			working,
			waiting,
			blockedHuman,
			stopped,
			retired,
			total,
			label: `Board · ${working} 执行中 / ${waiting} 待命`,
			tone: "working",
		};
	}
	if (total > 0) {
		const parts = [`${waiting} 待命`];
		if (stopped > 0) parts.push(`${stopped} 已暂停`);
		if (retired > 0) parts.push(`${retired} 已退场`);
		return {
			working,
			waiting,
			blockedHuman,
			stopped,
			retired,
			total,
			label: `Board · ${parts.join(" / ")}`,
			tone: "idle",
		};
	}
	return {
		working,
		waiting,
		blockedHuman,
		stopped,
		retired,
		total,
		label: postCount > 0 ? `Board · ${postCount} 条板帖` : "Board · 待组队",
		tone: "idle",
	};
}

/** Pins the coordinator at the top and groups non-coordinator board members by live status. */
export function groupBoardMembers(members: readonly BoardMemberDto[]): {
	coordinator: BoardMemberDto | null;
	groups: BoardMemberGroup[];
} {
	const coordinator = members.find((member) => member.boardRole === "coordinator") ?? null;
	const others = members.filter((member) => member !== coordinator);
	const byStatus = new Map<BoardMemberStatus, BoardMemberDto[]>();
	for (const member of others) {
		const bucket = byStatus.get(member.status);
		if (bucket) bucket.push(member);
		else byStatus.set(member.status, [member]);
	}
	const groups: BoardMemberGroup[] = [];
	for (const { status, label } of STATUS_GROUP_ORDER) {
		const list = byStatus.get(status);
		if (list && list.length > 0) {
			groups.push({ status, label, members: list });
		}
	}
	return { coordinator, groups };
}

/** Filters board post summaries by semantic kind and free-text query across postNo, author, mentions, and summary. */
export function filterBoardPosts(
	posts: readonly BoardPostSummaryDto[],
	options: { query: string; kind: BoardPostKind | "all" },
): BoardPostSummaryDto[] {
	const normalizedQuery = options.query.trim().toLowerCase();
	return posts.filter((post) => {
		if (options.kind !== "all" && post.kind !== options.kind) return false;
		if (!normalizedQuery) return true;
		const haystack = [
			`#${post.postNo}`,
			String(post.postNo),
			post.kind,
			post.authorId,
			post.mentions.map((m) => `@${m}`).join(" "),
			post.summary,
			post.verification?.target ?? "",
			post.verification?.verdict ?? "",
		]
			.join(" ")
			.toLowerCase();
		return haystack.includes(normalizedQuery);
	});
}

/** Returns true only when a board member is in `waiting` state and eligible for in-place model hot-swap. */
export function canSwapBoardMemberModel(member: Pick<BoardMemberDto, "status">): boolean {
	return member.status === "waiting";
}

/** Incrementally patches a board snapshot with a `board_post_created` SSE event. */
export function applyBoardPostCreatedEvent(
	snapshot: MatterBoardSnapshotDto | null,
	event: SseEventPayloadMap["board_post_created"],
): MatterBoardSnapshotDto | null {
	if (!snapshot || snapshot.matterId !== event.matterId) return snapshot;
	if (snapshot.posts.some((post) => post.postNo === event.postNo)) {
		return snapshot.latestPostNo >= event.postNo ? snapshot : { ...snapshot, latestPostNo: event.postNo };
	}
	const nextSummary: BoardPostSummaryDto = {
		id: `sse-post-${event.matterId}-${event.postNo}`,
		matterId: event.matterId,
		postNo: event.postNo,
		authorType: event.authorType ?? (event.authorId === "monitor" ? "monitor" : "agent"),
		authorId: event.authorId,
		kind: event.kind,
		mentions: event.mentions,
		refPostNos: [],
		summary: event.summary,
		hasBody: event.hasBody ?? false,
		artifacts: null,
		verification: null,
		orgId: null,
		workspaceId: null,
		createdAt: event.createdAt,
	};
	const posts = [...snapshot.posts, nextSummary].sort((a, b) => a.postNo - b.postNo);
	return {
		...snapshot,
		posts,
		latestPostNo: Math.max(snapshot.latestPostNo, event.postNo),
	};
}

/** Incrementally patches a board snapshot with a `board_member_updated` SSE event; signals refresh if member is new. */
export function applyBoardMemberUpdatedEvent(
	snapshot: MatterBoardSnapshotDto | null,
	event: SseEventPayloadMap["board_member_updated"],
): { snapshot: MatterBoardSnapshotDto | null; needsRefresh: boolean } {
	if (!snapshot || snapshot.matterId !== event.matterId) {
		return { snapshot, needsRefresh: false };
	}
	const idx = snapshot.members.findIndex((member) => member.agentId === event.agentId);
	if (idx === -1) {
		return { snapshot, needsRefresh: true };
	}
	const existing = snapshot.members[idx]!;
	const updated: BoardMemberDto = {
		...existing,
		status: event.status,
		activePostNo: event.activePostNo,
		metrics: event.metrics ?? existing.metrics,
		updatedAt: event.updatedAt,
	};
	const members = snapshot.members.slice();
	members[idx] = updated;
	return {
		snapshot: { ...snapshot, members },
		needsRefresh: false,
	};
}

/** Formats a `matter_events` payload into a concise one-line description for the Events tab. */
export function formatBoardEventPayload(event: MatterEventDto): string {
	const payload = event.payload ?? {};
	const str = (key: string): string => {
		const value = payload[key];
		return typeof value === "string" ? value.trim() : "";
	};
	const num = (key: string): number | null => {
		const value = payload[key];
		return typeof value === "number" && Number.isFinite(value) ? value : null;
	};
	if (event.eventType === "monitor_alert") {
		const target = str("targetAgentId") || str("agentId");
		const reason = str("reason") || str("message") || str("summary") || "检测到协作停滞";
		const nudgeCount = num("nudgeCount");
		const prefix = target ? `@${target} · ` : "";
		const suffix = nudgeCount !== null ? `（第 ${nudgeCount} 次提醒）` : "";
		return `${prefix}${reason}${suffix}`;
	}
	if (event.eventType === "tool_start" || event.eventType === "tool_end") {
		const toolName = str("toolName") || str("tool") || str("name");
		const detail = str("detail") || str("summary") || str("command") || str("path") || str("error");
		const status = str("status");
		return [toolName, detail, status ? `[${status}]` : ""].filter(Boolean).join(" · ") || event.eventType;
	}
	if (event.eventType === "turn_summary") {
		return str("summary") || str("message") || str("stage") || "执行轮次完成";
	}
	return str("summary") || str("message") || JSON.stringify(payload).slice(0, 160);
}

/** Filters visible board members while always preserving the persistent Coordinator. */
export function filterVisibleBoardMembers(
	members: readonly BoardMemberDto[],
	options: { hideInactive: boolean },
): BoardMemberDto[] {
	if (!options.hideInactive) return [...members];
	return members.filter(
		(member) => member.boardRole === "coordinator" || (member.status !== "retired" && member.status !== "stopped"),
	);
}

/** Builds active `@mention` composer chips (excluding retired round-1 agents). */
export function buildActiveMentionCandidates(members: readonly BoardMemberDto[]): string[] {
	const ids: string[] = [];
	for (const member of members) {
		if (member.status === "retired" && member.boardRole !== "coordinator") continue;
		if (!ids.includes(member.agentId)) ids.push(member.agentId);
	}
	if (!ids.includes("coordinator")) ids.unshift("coordinator");
	if (!ids.includes("all")) ids.push("all");
	return ids;
}

export interface BoardMentionGraphNode {
	agentId: string;
	displayName: string;
	role: BoardRole | "monitor" | "user";
	status: BoardMemberStatus | "active";
	x: number;
	y: number;
	postCount: number;
}

export interface BoardMentionGraphEdge {
	from: string;
	to: string;
	count: number;
	tone: "normal" | "rework" | "pass" | "escalate";
	latestPostNo: number;
}

export interface BoardMentionGraph {
	width: number;
	height: number;
	nodes: BoardMentionGraphNode[];
	edges: BoardMentionGraphEdge[];
}

function layoutGraphRow(count: number, width: number, y: number, idx: number): { x: number; y: number } {
	if (count <= 1) return { x: Math.round(width / 2), y };
	const pad = 76;
	const usable = Math.max(120, width - pad * 2);
	const step = usable / (count - 1);
	return { x: Math.round(pad + idx * step), y };
}

/** Builds a clean `@mention` topology projection from board members and posts. */
export function buildBoardMentionGraph(
	members: readonly BoardMemberDto[],
	posts: readonly BoardPostSummaryDto[],
	options: { hideInactive?: boolean } = {},
): BoardMentionGraph {
	const hideInactive = Boolean(options.hideInactive);
	const visibleMembers = filterVisibleBoardMembers(members, { hideInactive });

	const postCounts = new Map<string, number>();
	let hasMonitorPost = false;
	let hasUserInteraction = false;
	for (const post of posts) {
		postCounts.set(post.authorId, (postCounts.get(post.authorId) ?? 0) + 1);
		if (post.authorType === "monitor" || post.authorId === "monitor") hasMonitorPost = true;
		if (post.authorType === "user" || post.mentions.includes("user")) hasUserInteraction = true;
	}

	const coordMembers = visibleMembers.filter((m) => m.boardRole === "coordinator");
	const builderMembers = visibleMembers.filter((m) => m.boardRole === "builder" && m.status !== "retired");
	const verifierAndInactiveMembers = visibleMembers.filter(
		(m) => m.boardRole === "verifier" || (m.boardRole === "builder" && m.status === "retired"),
	);

	const rawRow2: Array<{
		agentId: string;
		displayName: string;
		role: BoardMentionGraphNode["role"];
		status: BoardMentionGraphNode["status"];
	}> = builderMembers.map((m) => ({
		agentId: m.agentId,
		displayName: m.displayName,
		role: m.boardRole,
		status: m.status,
	}));
	const rawRow3: Array<{
		agentId: string;
		displayName: string;
		role: BoardMentionGraphNode["role"];
		status: BoardMentionGraphNode["status"];
	}> = verifierAndInactiveMembers.map((m) => ({
		agentId: m.agentId,
		displayName: m.displayName,
		role: m.boardRole,
		status: m.status,
	}));
	if (hasMonitorPost) {
		rawRow3.push({ agentId: "monitor", displayName: "@monitor", role: "monitor", status: "active" });
	}
	if (hasUserInteraction && !hideInactive) {
		rawRow3.push({ agentId: "user", displayName: "用户", role: "user", status: "active" });
	}

	const maxCols = Math.max(1, coordMembers.length, rawRow2.length, rawRow3.length);
	const width = Math.max(440, maxCols * 140);
	const nodes: BoardMentionGraphNode[] = [];

	const row1Nodes =
		coordMembers.length > 0
			? coordMembers
			: [
					{
						agentId: "coordinator",
						displayName: "Coordinator",
						boardRole: "coordinator" as const,
						status: "waiting" as const,
					},
				];
	row1Nodes.forEach((m, idx) => {
		const pos = layoutGraphRow(row1Nodes.length, width, 46, idx);
		nodes.push({
			agentId: m.agentId,
			displayName: m.displayName,
			role: "coordinator",
			status: m.status,
			x: pos.x,
			y: pos.y,
			postCount: postCounts.get(m.agentId) ?? 0,
		});
	});

	rawRow2.forEach((m, idx) => {
		const pos = layoutGraphRow(rawRow2.length, width, 148, idx);
		nodes.push({
			...m,
			x: pos.x,
			y: pos.y,
			postCount: postCounts.get(m.agentId) ?? 0,
		});
	});

	const row3Y = rawRow2.length > 0 ? 250 : 148;
	rawRow3.forEach((m, idx) => {
		const pos = layoutGraphRow(rawRow3.length, width, row3Y, idx);
		nodes.push({
			...m,
			x: pos.x,
			y: pos.y,
			postCount: postCounts.get(m.agentId) ?? 0,
		});
	});

	const visibleIds = new Set(nodes.map((n) => n.agentId));
	const edgeMap = new Map<string, BoardMentionGraphEdge>();
	for (const post of posts) {
		const from = post.authorType === "monitor" ? "monitor" : post.authorType === "user" ? "user" : post.authorId;
		if (!visibleIds.has(from)) continue;
		const targets = post.mentions.includes("all")
			? [...visibleIds].filter((id) => id !== from && id !== "monitor" && id !== "user")
			: post.mentions;
		for (const rawTarget of targets) {
			const to = rawTarget.replace(/^@+/, "");
			if (!visibleIds.has(to) || to === from) continue;
			const key = `${from}->${to}`;
			const existing = edgeMap.get(key);
			const nextTone: BoardMentionGraphEdge["tone"] =
				post.kind === "escalate" || post.authorType === "monitor"
					? "escalate"
					: post.kind === "verify_rework"
						? "rework"
						: post.kind === "verify_pass"
							? "pass"
							: "normal";
			if (!existing) {
				edgeMap.set(key, { from, to, count: 1, tone: nextTone, latestPostNo: post.postNo });
			} else {
				existing.count += 1;
				existing.latestPostNo = Math.max(existing.latestPostNo, post.postNo);
				if (
					nextTone === "escalate" ||
					nextTone === "rework" ||
					(nextTone === "pass" && existing.tone === "normal")
				) {
					existing.tone = nextTone;
				}
			}
		}
	}

	const height = rawRow3.length > 0 ? row3Y + 54 : rawRow2.length > 0 ? 204 : 104;
	return {
		width,
		height,
		nodes,
		edges: [...edgeMap.values()],
	};
}

interface UseMatterBoardParams {
	matterId: string | null;
	collaborationMode: MatterCollaborationMode | undefined;
	paneOpen: boolean;
	eventsTabActive: boolean;
	eventFilterAgentId: string;
	eventFilterType: MatterEventType | "all";
}

/** Manages lazy-loaded board snapshot, on-demand post bodies, cursor-paginated events, and SSE incremental sync. */
export function useMatterBoard({
	matterId,
	collaborationMode,
	paneOpen,
	eventsTabActive,
	eventFilterAgentId,
	eventFilterType,
}: UseMatterBoardParams) {
	const [snapshot, setSnapshot] = useState<MatterBoardSnapshotDto | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [postBodiesByNo, setPostBodiesByNo] = useState<Record<number, BoardPostDto>>({});
	const [loadingPostNos, setLoadingPostNos] = useState<Record<number, boolean>>({});
	const [postBodyErrors, setPostBodyErrors] = useState<Record<number, string>>({});

	const [events, setEvents] = useState<MatterEventDto[]>([]);
	const [eventsCursor, setEventsCursor] = useState<string | null>(null);
	const [eventsHasMore, setEventsHasMore] = useState(false);
	const [eventsLoading, setEventsLoading] = useState(false);
	const [eventsError, setEventsError] = useState<string | null>(null);

	const matterIdRef = useRef<string | null>(matterId);
	matterIdRef.current = matterId;
	const eventsTabActiveRef = useRef(eventsTabActive);
	eventsTabActiveRef.current = eventsTabActive;
	const eventFilterRef = useRef({ agentId: eventFilterAgentId, eventType: eventFilterType });
	eventFilterRef.current = { agentId: eventFilterAgentId, eventType: eventFilterType };

	const shouldLoadBoard = Boolean(matterId && (collaborationMode === "board" || paneOpen));

	const refreshBoard = useCallback(async () => {
		const targetId = matterIdRef.current;
		if (!targetId) return;
		setLoading(true);
		setError(null);
		try {
			const data = await fetchMatterBoard(targetId, { order: "asc" });
			if (matterIdRef.current !== targetId) return;
			setSnapshot(data);
		} catch (err: unknown) {
			if (matterIdRef.current !== targetId) return;
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (matterIdRef.current === targetId) setLoading(false);
		}
	}, []);

	// Reset state whenever the active matter changes.
	useEffect(() => {
		setSnapshot(null);
		setError(null);
		setPostBodiesByNo({});
		setLoadingPostNos({});
		setPostBodyErrors({});
		setEvents([]);
		setEventsCursor(null);
		setEventsHasMore(false);
		setEventsError(null);
	}, [matterId]);

	// Fetch board snapshot when matter is in board mode or user opens the board pane.
	useEffect(() => {
		if (!shouldLoadBoard) return;
		void refreshBoard();
	}, [shouldLoadBoard, matterId, refreshBoard]);

	const loadEventsPage = useCallback(async (mode: "reset" | "more", cursorOverride?: string | null) => {
		const targetId = matterIdRef.current;
		if (!targetId) return;
		setEventsLoading(true);
		setEventsError(null);
		try {
			const { agentId, eventType } = eventFilterRef.current;
			const page = await fetchMatterEvents(targetId, {
				limit: 30,
				order: "desc",
				...(mode === "more" && cursorOverride ? { cursor: cursorOverride } : {}),
				...(agentId ? { agentId } : {}),
				...(eventType !== "all" ? { eventType } : {}),
			});
			if (matterIdRef.current !== targetId) return;
			setEvents((prev) => (mode === "reset" ? page.events : [...prev, ...page.events]));
			setEventsCursor(page.nextCursor);
			setEventsHasMore(page.hasMore);
		} catch (err: unknown) {
			if (matterIdRef.current !== targetId) return;
			setEventsError(err instanceof Error ? err.message : String(err));
		} finally {
			if (matterIdRef.current === targetId) setEventsLoading(false);
		}
	}, []);

	// Lazy-load events only when the Events tab is open, or filters change while open.
	useEffect(() => {
		if (!matterId || !paneOpen || !eventsTabActive) return;
		void loadEventsPage("reset");
	}, [matterId, paneOpen, eventsTabActive, eventFilterAgentId, eventFilterType, loadEventsPage]);

	const loadMoreEvents = useCallback(async () => {
		if (!eventsHasMore || !eventsCursor || eventsLoading) return;
		await loadEventsPage("more", eventsCursor);
	}, [eventsCursor, eventsHasMore, eventsLoading, loadEventsPage]);

	// Subscribe to board SSE events via the shared EventSource in useMatterEventSync.
	useEffect(() => {
		if (!shouldLoadBoard || !matterId) return;
		return subscribeBoardSseEvents({
			onBoardPostCreated: (data) => {
				if (data.matterId !== matterIdRef.current) return;
				setSnapshot((prev) => applyBoardPostCreatedEvent(prev, data));
			},
			onBoardMemberUpdated: (data) => {
				if (data.matterId !== matterIdRef.current) return;
				let needsRefresh = false;
				setSnapshot((prev) => {
					const result = applyBoardMemberUpdatedEvent(prev, data);
					needsRefresh = result.needsRefresh;
					return result.snapshot;
				});
				if (needsRefresh) {
					void refreshBoard();
				}
			},
			onMatterEventAppended: (data) => {
				if (data.matterId !== matterIdRef.current) return;
				if (eventsTabActiveRef.current) {
					void loadEventsPage("reset");
				}
			},
		});
	}, [shouldLoadBoard, matterId, refreshBoard, loadEventsPage]);

	const loadPostBody = useCallback(
		async (postNo: number): Promise<BoardPostDto | null> => {
			const targetId = matterIdRef.current;
			if (!targetId) return null;
			if (postBodiesByNo[postNo]) return postBodiesByNo[postNo]!;
			setLoadingPostNos((prev) => ({ ...prev, [postNo]: true }));
			setPostBodyErrors((prev) => {
				if (!prev[postNo]) return prev;
				const next = { ...prev };
				delete next[postNo];
				return next;
			});
			try {
				const { post } = await fetchBoardPost(targetId, postNo);
				if (matterIdRef.current !== targetId) return null;
				setPostBodiesByNo((prev) => ({ ...prev, [postNo]: post }));
				return post;
			} catch (err: unknown) {
				if (matterIdRef.current === targetId) {
					setPostBodyErrors((prev) => ({
						...prev,
						[postNo]: err instanceof Error ? err.message : String(err),
					}));
				}
				return null;
			} finally {
				if (matterIdRef.current === targetId) {
					setLoadingPostNos((prev) => {
						const next = { ...prev };
						delete next[postNo];
						return next;
					});
				}
			}
		},
		[postBodiesByNo],
	);

	const submitPost = useCallback(async (input: CreateBoardPostInput & { autoResume?: boolean }) => {
		const targetId = matterIdRef.current;
		if (!targetId) throw new Error("未选择事项");
		const { post } = await createBoardPost(targetId, input);
		if (matterIdRef.current === targetId) {
			setPostBodiesByNo((prev) => ({ ...prev, [post.postNo]: post }));
			setSnapshot((prev) => {
				if (!prev || prev.matterId !== targetId) return prev;
				if (prev.posts.some((item) => item.postNo === post.postNo)) return prev;
				const { body, ...summary } = post;
				return {
					...prev,
					posts: [...prev.posts, { ...summary, hasBody: Boolean(body.trim()) }].sort(
						(a, b) => a.postNo - b.postNo,
					),
					latestPostNo: Math.max(prev.latestPostNo, post.postNo),
				};
			});
		}
		return post;
	}, []);

	const controlMember = useCallback(async (agentId: string, input: UpdateBoardMemberControlInput) => {
		const targetId = matterIdRef.current;
		if (!targetId) throw new Error("未选择事项");
		const { member } = await updateBoardMemberControl(targetId, agentId, input);
		if (matterIdRef.current === targetId) {
			setSnapshot((prev) => {
				if (!prev || prev.matterId !== targetId) return prev;
				const idx = prev.members.findIndex((item) => item.agentId === member.agentId);
				if (idx === -1) return { ...prev, members: [...prev.members, member] };
				const members = prev.members.slice();
				members[idx] = member;
				return { ...prev, members };
			});
		}
		return member;
	}, []);

	return {
		snapshot,
		loading,
		error,
		refreshBoard,
		postBodiesByNo,
		loadingPostNos,
		postBodyErrors,
		loadPostBody,
		submitPost,
		controlMember,
		events,
		eventsHasMore,
		eventsLoading,
		eventsError,
		refreshEvents: () => void loadEventsPage("reset"),
		loadMoreEvents,
	};
}
