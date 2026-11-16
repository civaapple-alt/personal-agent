import type { MutableRefObject } from "react";
import {
	type ApplyMatterRoleProposalsPayload,
	abortMatter,
	applyMatterRoleProposals,
	approveAiRequest,
	type BootstrapPayload,
	type ComposerImageAttachment,
	createMatter,
	dismissAiRequest,
	type FeedbackRating,
	type MatterSendMode,
	postMatterMessage,
	submitDeliverableFeedback,
	type TeamMemberDto,
	updateMatterAiMembers,
	updateMatterCollaborators,
	updateMatterLead,
	updateMatterObservers,
	updateMatterObserversEnabled,
	updateMatterOrganization,
	updateMatterWorkspace,
	type WorkspaceDto,
} from "../api.ts";
import { ROLE_ARCHITECT_MEMBER_ID } from "../architectApi.ts";
import type { HashRoute } from "../hashRouter.ts";

/** Reads a string setting from localStorage, returning `fallback` on storage unavailability. */
export function readStoredSetting(key: string, fallback = ""): string {
	try {
		return window.localStorage.getItem(key) ?? fallback;
	} catch {
		return fallback;
	}
}

/** Writes a string setting to localStorage, ignoring sandbox/private-mode storage errors. */
export function writeStoredSetting(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// Ignore storage access errors.
	}
}

interface UseMatterActionsParams {
	bootstrap: BootstrapPayload | null;
	isOwner: boolean;
	composerMode: "discussion" | "dispatch";
	composerText: string;
	composerImages: ComposerImageAttachment[];
	submitting: boolean;
	selectedMatterId: string | null;
	selectedMemberId: string;
	selectedWorkspaceId: string;
	selectedWorkspace: WorkspaceDto | null;
	selectedOrgId: string;
	draftAiMemberIds: string[] | null;
	draftObserverMemberIds?: string[];
	draftCollaboratorIds?: string[];
	draftObserversEnabled: boolean;
	headerContact: TeamMemberDto | null;
	explicitNewMatterRef: MutableRefObject<boolean>;
	memberName: (id: string) => string;
	workspaceName: (id: string | null) => string | null;
	organizationName: (id: string | null) => string | null;
	setSubmitting: (v: boolean) => void;
	setComposerText: (v: string) => void;
	setComposerImages: (v: ComposerImageAttachment[]) => void;
	setSelectedMemberId: (v: string) => void;
	setSelectedWorkspaceId: (v: string) => void;
	setSelectedOrgId: (v: string) => void;
	setDraftAiMemberIds: (v: string[] | null) => void;
	setDraftObserverMemberIds?: (v: string[]) => void;
	setDraftObserversEnabled: (v: boolean) => void;
	onResetInitiation?: () => void;
	setErrorBanner: (msg: string | null) => void;
	setNoticeBanner: (msg: string | null) => void;
	navigateRoute: (next: HashRoute, options?: { replace?: boolean }) => void;
	refreshBootstrap: () => Promise<void>;
	refreshDetail: (matterId: string | null) => Promise<void>;
}

