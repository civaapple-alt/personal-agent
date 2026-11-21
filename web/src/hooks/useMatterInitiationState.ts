import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	assessMatterInitiation,
	type CollaborationPresetMode,
	type MatterInitiationAssessmentDto,
	type RoleGapSuggestionDto,
	type TeamMemberDto,
} from "../api.ts";
import { filterBusinessMembers, isArchitectMemberId } from "../architectApi.ts";

interface UseMatterInitiationParams {
	selectedMatterId: string | null;
	composerText: string;
	composerImageCount: number;
	composerFileCount: number;
	composerAttachmentText?: string;
	selectedWorkspaceId: string;
	selectedOrgId?: string;
	selectedMemberId: string;
	members: TeamMemberDto[];
	defaultAiMemberIds: string[] | null;
	setSelectedMemberId: (memberId: string) => void;
	setDraftAiMemberIds: (ids: string[] | null) => void;
	setDraftObserversEnabled: (enabled: boolean) => void;
}

/** Manages pre-dispatch collaboration mode, scoped human/AI roster selection, live role fit assessment, and Role Architect seed state. */
export function useMatterInitiationState({
	selectedMatterId,
	composerText,
	composerImageCount,
	composerFileCount,
	composerAttachmentText = "",
	selectedWorkspaceId,
	selectedOrgId = "",
	selectedMemberId,
	members,
	defaultAiMemberIds,
	setSelectedMemberId,
	setDraftAiMemberIds,
	setDraftObserversEnabled,
}: UseMatterInitiationParams) {
	const [draftPresetMode, setDraftPresetMode] = useState<CollaborationPresetMode>("lead_consult");
	const [draftConsultMemberIds, setDraftConsultMemberIds] = useState<string[] | null>(null);
	const [draftObserverMemberIds, setDraftObserverMemberIds] = useState<string[]>([]);
	const [draftCollaboratorIds, setDraftCollaboratorIds] = useState<string[]>([]);
	const [assessment, setAssessment] = useState<MatterInitiationAssessmentDto | null>(null);
	const [modelAssessing, setModelAssessing] = useState(false);
	const [modelAssessmentError, setModelAssessmentError] = useState<string | null>(null);
	const [architectOpen, setArchitectOpen] = useState(false);
	const [architectSeed, setArchitectSeed] = useState<RoleGapSuggestionDto | null>(null);
	const modelSeqRef = useRef(0);
	const modelControllerRef = useRef<AbortController | null>(null);

	const businessMembers = useMemo(() => filterBusinessMembers(members), [members]);
	const explicitLeadId =
		selectedMemberId !== "auto" &&
		!isArchitectMemberId(selectedMemberId, members) &&
		businessMembers.some((m) => m.id === selectedMemberId)
			? selectedMemberId
			: null;
	const fallbackLeadId =
		explicitLeadId ?? businessMembers.find((m) => m.isPrimaryContact)?.id ?? businessMembers[0]?.id ?? null;
	const draftAiMemberIds = useMemo(() => {
		if (draftConsultMemberIds === null) return defaultAiMemberIds;
		const selected = new Set(draftConsultMemberIds.concat(draftObserverMemberIds));
		return businessMembers
			.filter(({ id }) => (explicitLeadId ? id === explicitLeadId : false) || selected.has(id))
			.map(({ id }) => id);
	}, [businessMembers, defaultAiMemberIds, draftConsultMemberIds, draftObserverMemberIds, explicitLeadId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Draft changes invalidate the pending recommendation.
	useEffect(() => {
		modelSeqRef.current += 1;
		modelControllerRef.current?.abort();
		modelControllerRef.current = null;
		setModelAssessing(false);
		setModelAssessmentError(null);
		setAssessment(null);
		return () => modelControllerRef.current?.abort();
	}, [
		selectedMatterId,
		composerText,
		composerImageCount,
		composerFileCount,
		composerAttachmentText,
		selectedWorkspaceId,
		selectedOrgId,
		selectedMemberId,
	]);

	const syncDraftRoster = useCallback(
		(nextConsultIds: string[] | null, nextObserverIds: string[], leadIdOverride?: string | null) => {
			const leadId = leadIdOverride === undefined ? explicitLeadId : leadIdOverride;
			const nonLeadIds = leadId
				? businessMembers.map((m) => m.id).filter((id) => id !== leadId)
				: businessMembers.map((m) => m.id);
			const cleanConsult =
				nextConsultIds === null
					? nonLeadIds
					: nextConsultIds.filter((id) => id !== leadId && nonLeadIds.includes(id));
			const cleanObs = nextObserverIds.filter((id) => id !== leadId && nonLeadIds.includes(id));
			setDraftConsultMemberIds(nextConsultIds === null ? null : [...new Set(cleanConsult)]);
			setDraftObserverMemberIds([...new Set(cleanObs)]);
			if (cleanConsult.length === 0 && cleanObs.length === 0) {
				setDraftPresetMode("solo");
			} else if (cleanObs.length > 0) {
				setDraftPresetMode("lead_review");
			} else {
				setDraftPresetMode("lead_consult");
			}
		},
		[businessMembers, explicitLeadId],
	);

	const setScopeMode = useCallback(
		(scope: "solo" | "team") => {
			if (scope === "solo") {
				const leadId = fallbackLeadId;
				if (leadId) setSelectedMemberId(leadId);
				syncDraftRoster([], draftObserverMemberIds, leadId);
				return;
			}
			const leadId = explicitLeadId;
			const nonLeadIds = leadId
				? businessMembers.map((m) => m.id).filter((id) => id !== leadId)
				: businessMembers.map((m) => m.id);
			const existingConsult =
				draftConsultMemberIds === null
					? nonLeadIds
					: draftConsultMemberIds.filter((id) => id !== leadId && nonLeadIds.includes(id));
			const nextConsult = existingConsult.length > 0 ? draftConsultMemberIds : nonLeadIds;
			// Expanding to team collaboration preserves any already-chosen observers.
			syncDraftRoster(nextConsult, draftObserverMemberIds, leadId);
		},
		[
			businessMembers,
			draftConsultMemberIds,
			draftObserverMemberIds,
			explicitLeadId,
			fallbackLeadId,
			setSelectedMemberId,
			syncDraftRoster,
		],
	);

	const toggleDraftMemberConsult = useCallback(
		(memberId: string, enabled: boolean) => {
			const leadId = explicitLeadId;
			if (leadId && memberId === leadId) return;
			const nonLeadIds = leadId
				? businessMembers.map((m) => m.id).filter((id) => id !== leadId)
				: businessMembers.map((m) => m.id);
			const current = draftConsultMemberIds ?? nonLeadIds.filter((id) => defaultAiMemberIds?.includes(id) ?? true);
			const nextConsult = enabled ? [...new Set([...current, memberId])] : current.filter((id) => id !== memberId);
			syncDraftRoster(nextConsult, draftObserverMemberIds, leadId);
		},
		[
			businessMembers,
			defaultAiMemberIds,
			draftConsultMemberIds,
			draftObserverMemberIds,
			explicitLeadId,
			syncDraftRoster,
		],
	);

	const toggleDraftMemberObserver = useCallback(
		(memberId: string, enabled: boolean, observerIds: string[]) => {
			const leadId = explicitLeadId;
			if (leadId && memberId === leadId) return;
			const nextObs = enabled
				? [...new Set([...observerIds, memberId])]
				: observerIds.filter((id) => id !== memberId);
			setDraftObserversEnabled(nextObs.length > 0);
			syncDraftRoster(draftConsultMemberIds, nextObs, leadId);
		},
		[draftConsultMemberIds, explicitLeadId, setDraftObserversEnabled, syncDraftRoster],
	);

	const applyPresetMode = useCallback(
		(
			mode: CollaborationPresetMode,
			options?: {
				leadId?: string | null;
				aiIds?: string[];
				consultIds?: string[];
				observerIds?: string[];
			},
		) => {
			const leadId = options?.leadId ?? fallbackLeadId;
			if (mode === "human_first") {
				setDraftObserversEnabled(false);
				if (options?.consultIds || options?.aiIds || options?.observerIds) {
					const obs = (options.observerIds ?? []).filter((id) => id !== leadId);
					const consult =
						options.consultIds ??
						(options.aiIds ? options.aiIds.filter((id) => id !== leadId && !obs.includes(id)) : null);
					syncDraftRoster(consult, obs, leadId);
				}
				return;
			}
			if (mode === "solo") {
				if (leadId) setSelectedMemberId(leadId);
				setDraftConsultMemberIds([]);
				setDraftObserverMemberIds([]);
				setDraftObserversEnabled(false);
				setDraftPresetMode("solo");
				return;
			}
			const nonLeadIds = businessMembers.map((m) => m.id).filter((id) => id !== leadId);
			if (mode === "lead_consult") {
				const obs = (options?.observerIds ?? draftObserverMemberIds).filter((id) => id !== leadId);
				if (options?.observerIds) setDraftObserversEnabled(obs.length > 0);
				const consult =
					options?.consultIds ??
					(options?.aiIds ? options.aiIds.filter((id) => id !== leadId && !obs.includes(id)) : nonLeadIds);
				syncDraftRoster(consult, obs, leadId);
				return;
			}
			const defaultObserver =
				options?.observerIds && options.observerIds.length > 0
					? options.observerIds.filter((id) => id !== leadId)
					: (() => {
							const qaOrOther =
								businessMembers.find((m) => m.id !== leadId && m.templateId === "qa-manager") ??
								businessMembers.find((m) => m.id !== leadId);
							return qaOrOther ? [qaOrOther.id] : [];
						})();
			const nextConsult =
				options?.consultIds ??
				(options?.aiIds
					? options.aiIds.filter((id) => id !== leadId && !defaultObserver.includes(id))
					: draftConsultMemberIds);
			setDraftObserversEnabled(defaultObserver.length > 0);
			syncDraftRoster(nextConsult, defaultObserver, leadId);
		},
		[
			businessMembers,
			draftConsultMemberIds,
			draftObserverMemberIds,
			fallbackLeadId,
			setDraftObserversEnabled,
			setSelectedMemberId,
			syncDraftRoster,
		],
	);

	const applyAssessmentRecommendation = useCallback(() => {
		if (!assessment) return;
		if (assessment.recommendedLeadId) {
			setSelectedMemberId(assessment.recommendedLeadId);
		}
		applyPresetMode(assessment.recommendedMode, {
			leadId: assessment.recommendedLeadId,
			aiIds: assessment.recommendedAiMemberIds,
			consultIds: assessment.recommendedConsultIds,
			observerIds: assessment.recommendedObserverIds,
		});
	}, [applyPresetMode, assessment, setSelectedMemberId]);

	const cancelModelAssessment = useCallback(() => {
		modelSeqRef.current += 1;
		modelControllerRef.current?.abort();
		modelControllerRef.current = null;
		setModelAssessing(false);
	}, []);

	const requestModelAssessment = useCallback(
		async (options?: { readRepo?: boolean }) => {
			const trimmed = (composerText.trim() || composerAttachmentText.trim()).slice(0, 4000);
			if (selectedMatterId || !trimmed) return;
			const seq = ++modelSeqRef.current;
			modelControllerRef.current?.abort();
			const controller = new AbortController();
			modelControllerRef.current = controller;
			setModelAssessing(true);
			setModelAssessmentError(null);
			try {
				const result = await assessMatterInitiation(
					{
						prompt: trimmed,
						hasImages: composerImageCount > 0,
						hasFiles: composerFileCount > 0,
						workspaceId: selectedWorkspaceId || undefined,
						orgId: selectedOrgId || undefined,
						preferredMemberId: selectedMemberId === "auto" ? undefined : selectedMemberId,
						mode: "model",
						readRepo: options?.readRepo === true && Boolean(selectedWorkspaceId),
					},
					controller.signal,
				);
				if (!controller.signal.aborted && modelSeqRef.current === seq) {
					setAssessment(result);
				}
			} catch (err: unknown) {
				if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
					return;
				}
				if (modelSeqRef.current === seq) {
					const message = err instanceof Error ? err.message : String(err);
					setModelAssessmentError(`暂时无法分析（${message}），仍可按当前安排发送。`);
				}
			} finally {
				if (modelSeqRef.current === seq) {
					if (modelControllerRef.current === controller) {
						modelControllerRef.current = null;
					}
					setModelAssessing(false);
				}
			}
		},
		[
			composerAttachmentText,
			composerFileCount,
			composerImageCount,
			composerText,
			selectedMatterId,
			selectedMemberId,
			selectedOrgId,
			selectedWorkspaceId,
		],
	);

	const openArchitectForGap = useCallback((gap?: RoleGapSuggestionDto) => {
		setArchitectSeed(gap ?? null);
		setArchitectOpen(true);
	}, []);

	const resetInitiationState = useCallback(() => {
		modelSeqRef.current += 1;
		modelControllerRef.current?.abort();
		modelControllerRef.current = null;
		setDraftPresetMode("lead_consult");
		setDraftAiMemberIds(null);
		setDraftConsultMemberIds(null);
		setDraftObserverMemberIds([]);
		setDraftObserversEnabled(false);
		setDraftCollaboratorIds([]);
		setAssessment(null);
		setModelAssessing(false);
		setModelAssessmentError(null);
	}, [setDraftAiMemberIds, setDraftObserversEnabled]);

	return {
		draftAiMemberIds,
		draftPresetMode,
		draftConsultMemberIds,
		draftObserverMemberIds,
		draftCollaboratorIds,
		assessment,
		modelAssessing,
		modelAssessmentError,
		architectOpen,
		architectSeed,
		setDraftConsultMemberIds,
		setDraftObserverMemberIds,
		setDraftCollaboratorIds,
		setDraftPresetMode,
		setArchitectOpen,
		setArchitectSeed,
		syncDraftRoster,
		setScopeMode,
		toggleDraftMemberConsult,
		toggleDraftMemberObserver,
		applyPresetMode,
		applyAssessmentRecommendation,
		requestModelAssessment,
		cancelModelAssessment,
		openArchitectForGap,
		resetInitiationState,
	};
}
