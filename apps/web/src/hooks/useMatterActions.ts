import type { MutableRefObject } from "react";
import type { ModelSelection } from "../api/models.ts";
import {
	type ApplyMatterRoleProposalsPayload,
	abortMatter,
	applyMatterRoleProposals,
	approveAiRequest,
	type BootstrapPayload,
	type ComposerFileAttachment,
	type ComposerImageAttachment,
	createMatter,
	dismissAiRequest,
	type MatterCollaborationMode,
	type MatterSendMode,
	type MatterVisibility,
	postMatterMessage,
	type TeamMemberDto,
	type UploadFilePayload,
	updateMatterAiMembers,
	updateMatterCollaborationMode,
	updateMatterCollaborators,
	updateMatterConsultMembers,
	updateMatterLead,
	updateMatterObservers,
	updateMatterObserversEnabled,
	updateMatterOrganization,
	updateMatterVisibility,
	updateMatterWorkspace,
	type WorkspaceDto,
} from "../api.ts";
import { ROLE_ARCHITECT_MEMBER_ID } from "../architectApi.ts";
import type { HashRoute } from "../hashRouter.ts";

import { readStoredSetting, writeStoredSetting } from "../utils/storage.ts";

export { readStoredSetting, writeStoredSetting };

function conversationNotice(result: {
	aiDiscussionTriggered?: boolean;
	aiDiscussionSkippedReason?: string;
}): string | null {
	if (result.aiDiscussionTriggered) return null;
	switch (result.aiDiscussionSkippedReason) {
		case "matter_busy":
			return "消息已保存，AI 正在处理上一条消息";
		case "quota_limit":
			return "消息已保存，当前 AI 并发额度已用完";
		case "unavailable_recipient":
			return "消息已保存，点名的角色当前无法在这个事项中参与";
		case "unauthorized":
			return "消息已保存，当前账号无权启动 AI 回复";
		default:
			return null;
	}
}

