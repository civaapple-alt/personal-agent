import { type MutableRefObject, useEffect, useState } from "react";
import { fetchAuthSession, type MatterProgressDto } from "../api.ts";
import { formatHashRoute, type NavTab } from "../hashRouter.ts";

interface UseMatterEventSyncParams {
	authStatus: "checking" | "authenticated" | "unauthenticated";
	activeTabRef: MutableRefObject<NavTab>;
	selectedMatterIdRef: MutableRefObject<string | null>;
	progressByMatter: Record<string, MatterProgressDto>;
	setProgressByMatter: React.Dispatch<React.SetStateAction<Record<string, MatterProgressDto>>>;
	setProgressStartedAt: React.Dispatch<React.SetStateAction<Record<string, number>>>;
	setStreamingDelta: React.Dispatch<React.SetStateAction<string>>;
	setSseConnected: React.Dispatch<React.SetStateAction<boolean>>;
	setSelectedDeliverableId: React.Dispatch<React.SetStateAction<string | null>>;
	setPermissionRequired: React.Dispatch<React.SetStateAction<boolean>>;
	setNoticeBanner: React.Dispatch<React.SetStateAction<string | null>>;
	setErrorBanner: React.Dispatch<React.SetStateAction<string | null>>;
	refreshBootstrap: () => Promise<void>;
	refreshDetail: (matterId: string | null) => Promise<void>;
	applyRevokedSession: (message?: string) => void;
}

/** Subscribes to `/api/events` SSE notifications, tracks active turn elapsed timers, and handles auth revocation. */
export function useMatterEventSync({
	authStatus,
	activeTabRef,
	selectedMatterIdRef,
	progressByMatter,
	setProgressByMatter,
	setProgressStartedAt,
	setStreamingDelta,
	setSseConnected,
	setSelectedDeliverableId,
	setPermissionRequired,
	setNoticeBanner,
	setErrorBanner,
	refreshBootstrap,
	refreshDetail,
	applyRevokedSession,
}: UseMatterEventSyncParams) {
	const [nowMs, setNowMs] = useState(() => Date.now());
	const activeProgressCount = Object.keys(progressByMatter).length;

	useEffect(() => {
		if (activeProgressCount === 0) return;
		const timer = setInterval(() => setNowMs(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [activeProgressCount]);

	useEffect(() => {
		if (authStatus !== "authenticated") return;
		const clearMatterProgress = (matterId: string) => {
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

		const es = new EventSource("/api/events");
		es.addEventListener("connected", () => setSseConnected(true));
		es.addEventListener("text_delta", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as { matterId: string; delta: string };
			if (data.matterId === selectedMatterIdRef.current) {
				setStreamingDelta((prev) => prev + data.delta);
			}
		});
		es.addEventListener("matter_progress", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as MatterProgressDto;
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
			const data = JSON.parse((ev as MessageEvent).data) as {
				matterId: string;
				deliverable?: { id?: string; title?: string } | null;
			};
			if (data.deliverable?.id) {
				setSelectedDeliverableId(data.deliverable.id);
				if (activeTabRef.current === "deliverables") {
					window.history.replaceState(
						null,
						"",
						formatHashRoute({ tab: "deliverables", deliverableId: data.deliverable.id }),
					);
				}
				const watchingThisChat = activeTabRef.current === "chats" && selectedMatterIdRef.current === data.matterId;
				if (!watchingThisChat) {
					const shortTitle = (data.deliverable.title ?? "新成果").slice(0, 28);
					setNoticeBanner(`✓ 已完成交付：「${shortTitle}」`);
				}
			}
			clearMatterProgress(data.matterId);
		});
		es.addEventListener("matter_failed", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as { matterId: string; error?: string };
			if (data.error) {
				setErrorBanner(`执行未完成：${data.error}`);
			}
			clearMatterProgress(data.matterId);
		});
		es.addEventListener("matter_aborted", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as { matterId: string };
			clearMatterProgress(data.matterId);
		});

		const handleSync = () => {
			void refreshBootstrap();
			if (selectedMatterIdRef.current) {
				void refreshDetail(selectedMatterIdRef.current);
			}
		};
		for (const evtName of [
			"matter_started",
			"matter_message",
			"matter_updated",
			"collaborator_updated",
			"dialog_requested",
			"dialog_resolved",
			"deliverable_updated",
			"workspace_updated",
			"organization_updated",
			"preview_updated",
			"team_updated",
			"memory_updated",
		]) {
			es.addEventListener(evtName, handleSync);
		}
		es.addEventListener("auth_revoked", () => {
			es.close();
			applyRevokedSession("当前邀请口令已被重置或已移出协同团队，请向所有者获取新的邀请链接");
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
		activeTabRef,
		selectedMatterIdRef,
		setProgressByMatter,
		setProgressStartedAt,
		setStreamingDelta,
		setSseConnected,
		setSelectedDeliverableId,
		setPermissionRequired,
		setNoticeBanner,
		setErrorBanner,
		refreshBootstrap,
		refreshDetail,
		applyRevokedSession,
	]);

	return nowMs;
}
