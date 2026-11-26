import { SSE_SYNC_EVENT_NAMES, type SseEventPayloadMap } from "@pa/contracts/sse-events";
import { type MutableRefObject, useEffect } from "react";
import { fetchAuthSession, type MatterProgressDto, resolveApiUrl } from "../api.ts";

interface UseMatterEventSyncParams {
	authStatus: "checking" | "authenticated" | "unauthenticated";
	selectedMatterIdRef: MutableRefObject<string | null>;
	matterStreamRevision: MutableRefObject<{ total: number; byMatter: Map<string, number> }>;
	setProgressByMatter: React.Dispatch<React.SetStateAction<Record<string, MatterProgressDto>>>;
	setProgressStartedAt: React.Dispatch<React.SetStateAction<Record<string, number>>>;
	setStreamingDelta: React.Dispatch<React.SetStateAction<string>>;
	setSseConnected: React.Dispatch<React.SetStateAction<boolean>>;
	setPermissionRequired: React.Dispatch<React.SetStateAction<boolean>>;
	setErrorBanner: React.Dispatch<React.SetStateAction<string | null>>;
	refreshBootstrap: () => Promise<void>;
	refreshDetail: (matterId: string | null) => Promise<void>;
	applyRevokedSession: (message?: string) => void;
}

/** Subscribes to `/api/events` SSE notifications, tracks active turn start times, and handles auth revocation. */
export function useMatterEventSync({
	authStatus,
	selectedMatterIdRef,
	matterStreamRevision,
	setProgressByMatter,
	setProgressStartedAt,
	setStreamingDelta,
	setSseConnected,
	setPermissionRequired,
	setErrorBanner,
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
		const clearMatterProgress = (matterId: string) => {
			markStreamUpdate(matterId);
			if (selectedMatterIdRef.current === matterId) {
				setStreamingDelta("");
			}
			setProgressByMatter((prev) => {
				const next = { ...prev };
				delete next[matterId];
				return next;
			});
			setProgressStartedAt((prev) => {
				const next = { ...prev };
				delete next[matterId];
				return next;
			});
			void refreshBootstrap();
			if (selectedMatterIdRef.current === matterId) {
				void refreshDetail(matterId);
			}
		};

		const es = new EventSource(resolveApiUrl("/api/events"));
		let hasConnected = false;
		es.addEventListener("connected", () => {
			setSseConnected(true);
			if (hasConnected) handleSync();
			hasConnected = true;
		});
		es.addEventListener("text_delta", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as SseEventPayloadMap["text_delta"];
			if (data.matterId === selectedMatterIdRef.current) {
				markStreamUpdate(data.matterId);
				setStreamingDelta((prev) => prev + data.delta);
			}
		});
		es.addEventListener("matter_progress", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as MatterProgressDto;
			markStreamUpdate(data.matterId);
			setProgressByMatter((prev) => ({ ...prev, [data.matterId]: data }));
			setProgressStartedAt((prev) => (prev[data.matterId] ? prev : { ...prev, [data.matterId]: Date.now() }));
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
			clearMatterProgress(data.matterId);
		});
		es.addEventListener("matter_failed", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as SseEventPayloadMap["matter_failed"];
			if (data.error) {
				setErrorBanner(`执行未完成：${data.error}`);
			}
			clearMatterProgress(data.matterId);
		});
		es.addEventListener("matter_aborted", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as SseEventPayloadMap["matter_aborted"];
			clearMatterProgress(data.matterId);
		});

		const handleSync = () => {
			void refreshBootstrap();
			if (selectedMatterIdRef.current) {
				void refreshDetail(selectedMatterIdRef.current);
			}
		};
		for (const evtName of SSE_SYNC_EVENT_NAMES) {
			es.addEventListener(evtName, handleSync);
		}
		es.addEventListener("auth_revoked", () => {
			es.close();
			applyRevokedSession("当前账号会话已失效，请重新登录或联系管理员");
		});
		es.onerror = () => {
			setSseConnected(false);
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
		setProgressByMatter,
		setProgressStartedAt,
		setStreamingDelta,
		setSseConnected,
		setPermissionRequired,
		setErrorBanner,
		refreshBootstrap,
		refreshDetail,
		applyRevokedSession,
	]);
}