/** Encapsulates matter mutations: sending messages/dispatches, AI requests, settings, and deliverable feedback. */
export function useMatterActions({
	bootstrap,
	isOwner,
	composerMode,
	composerText,
	composerImages,
	submitting,
	selectedMatterId,
	selectedMemberId,
	selectedWorkspaceId,
	selectedWorkspace,
	selectedOrgId,
	draftAiMemberIds,
	draftObserverMemberIds = [],
	draftCollaboratorIds = [],
	draftObserversEnabled,
	headerContact,
	explicitNewMatterRef,
	memberName,
	workspaceName,
	organizationName,
	setSubmitting,
	setComposerText,
	setComposerImages,
	setSelectedMemberId,
	setSelectedWorkspaceId,
	setSelectedOrgId,
	setDraftAiMemberIds,
	setDraftObserverMemberIds,
	setDraftObserversEnabled,
	onResetInitiation,
	setErrorBanner,
	setNoticeBanner,
	navigateRoute,
	refreshBootstrap,
	refreshDetail,
}: UseMatterActionsParams) {
	const sendPromptInternal = async (
		rawText: string,
		imagesPayload: Array<{ data: string; mimeType: string; name?: string }>,
		options?: { preferredMemberId?: string; clearComposer?: boolean; forceDispatch?: boolean },
	) => {
		const text = rawText.trim();
		if ((!text && imagesPayload.length === 0) || submitting) return;
		const effectiveMode: MatterSendMode =
			!options?.forceDispatch && composerMode === "discussion" ? "discussion" : isOwner ? "dispatch" : "ai_request";
		setSubmitting(true);
		setErrorBanner(null);
		setNoticeBanner(null);
		try {
			let targetMatterId = selectedMatterId;

			if (targetMatterId) {
				await postMatterMessage(targetMatterId, {
					mode: effectiveMode,
					prompt: text,
					images: imagesPayload.length > 0 ? imagesPayload : undefined,
					preferredMemberId: options?.preferredMemberId,
				});
				if (effectiveMode === "ai_request") {
					setNoticeBanner("已提交 AI 提请单，待团队所有者一键确认后派发执行");
				} else if (options?.preferredMemberId === ROLE_ARCHITECT_MEMBER_ID) {
					setNoticeBanner("已请「角色架构师」结合当前事项诊断分工与权限，生成提案后可勾选应用");
				}
			} else {
				const preferredForCreate =
					options?.preferredMemberId ?? (selectedMemberId === "auto" ? undefined : selectedMemberId);
				const isArchitectCreate = preferredForCreate === ROLE_ARCHITECT_MEMBER_ID;
				const created = await createMatter({
					mode: effectiveMode,
					prompt: text,
					images: imagesPayload.length > 0 ? imagesPayload : undefined,
					preferredMemberId: preferredForCreate,
					workspaceId: isArchitectCreate ? undefined : selectedWorkspaceId || undefined,
					orgId: isArchitectCreate ? null : selectedOrgId || null,
					aiMemberIds: isArchitectCreate ? [ROLE_ARCHITECT_MEMBER_ID] : draftAiMemberIds,
					observersEnabled: isArchitectCreate
						? false
						: draftObserverMemberIds.length > 0
							? true
							: draftObserversEnabled,
					observerMemberIds: isArchitectCreate
						? []
						: draftObserverMemberIds.length > 0
							? draftObserverMemberIds
							: undefined,
					collaboratorIds: draftCollaboratorIds.length > 0 ? draftCollaboratorIds : undefined,
				});
				targetMatterId = created.matter.id;
				explicitNewMatterRef.current = false;
				setSelectedMemberId("auto");
				onResetInitiation?.();
				navigateRoute({ tab: "chats", matterId: created.matter.id });
				if (effectiveMode === "discussion") {
					setNoticeBanner("已创建事项并发送首条团队讨论");
				} else if (effectiveMode === "ai_request") {
					setNoticeBanner("已创建事项并提交 AI 提请，待团队所有者确认后派发");
				} else {
					setNoticeBanner(`已派发给「${created.assignedMember.displayName}」，正在后台推进`);
				}
			}
			if (options?.clearComposer) {
				setComposerText("");
				setComposerImages([]);
			}
			await refreshBootstrap();
			if (targetMatterId) {
				await refreshDetail(targetMatterId);
			}
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	};

	const handleSendPrompt = async () => {
		const imagesPayload = composerImages.map(({ data, mimeType, name }) => ({ data, mimeType, name }));
		await sendPromptInternal(composerText, imagesPayload, { clearComposer: true });
	};

	const handleSendQuickPrompt = async (prompt: string, options?: { preferredMemberId?: string }) => {
		await sendPromptInternal(prompt, [], {
			preferredMemberId: options?.preferredMemberId,
			clearComposer: false,
			forceDispatch: true,
		});
	};

	const handleConsultArchitect = async (customPrompt?: string) => {
		const text =
			customPrompt?.trim() ||
			"请结合本事项当前推进上下文与团队现有角色配置，诊断是否缺少专职角色、存在职责重叠或工具权限过宽，并给出可勾选应用的角色提案。";
		await sendPromptInternal(text, [], {
			preferredMemberId: ROLE_ARCHITECT_MEMBER_ID,
			clearComposer: false,
			forceDispatch: true,
		});
	};

	const handleApplyRoleProposals = async (
		matterId: string,
		messageId: string,
		payload: ApplyMatterRoleProposalsPayload,
	) => {
		setErrorBanner(null);
		try {
			const res = await applyMatterRoleProposals(matterId, messageId, payload);
			const parts: string[] = [];
			if (res.createdMembers.length > 0) {
				parts.push(`已创建 ${res.createdMembers.map((m) => `「${m.displayName}」`).join("、")}`);
			}
			if (res.updatedMembers.length > 0) {
				parts.push(`已更新 ${res.updatedMembers.map((m) => `「${m.displayName}」`).join("、")}`);
			}
			if (payload.matterJoinMode && payload.matterJoinMode !== "none" && res.createdMembers.length > 0) {
				parts.push("并已加入当前事项协作");
			}
			setNoticeBanner(parts.join("，") || "角色提案已生效");
			await refreshBootstrap();
			await refreshDetail(matterId);
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		}
	};

	const handleDismissRoleProposals = async (matterId: string, messageId: string) => {
		setErrorBanner(null);
		try {
			await applyMatterRoleProposals(matterId, messageId, { action: "dismiss" });
			setNoticeBanner("已忽略该组角色建议");
			await refreshDetail(matterId);
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		}
	};

	const handleApproveAiRequest = async (matterId: string, messageId: string) => {
		setErrorBanner(null);
		try {
			await approveAiRequest(matterId, messageId);
			setNoticeBanner("已确认同事提请并派发给 AI 团队执行");
			await refreshBootstrap();
			await refreshDetail(matterId);
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		}
	};

	const handleDismissAiRequest = async (matterId: string, messageId: string) => {
		setErrorBanner(null);
		try {
			await dismissAiRequest(matterId, messageId);
			setNoticeBanner("已忽略该条 AI 提请");
			await refreshDetail(matterId);
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		}
	};

	const handleUpdateMatterCollaborators = (collaboratorIds: string[]) => {
		if (!selectedMatterId) return;
		const targetMatterId = selectedMatterId;
		void updateMatterCollaborators(targetMatterId, collaboratorIds)
			.then(async () => {
				setNoticeBanner("已更新本事项参与同事");
				await refreshBootstrap();
				await refreshDetail(targetMatterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
			});
	};

	const handleAbortMatter = (matterId: string) => {
		void abortMatter(matterId)
			.then(() => {
				setNoticeBanner("已发送停止指令，正在中断当前执行");
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
			});
	};

	const handleSelectOrganization = (nextOrgId: string) => {
		const targetOrgId = nextOrgId || "";
		const orgWorkspaces = (bootstrap?.workspaces ?? []).filter((w) =>
			targetOrgId ? w.orgId === targetOrgId : !w.orgId,
		);
		if (!selectedMatterId) {
			setSelectedOrgId(targetOrgId);
			writeStoredSetting("pa.defaultOrgId", targetOrgId);
			const currentStillMatches = selectedWorkspace
				? targetOrgId
					? selectedWorkspace.orgId === targetOrgId
					: !selectedWorkspace.orgId
				: false;
			if (!currentStillMatches) {
				const fallbackWsId = targetOrgId ? (orgWorkspaces[0]?.id ?? "") : "";
				setSelectedWorkspaceId(fallbackWsId);
				writeStoredSetting("pa.defaultWorkspaceId", fallbackWsId);
			}
			return;
		}
		const targetMatterId = selectedMatterId;
		void updateMatterOrganization(targetMatterId, targetOrgId || null)
			.then(async (res) => {
				setSelectedOrgId(res.matter.orgId ?? "");
				setSelectedWorkspaceId(res.matter.workspaceId ?? "");
				const orgLabel = res.matter.orgId ? (organizationName(res.matter.orgId) ?? res.matter.orgId) : "不归属组织";
				setNoticeBanner(`已切换当前事项组织为「${orgLabel}」`);
				await refreshBootstrap();
				await refreshDetail(targetMatterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
				void refreshDetail(targetMatterId).catch(() => {});
			});
	};

	const handleSelectWorkspace = (nextId: string) => {
		const nextWs = nextId ? (bootstrap?.workspaces.find((w) => w.id === nextId) ?? null) : null;
		if (!selectedMatterId) {
			setSelectedWorkspaceId(nextId);
			writeStoredSetting("pa.defaultWorkspaceId", nextId);
			if (nextWs) {
				const nextOrgId = nextWs.orgId ?? "";
				setSelectedOrgId(nextOrgId);
				writeStoredSetting("pa.defaultOrgId", nextOrgId);
			}
			return;
		}
		const targetMatterId = selectedMatterId;
		void updateMatterWorkspace(targetMatterId, nextId || null)
			.then(async (res) => {
				setSelectedWorkspaceId(res.matter.workspaceId ?? "");
				setSelectedOrgId(res.matter.orgId ?? "");
				writeStoredSetting("pa.defaultWorkspaceId", res.matter.workspaceId ?? "");
				const wsLabel = nextId ? (workspaceName(nextId) ?? nextId) : "不绑定仓库";
				setNoticeBanner(`已切换当前事项仓库为「${wsLabel}」`);
				await refreshBootstrap();
				await refreshDetail(targetMatterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
				void refreshDetail(targetMatterId).catch(() => {});
			});
	};

	const handleChangeLeadMember = (memberId: string) => {
		if (!memberId) return;
		if (!selectedMatterId) {
			setSelectedMemberId(memberId);
			if (draftAiMemberIds !== null && !draftAiMemberIds.includes(memberId)) {
				setDraftAiMemberIds([memberId, ...draftAiMemberIds]);
			}
			setNoticeBanner(`已将「${memberName(memberId)}」设为新事项负责人`);
			return;
		}
		const targetMatterId = selectedMatterId;
		void updateMatterLead(targetMatterId, memberId)
			.then(async () => {
				setSelectedMemberId("auto");
				setNoticeBanner(`已将「${memberName(memberId)}」设为当前事项负责人`);
				await refreshBootstrap();
				await refreshDetail(targetMatterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
				void refreshDetail(targetMatterId).catch(() => {});
			});
	};

	const handleUpdateMatterAiMembers = (nextIds: string[]) => {
		const leadId = headerContact?.id;
		const deduped = [...new Set(nextIds)];
		const ensured = leadId && !deduped.includes(leadId) ? [leadId, ...deduped] : deduped;
		if (ensured.length === 0) return;
		if (!selectedMatterId) {
			const allCount = bootstrap?.members.length ?? 0;
			setDraftAiMemberIds(ensured.length >= allCount ? null : ensured);
			return;
		}
		const targetMatterId = selectedMatterId;
		void updateMatterAiMembers(targetMatterId, ensured)
			.then(async () => {
				await refreshBootstrap();
				await refreshDetail(targetMatterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
				void refreshDetail(targetMatterId).catch(() => {});
			});
	};

	const handleToggleObserversEnabled = (enabled: boolean) => {
		writeStoredSetting("pa.defaultObserversEnabled", enabled ? "true" : "false");
		if (!selectedMatterId) {
			setDraftObserversEnabled(enabled);
			if (!enabled) setDraftObserverMemberIds?.([]);
			setNoticeBanner(enabled ? "已开启 AI 旁听（当前协作 AI 将自动参与旁听）" : "已关闭 AI 旁听");
			return;
		}
		const targetMatterId = selectedMatterId;
		void updateMatterObserversEnabled(targetMatterId, enabled)
			.then(async () => {
				setNoticeBanner(enabled ? "已开启 AI 旁听（当前协作 AI 将自动参与旁听）" : "已关闭 AI 旁听");
				await refreshBootstrap();
				await refreshDetail(targetMatterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
				void refreshDetail(targetMatterId).catch(() => {});
			});
	};

	const handleUpdateMatterObservers = (observerIds: string[]) => {
		const deduped = [...new Set(observerIds)];
		if (!selectedMatterId) {
			setDraftObserverMemberIds?.(deduped);
			setDraftObserversEnabled(deduped.length > 0);
			return;
		}
		const targetMatterId = selectedMatterId;
		void updateMatterObservers(targetMatterId, deduped)
			.then(async () => {
				setNoticeBanner(
					deduped.length > 0 ? `已设定 ${deduped.length} 位定向旁听成员` : "已取消全部旁听，保留内部按需协同",
				);
				await refreshBootstrap();
				await refreshDetail(targetMatterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
				void refreshDetail(targetMatterId).catch(() => {});
			});
	};

	const handleDeliverableFeedback = async (
		deliverableId: string,
		payload: { feedback?: string; rating?: FeedbackRating; autoDistill?: boolean },
	) => {
		try {
			const res = await submitDeliverableFeedback(deliverableId, payload);
			if (res.distillationError) setErrorBanner(`验收已保存，经验复盘未完成：${res.distillationError}`);
			const parts = ["验收记录已保存"];
			if (res.evaluatedMemoryIds.length > 0) {
				parts.push(`已回写 ${res.evaluatedMemoryIds.length} 条关联经验评估`);
			}
			if (res.distilledMemories.length > 0) {
				parts.push(`AI 新提炼 ${res.distilledMemories.length} 条待核验经验`);
			}
			setNoticeBanner(parts.join(" · "));
			await refreshBootstrap();
			if (selectedMatterId) {
				await refreshDetail(selectedMatterId);
			}
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		}
	};

	return {
		handleSendPrompt,
		handleSendQuickPrompt,
		handleConsultArchitect,
		handleApplyRoleProposals,
		handleDismissRoleProposals,
		handleApproveAiRequest,
		handleDismissAiRequest,
		handleUpdateMatterCollaborators,
		handleAbortMatter,
		handleSelectOrganization,
		handleSelectWorkspace,
		handleChangeLeadMember,
		handleUpdateMatterAiMembers,
		handleToggleObserversEnabled,
		handleUpdateMatterObservers,
		handleDeliverableFeedback,
	};
}