interface UseMatterActionsParams {
	bootstrap: BootstrapPayload | null;
	isOwner: boolean;
	currentMatterLeadId?: string | null;
	composerText: string;
	composerImages: ComposerImageAttachment[];
	composerFiles: ComposerFileAttachment[];
	submitting: boolean;
	selectedMatterId: string | null;
	selectedMemberId: string;
	selectedWorkspaceId: string;
	selectedWorkspace: WorkspaceDto | null;
	selectedOrgId: string;
	draftAiMemberIds: string[] | null;
	draftConsultMemberIds?: string[] | null;
	draftObserverMemberIds?: string[];
	draftCollaboratorIds?: string[];
	draftVisibility?: MatterVisibility;
	draftCollaborationMode?: MatterCollaborationMode;
	draftObserversEnabled: boolean;
	draftModelSelection: ModelSelection | null;
	headerContact: TeamMemberDto | null;
	explicitNewMatterRef: MutableRefObject<boolean>;
	memberName: (id: string) => string;
	workspaceName: (id: string | null) => string | null;
	organizationName: (id: string | null) => string | null;
	setSubmitting: (v: boolean) => void;
	clearSentComposer: () => void;
	setSelectedMemberId: (v: string) => void;
	setSelectedWorkspaceId: (v: string) => void;
	setSelectedOrgId: (v: string) => void;
	setDraftAiMemberIds: (v: string[] | null) => void;
	setDraftConsultMemberIds?: (v: string[] | null) => void;
	setDraftObserverMemberIds?: (v: string[]) => void;
	setDraftObserversEnabled: (v: boolean) => void;
	onSyncDraftPresetForObservers?: (hasObservers: boolean) => void;
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
	currentMatterLeadId,
	composerText,
	composerImages,
	composerFiles,
	submitting,
	selectedMatterId,
	selectedMemberId,
	selectedWorkspaceId,
	selectedWorkspace,
	selectedOrgId,
	draftAiMemberIds,
	draftConsultMemberIds = null,
	draftObserverMemberIds = [],
	draftCollaboratorIds = [],
	draftVisibility = "org",
	draftCollaborationMode = "lead",
	draftObserversEnabled,
	draftModelSelection,
	headerContact,
	explicitNewMatterRef,
	memberName,
	workspaceName,
	organizationName,
	setSubmitting,
	clearSentComposer,
	setSelectedMemberId,
	setSelectedWorkspaceId,
	setSelectedOrgId,
	setDraftAiMemberIds,
	setDraftConsultMemberIds,
	setDraftObserverMemberIds,
	setDraftObserversEnabled,
	onSyncDraftPresetForObservers,
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
		filesPayload: UploadFilePayload[],
		options?: { preferredMemberId?: string; clearComposer?: boolean; forceDispatch?: boolean },
	) => {
		const text = rawText.trim();
		if ((!text && imagesPayload.length === 0 && filesPayload.length === 0) || submitting) return false;
		const inArchitectConversation = selectedMatterId
			? currentMatterLeadId === ROLE_ARCHITECT_MEMBER_ID
			: selectedMemberId === ROLE_ARCHITECT_MEMBER_ID;
		const effectiveMode: MatterSendMode =
			options?.forceDispatch || inArchitectConversation ? (isOwner ? "dispatch" : "ai_request") : "conversation";
		if (effectiveMode === "conversation" && !bootstrap?.unifiedConversation) {
			setErrorBanner("当前服务尚未载入新版对话。重启 Personal Agent 服务后再发送，草稿已保留。");
			return false;
		}
		setSubmitting(true);
		setErrorBanner(null);
		setNoticeBanner(null);
		try {
			let targetMatterId = selectedMatterId;

			if (targetMatterId) {
				const posted = await postMatterMessage(targetMatterId, {
					mode: effectiveMode,
					prompt: text,
					images: imagesPayload.length > 0 ? imagesPayload : undefined,
					files: filesPayload.length > 0 ? filesPayload : undefined,
					preferredMemberId: options?.preferredMemberId,
				});
				if ((posted.mode ?? effectiveMode) === "ai_request") {
					setNoticeBanner("已提交 AI 提请单，待团队所有者一键确认后派发执行");
				} else if (effectiveMode === "conversation") {
					setNoticeBanner(conversationNotice(posted));
				} else if (options?.preferredMemberId === ROLE_ARCHITECT_MEMBER_ID) {
					setNoticeBanner("已请「角色架构师」结合当前事项诊断分工与权限，生成提案后可勾选应用");
				}
			} else {
				const preferredForCreate =
					options?.preferredMemberId ?? (selectedMemberId === "auto" ? undefined : selectedMemberId);
				const isArchitectCreate = preferredForCreate === ROLE_ARCHITECT_MEMBER_ID;
				const defaultUserOrgId =
					bootstrap?.organizations.find((o) => o.isDefault)?.id ?? bootstrap?.organizations[0]?.id ?? "";
				const canLeaveOrgUnbound =
					bootstrap?.authKind !== "session" || bootstrap?.accountUser?.platformRole === "super_admin";
				const orgForCreate = isArchitectCreate
					? selectedOrgId || defaultUserOrgId || undefined
					: selectedOrgId || (canLeaveOrgUnbound ? null : defaultUserOrgId || undefined);
				const created = await createMatter({
					mode: effectiveMode,
					prompt: text,
					images: imagesPayload.length > 0 ? imagesPayload : undefined,
					files: filesPayload.length > 0 ? filesPayload : undefined,
					preferredMemberId: preferredForCreate,
					workspaceId: isArchitectCreate ? undefined : selectedWorkspaceId || undefined,
					orgId: orgForCreate,
					aiMemberIds: isArchitectCreate ? [ROLE_ARCHITECT_MEMBER_ID] : draftAiMemberIds,
					consultMemberIds: isArchitectCreate ? [] : draftConsultMemberIds,
					observersEnabled: !isArchitectCreate && draftObserversEnabled,
					observerMemberIds: isArchitectCreate
						? []
						: draftObserverMemberIds.length > 0
							? draftObserverMemberIds
							: undefined,
					collaboratorIds: draftCollaboratorIds.length > 0 ? draftCollaboratorIds : undefined,
					visibility: draftVisibility,
					modelSelection: isOwner ? draftModelSelection : null,
					...(!isArchitectCreate && draftCollaborationMode === "board"
						? {
								collaborationMode: "board" as const,
								coordinatorMemberId: preferredForCreate ?? headerContact?.id ?? null,
							}
						: {}),
				});
				targetMatterId = created.matter.id;
				explicitNewMatterRef.current = false;
				setSelectedMemberId("auto");
				onResetInitiation?.();
				navigateRoute({ tab: "chats", matterId: created.matter.id });
				if ((created.mode ?? effectiveMode) === "ai_request") {
					setNoticeBanner("已创建事项并提交 AI 提请，待团队所有者确认后派发");
				} else if (effectiveMode === "conversation") {
					setNoticeBanner(conversationNotice(created));
				} else {
					setNoticeBanner(`已派发给「${created.assignedMember.displayName}」，正在后台推进`);
				}
			}
			if (options?.clearComposer) clearSentComposer();
			await refreshBootstrap();
			if (targetMatterId) {
				await refreshDetail(targetMatterId);
			}
			return true;
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setSubmitting(false);
		}
	};

	const handleSendPrompt = async () => {
		const imagesPayload = composerImages.map(({ data, mimeType, name }) => ({ data, mimeType, name }));
		const filesPayload = composerFiles.map(({ kind, name, mimeType, content }) => ({
			kind,
			name,
			mimeType,
			content,
		}));
		await sendPromptInternal(composerText, imagesPayload, filesPayload, { clearComposer: true });
	};

	const handleSendQuickPrompt = async (prompt: string, options?: { preferredMemberId?: string }) => {
		return await sendPromptInternal(prompt, [], [], {
			preferredMemberId: options?.preferredMemberId,
			clearComposer: false,
			forceDispatch: true,
		});
	};

	const handleConsultArchitect = async (customPrompt?: string) => {
		const text =
			customPrompt?.trim() ||
			"请结合本事项当前推进上下文与团队现有角色配置，诊断是否缺少专职角色、存在职责重叠或工具权限过宽，并给出可勾选应用的角色提案。";
		await sendPromptInternal(text, [], [], {
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
			if (draftConsultMemberIds !== null) {
				setDraftConsultMemberIds?.(
					ensured.filter(
						(id) => id !== leadId && (draftConsultMemberIds.includes(id) || !draftAiMemberIds?.includes(id)),
					),
				);
				setDraftObserverMemberIds?.(draftObserverMemberIds.filter((id) => ensured.includes(id)));
				return;
			}
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

	const handleUpdateMatterObservers = (observerIds: string[]) => {
		const deduped = [...new Set(observerIds)];
		if (!selectedMatterId) {
			setDraftObserverMemberIds?.(deduped);
			setDraftObserversEnabled(deduped.length > 0);
			onSyncDraftPresetForObservers?.(deduped.length > 0);
			return;
		}
		const targetMatterId = selectedMatterId;
		void updateMatterObservers(targetMatterId, deduped)
			.then(async () => {
				setNoticeBanner(deduped.length > 0 ? `已设定 ${deduped.length} 位定向旁听成员` : "已取消全部旁听");
				await refreshBootstrap();
				await refreshDetail(targetMatterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
				void refreshDetail(targetMatterId).catch(() => {});
			});
	};

	const handleUpdateMatterConsultMembers = (consultIds: string[] | null) => {
		const deduped = consultIds === null ? null : [...new Set(consultIds)];
		if (!selectedMatterId) {
			setDraftConsultMemberIds?.(deduped);
			return;
		}
		const targetMatterId = selectedMatterId;
		void updateMatterConsultMembers(targetMatterId, deduped)
			.then(async () => {
				setNoticeBanner(
					deduped && deduped.length > 0
						? `已设定 ${deduped.length} 位可按需请教成员`
						: deduped === null
							? "已允许主责按需请教全部在组 AI 成员"
							: "已设为不主动委托其他成员请教",
				);
				await refreshBootstrap();
				await refreshDetail(targetMatterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
				void refreshDetail(targetMatterId).catch(() => {});
			});
	};

	const handleToggleObserversEnabled = (enabled: boolean) => {
		if (!selectedMatterId) {
			setDraftObserversEnabled(enabled);
			onSyncDraftPresetForObservers?.(enabled);
			setNoticeBanner(enabled ? "已开启 AI 旁听" : "已关闭 AI 旁听");
			return;
		}
		const targetMatterId = selectedMatterId;
		void updateMatterObserversEnabled(targetMatterId, enabled)
			.then(async () => {
				setNoticeBanner(enabled ? "已开启 AI 旁听" : "已关闭 AI 旁听");
				await refreshBootstrap();
				await refreshDetail(targetMatterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
				void refreshDetail(targetMatterId).catch(() => {});
			});
	};

	const handleUpdateMatterVisibility = (matterId: string, visibility: MatterVisibility) => {
		void updateMatterVisibility(matterId, visibility)
			.then(async () => {
				setNoticeBanner(
					visibility === "private" ? "已设为私密事项（仅发起人与指定成员可见）" : "已设为组织全员可见",
				);
				await refreshBootstrap();
				await refreshDetail(matterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
			});
	};

	const handleUpdateCollaborationMode = (
		collaborationMode: MatterCollaborationMode,
		coordinatorMemberId?: string | null,
	) => {
		if (!selectedMatterId) return;
		const targetMatterId = selectedMatterId;
		void updateMatterCollaborationMode(targetMatterId, collaborationMode, coordinatorMemberId)
			.then(async () => {
				setNoticeBanner(
					collaborationMode === "board" ? "已切换为团队公告板模式（Board）" : "已切换为轻量主责模式（Lead）",
				);
				await refreshBootstrap();
				await refreshDetail(targetMatterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
				void refreshDetail(targetMatterId).catch(() => {});
			});
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
		handleUpdateMatterConsultMembers,
		handleToggleObserversEnabled,
		handleUpdateMatterObservers,
		handleUpdateMatterVisibility,
		handleUpdateCollaborationMode,
	};
}
