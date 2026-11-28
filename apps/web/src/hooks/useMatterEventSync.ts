import { SSE_SYNC_EVENT_NAMES, type SseEventPayloadMap } from "@pa/contracts/sse-events";
import { type MutableRefObject, useEffect } from "react";
import { fetchAuthSession, type MatterProgressDto, resolveApiUrl } from "../api.ts";
import { queryKeys, workbenchQueryClient } from "../queries/index.ts";
import { useMatterRuntimeStore, useWorkbenchStore } from "../stores/index.ts";

export interface BoardSseSubscriber {
	onBoardPostCreated?: (event: SseEventPayloadMap["board_post_created"]) => void;
	onBoardMemberUpdated?: (event: SseEventPayloadMap["board_member_updated"]) => void;
	onMatterEventAppended?: (event: SseEventPayloadMap["matter_event_appended"]) => void;
}

const boardSseSubscribers = new Set<BoardSseSubscriber>();

/** Subscribes a caller to Board SSE events delivered over the main `/api/events` stream. */
export function subscribeBoardSseEvents(subscriber: BoardSseSubscriber): () => void {
	boardSseSubscribers.add(subscriber);
	return () => {
		boardSseSubscribers.delete(subscriber);
	};
}

interface UseMatterEventSyncParams {
	authStatus: "checking" | "authenticated" | "unauthenticated";
	selectedMatterIdRef: MutableRefObject<string | null>;
	matterStreamRevision: MutableRefObject<{ total: number; byMatter: Map<string, number> }>;
	setPermissionRequired: React.Dispatch<React.SetStateAction<boolean>>;
	refreshBootstrap: () => Promise<void>;
	refreshDetail: (matterId: string | null) => Promise<void>;
	applyRevokedSession: (message?: string) => void;
}

/** Subscribes to `/api/events` SSE notifications, tracks active turn start times in Zustand, and handles auth revocation. */
export function useMatterEventSync({
	authStatus,
	selectedMatterIdRef,
	matterStreamRevision,
	setPermissionRequired,
	refreshBootstrap,
	refreshDetail,
	applyRevokedSession,
}: UseMatterEventSyncParams) {
	useEffect(() => {
		if (authStatus !== "authenticated") return;
		const markStreamUpdate = (matterId: string) => {
			const revision = matterStreamRevision.current;
			revision.byMatter.set(matterId, ++revision.total);
		};
		const clearProgressAndRefresh = (matterId: string) => {
			markStreamUpdate(matterId);
			const runtime = useMatterRuntimeStore.getState();
			if (selectedMatterIdRef.current === matterId) {
				runtime.setStreamingDelta("");
			}
			runtime.clearMatterProgress(matterId);
			void refreshBootstrap();
			if (selectedMatterIdRef.current === matterId) {
				void refreshDetail(matterId);
			}
		};

		const es = new EventSource(resolveApiUrl("/api/events"));
		let hasConnected = false;
		es.addEventListener("connected", () => {
			useMatterRuntimeStore.getState().setSseConnected(true);
			if (hasConnected) {
				handleSync();
				void workbenchQueryClient.invalidateQueries();
			}
			hasConnected = true;
		});
		es.addEventListener("text_delta", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as SseEventPayloadMap["text_delta"];
			if (data.matterId === selectedMatterIdRef.current) {
				markStreamUpdate(data.matterId);
				useMatterRuntimeStore.getState().appendStreamingDelta(data.delta);
			}
		});
		es.addEventListener("matter_progress", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as MatterProgressDto;
			markStreamUpdate(data.matterId);
			useMatterRuntimeStore.getState().upsertMatterProgress(data.matterId, data);
			if (data.stage === "starting" || data.collabUpdated) {
				if (data.stage === "starting") {
					void refreshBootstrap();
				}
				if (data.matterId === selectedMatterIdRef.current) {
					void refreshDetail(data.matterId);
				}
			}
		});
		es.addEventListener("matter_settled", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as SseEventPayloadMap["matter_settled"];
			clearProgressAndRefresh(data.matterId);
			void workbenchQueryClient.invalidateQueries({ queryKey: queryKeys.spaces.all });
		});
		es.addEventListener("matter_failed", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as SseEventPayloadMap["matter_failed"];
			if (data.error) {
				useWorkbenchStore.getState().setErrorBanner(`执行未完成：${data.error}`);
			}
			clearProgressAndRefresh(data.matterId);
		});
		es.addEventListener("matter_aborted", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as SseEventPayloadMap["matter_aborted"];
			clearProgressAndRefresh(data.matterId);
		});

		const handleSync = () => {
			void refreshBootstrap();
			if (selectedMatterIdRef.current) {
				void refreshDetail(selectedMatterIdRef.current);
			}
		};
		const invalidateDomainQueries = (evtName: string) => {
			if (evtName === "space_updated" || evtName === "space_page_updated") {
				void workbenchQueryClient.invalidateQueries({ queryKey: queryKeys.spaces.all });
				return;
			}
			if (evtName === "workspace_updated") {
				void workbenchQueryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
				return;
			}
			if (evtName === "team_updated") {
				void workbenchQueryClient.invalidateQueries({ queryKey: queryKeys.team.all });
				return;
			}
			if (evtName === "organization_updated") {
				void workbenchQueryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
			}
		};
		for (const evtName of SSE_SYNC_EVENT_NAMES) {
			es.addEventListener(evtName, () => {
				handleSync();
				invalidateDomainQueries(evtName);
			});
		}
		es.addEventListener("board_post_created", (ev) => {
			try {
				const data = JSON.parse((ev as MessageEvent).data) as SseEventPayloadMap["board_post_created"];
				for (const sub of boardSseSubscribers) sub.onBoardPostCreated?.(data);
			} catch {
				// Ignore malformed event payloads.
			}
		});
		es.addEventListener("board_member_updated", (ev) => {
			try {
				const data = JSON.parse((ev as MessageEvent).data) as SseEventPayloadMap["board_member_updated"];
				for (const sub of boardSseSubscribers) sub.onBoardMemberUpdated?.(data);
			} catch {
				// Ignore malformed event payloads.
			}
		});
		es.addEventListener("matter_event_appended", (ev) => {
			try {
				const data = JSON.parse((ev as MessageEvent).data) as SseEventPayloadMap["matter_event_appended"];
				for (const sub of boardSseSubscribers) sub.onMatterEventAppended?.(data);
			} catch {
				// Ignore malformed event payloads.
			}
		});
		es.addEventListener("auth_revoked", () => {
			es.close();
			applyRevokedSession("当前账号会话已失效，请重新登录或联系管理员");
		});
		es.onerror = () => {
			useMatterRuntimeStore.getState().setSseConnected(false);
			if (es.readyState === EventSource.CLOSED) {
				void fetchAuthSession()
					.then((session) => {
						setPermissionRequired(session.permissionRequired);
						if (!session.authenticated) {
							applyRevokedSession("当前访问凭证已失效，请使用新的邀请链接或口令重新进入");
						}
					})
					.catch(() => {});
			}
		};
		return () => es.close();
	}, [
		authStatus,
		selectedMatterIdRef,
		matterStreamRevision,
		setPermissionRequired,
		refreshBootstrap,
		refreshDetail,
		applyRevokedSession,
	]);
}
