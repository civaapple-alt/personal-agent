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
	setSelectedMemberId,
	setDraftAiMemberIds,
	setDraftObserversEnabled,
}: UseMatterInitiationParams) {
	const [draftPresetMode, setDraftPresetMode] = useState<CollaborationPresetMode>("lead_consult");
	const [draftConsultMemberIds, setDraftConsultMemberIds] = useState<string[] | null>(null);
	const [draftObserverMemberIds, setDraftObserverMemberIds] = useState<string[]>([]);
	const [draftDiscussionAiEnabled, setDraftDiscussionAiEnabled] = useState(false);
	const [draftCollaboratorIds, setDraftCollaboratorIds] = useState<string[]>([]);
	const [assessment, setAssessment] = useState<MatterInitiationAssessmentDto | null>(null);
	const [assessing, setAssessing] = useState(false);
	const [assessmentError, setAssessmentError] = useState<string | null>(null);
	const [modelAssessing, setModelAssessing] = useState(false);
	const [modelAssessmentError, setModelAssessmentError] = useState<string | null>(null);
	const [architectOpen, setArchitectOpen] = useState(false);
	const [architectSeed, setArchitectSeed] = useState<RoleGapSuggestionDto | null>(null);
	const seqRef = useRef(0);
	const modelSeqRef = useRef(0);
	const modelControllerRef = useRef<AbortController | null>(null);

	const businessMembers = useMemo(() => filterBusinessMembers(members), [members]);
	const fallbackLeadId =
		selectedMemberId !== "auto" &&
		!isArchitectMemberId(selectedMemberId, members) &&
		businessMembers.some((m) => m.id === selectedMemberId)
			? selectedMemberId
			: (businessMembers.find((m) => m.isPrimaryContact)?.id ?? businessMembers[0]?.id ?? null);

	useEffect(() => {
		const seq = ++seqRef.current;
		let active = true;
		const controller = new AbortController();
		modelControllerRef.current?.abort();
		modelControllerRef.current = null;
		setModelAssessing(false);
		setModelAssessmentError(null);
		setAssessment(null);
		setAssessmentError(null);
		if (selectedMatterId) {
			setAssessment(null);
			setAssessing(false);
			return;
		}
		const trimmed = (composerText.trim() || composerAttachmentText.trim()).slice(0, 4000);
		if (trimmed.length < 6) {
			setAssessment(null);
			setAssessing(false);
			return;
		}
		setAssessing(true);
		const timer = window.setTimeout(() => {
			void assessMatterInitiation(
				{
					prompt: trimmed,
					hasImages: composerImageCount > 0,
					hasFiles: composerFileCount > 0,
					workspaceId: selectedWorkspaceId || undefined,
					orgId: selectedOrgId || undefined,
					preferredMemberId: selectedMemberId === "auto" ? undefined : selectedMemberId,
				},
				controller.signal,
			)
				.then((result) => {
					if (active && seqRef.current === seq) {
						setAssessment(result);
					}
				})
				.catch(() => {
					if (active && seqRef.current === seq) {
						setAssessment(null);
						setAssessmentError("参与建议暂不可用，仍可按当前安排发送。");
					}
				})
				.finally(() => {
					if (active && seqRef.current === seq) {
						setAssessing(false);
					}
				});
		}, 280);
		return () => {
			active = false;
			controller.abort();
			window.clearTimeout(timer);
		};
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
		(nextConsultIds: string[] | null, nextObserverIds: string[], explicitLeadId?: string | null) => {
			const leadId = explicitLeadId ?? fallbackLeadId;
			const nonLeadIds = businessMembers.map((m) => m.id).filter((id) => id !== leadId);
			const cleanConsult =
				nextConsultIds === null
					? nonLeadIds
					: nextConsultIds.filter((id) => id !== leadId && nonLeadIds.includes(id));
			const cleanObs = nextObserverIds.filter((id) => id !== leadId && nonLeadIds.includes(id));
			const isAllConsult = nonLeadIds.every((id) => cleanConsult.includes(id));
			const normalizedConsult = isAllConsult && nextConsultIds === null ? null : [...new Set(cleanConsult)];
			setDraftConsultMemberIds(normalizedConsult);
			setDraftObserverMemberIds([...new Set(cleanObs)]);
			setDraftObserversEnabled(cleanObs.length > 0);
			const union = [...new Set([...(leadId ? [leadId] : []), ...cleanConsult, ...cleanObs])];
			if (isAllConsult) {
				setDraftAiMemberIds(null);
			} else {
				setDraftAiMemberIds(union.length > 0 ? union : leadId ? [leadId] : null);
			}
			if (cleanConsult.length === 0 && cleanObs.length === 0) {
				setDraftPresetMode("solo");
			} else if (cleanObs.length > 0) {
				setDraftPresetMode("lead_review");
			} else {
				setDraftPresetMode("lead_consult");
			}
		},
		[businessMembers, fallbackLeadId, setDraftAiMemberIds, setDraftObserversEnabled],
	);

	const setScopeMode = useCallback(
		(scope: "solo" | "team") => {
			const leadId = fallbackLeadId;
			if (scope === "solo") {
				if (leadId) setSelectedMemberId(leadId);
				syncDraftRoster([], draftObserverMemberIds, leadId);
				return;
			}
			const nonLeadIds = businessMembers.map((m) => m.id).filter((id) => id !== leadId);
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
			fallbackLeadId,
			setSelectedMemberId,
			syncDraftRoster,
		],
	);

	const toggleObserverPreset = useCallback(() => {
		const leadId = fallbackLeadId;
		if (draftObserverMemberIds.length > 0) {
			syncDraftRoster(draftConsultMemberIds, [], leadId);
			return;
		}
		const nonLead = businessMembers.filter((m) => m.id !== leadId);
		const defaultObs = nonLead.find((m) => m.templateId === "qa-manager") ?? nonLead[0] ?? null;
		const nextObs = defaultObs ? [defaultObs.id] : [];
		syncDraftRoster(draftConsultMemberIds, nextObs, leadId);
	}, [businessMembers, draftConsultMemberIds, draftObserverMemberIds.length, fallbackLeadId, syncDraftRoster]);

	const toggleDraftMemberConsult = useCallback(
		(memberId: string, enabled: boolean) => {
			const leadId = fallbackLeadId;
			if (memberId === leadId) return;
			const nonLeadIds = businessMembers.map((m) => m.id).filter((id) => id !== leadId);
			const current = draftConsultMemberIds === null ? nonLeadIds : draftConsultMemberIds;
			const nextConsult = enabled ? [...new Set([...current, memberId])] : current.filter((id) => id !== memberId);
			syncDraftRoster(nextConsult, draftObserverMemberIds, leadId);
		},
		[businessMembers, draftConsultMemberIds, draftObserverMemberIds, fallbackLeadId, syncDraftRoster],
	);

	const toggleDraftMemberObserver = useCallback(
		(memberId: string, enabled: boolean) => {
			const leadId = fallbackLeadId;
			if (memberId === leadId) return;
			const nextObs = enabled
				? [...new Set([...draftObserverMemberIds, memberId])]
				: draftObserverMemberIds.filter((id) => id !== memberId);
			syncDraftRoster(draftConsultMemberIds, nextObs, leadId);
		},
		[draftConsultMemberIds, draftObserverMemberIds, fallbackLeadId, syncDraftRoster],
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
				setDraftDiscussionAiEnabled(false);
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
				setDraftAiMemberIds(leadId ? [leadId] : null);
				setDraftPresetMode("solo");
				return;
			}
			const nonLeadIds = businessMembers.map((m) => m.id).filter((id) => id !== leadId);
			if (mode === "lead_consult") {
				const obs = (options?.observerIds ?? draftObserverMemberIds).filter((id) => id !== leadId);
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
			syncDraftRoster(nextConsult, defaultObserver, leadId);
		},
		[
			businessMembers,
			draftConsultMemberIds,
			draftObserverMemberIds,
			fallbackLeadId,
			setDraftAiMemberIds,
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
					setAssessmentError(null);
				}
			} catch (err: unknown) {
				if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
					return;
				}
				if (modelSeqRef.current === seq) {
					const message = err instanceof Error ? err.message : String(err);
					setModelAssessmentError(`AI 决策模型暂不可用（${message}），已保留本地规则建议`);
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
		setDraftDiscussionAiEnabled(false);
		setDraftCollaboratorIds([]);
		setAssessment(null);
		setModelAssessing(false);
		setModelAssessmentError(null);
	}, [setDraftAiMemberIds, setDraftObserversEnabled]);

	return {
		draftPresetMode,
		draftConsultMemberIds,
		draftObserverMemberIds,
		draftDiscussionAiEnabled,
		draftCollaboratorIds,
		assessment,
		assessing,
		assessmentError,
		modelAssessing,
		modelAssessmentError,
		architectOpen,
		architectSeed,
		setDraftConsultMemberIds,
		setDraftObserverMemberIds,
		setDraftDiscussionAiEnabled,
		setDraftCollaboratorIds,
		setDraftPresetMode,
		setArchitectOpen,
		setArchitectSeed,
		syncDraftRoster,
		setScopeMode,
		toggleObserverPreset,
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
