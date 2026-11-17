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
	selectedWorkspaceId: string;
	selectedMemberId: string;
	members: TeamMemberDto[];
	setSelectedMemberId: (memberId: string) => void;
	setComposerMode: (mode: "discussion" | "dispatch") => void;
	setDraftAiMemberIds: (ids: string[] | null) => void;
	setDraftObserversEnabled: (enabled: boolean) => void;
}

/** Manages pre-dispatch collaboration mode, scoped human/AI roster selection, live role fit assessment, and Role Architect seed state. */
export function useMatterInitiationState({
	selectedMatterId,
	composerText,
	composerImageCount,
	selectedWorkspaceId,
	selectedMemberId,
	members,
	setSelectedMemberId,
	setComposerMode,
	setDraftAiMemberIds,
	setDraftObserversEnabled,
}: UseMatterInitiationParams) {
	const [draftPresetMode, setDraftPresetMode] = useState<CollaborationPresetMode>("lead_consult");
	const [draftObserverMemberIds, setDraftObserverMemberIds] = useState<string[]>([]);
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
		const trimmed = composerText.trim();
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
					workspaceId: selectedWorkspaceId || undefined,
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
	}, [selectedMatterId, composerText, composerImageCount, selectedWorkspaceId, selectedMemberId]);

	const applyPresetMode = useCallback(
		(
			mode: CollaborationPresetMode,
			options?: { leadId?: string | null; aiIds?: string[]; observerIds?: string[] },
		) => {
			const leadId = options?.leadId ?? fallbackLeadId;
			setDraftPresetMode(mode);
			if (mode === "human_first") {
				setComposerMode("discussion");
				setDraftObserversEnabled(false);
				setDraftObserverMemberIds([]);
				return;
			}
			setComposerMode("dispatch");
			if (mode === "solo") {
				if (leadId) setSelectedMemberId(leadId);
				setDraftAiMemberIds(leadId ? [leadId] : null);
				setDraftObserverMemberIds([]);
				setDraftObserversEnabled(false);
				return;
			}
			if (mode === "lead_consult") {
				const allIds = businessMembers.map((m) => m.id);
				setDraftAiMemberIds(options?.aiIds?.length ? options.aiIds : allIds.length > 0 ? allIds : null);
				setDraftObserverMemberIds([]);
				setDraftObserversEnabled(false);
				return;
			}
			// lead_review: targeted observers, without enrolling unrelated members.
			const defaultObserver =
				options?.observerIds && options.observerIds.length > 0
					? options.observerIds.filter((id) => id !== leadId)
					: (() => {
							const qaOrOther =
								businessMembers.find((m) => m.id !== leadId && m.templateId === "qa-manager") ??
								businessMembers.find((m) => m.id !== leadId);
							return qaOrOther ? [qaOrOther.id] : [];
						})();
			const nextAiIds = options?.aiIds?.length
				? Array.from(new Set([...(leadId ? [leadId] : []), ...options.aiIds, ...defaultObserver]))
				: [...(leadId ? [leadId] : []), ...defaultObserver];
			setDraftAiMemberIds(nextAiIds.length > 0 ? nextAiIds : null);
			setDraftObserverMemberIds(defaultObserver);
			setDraftObserversEnabled(defaultObserver.length > 0);
		},
		[
			businessMembers,
			fallbackLeadId,
			setComposerMode,
			setDraftAiMemberIds,
			setDraftObserversEnabled,
			setSelectedMemberId,
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
			const trimmed = composerText.trim();
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
						workspaceId: selectedWorkspaceId || undefined,
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
		[composerImageCount, composerText, selectedMatterId, selectedMemberId, selectedWorkspaceId],
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
		setDraftObserverMemberIds([]);
		setDraftObserversEnabled(false);
		setDraftCollaboratorIds([]);
		setAssessment(null);
		setModelAssessing(false);
		setModelAssessmentError(null);
		setComposerMode("dispatch");
	}, [setComposerMode, setDraftAiMemberIds, setDraftObserversEnabled]);

	return {
		draftPresetMode,
		draftObserverMemberIds,
		draftCollaboratorIds,
		assessment,
		assessing,
		assessmentError,
		modelAssessing,
		modelAssessmentError,
		architectOpen,
		architectSeed,
		setDraftObserverMemberIds,
		setDraftCollaboratorIds,
		setDraftPresetMode,
		setArchitectOpen,
		setArchitectSeed,
		applyPresetMode,
		applyAssessmentRecommendation,
		requestModelAssessment,
		cancelModelAssessment,
		openArchitectForGap,
		resetInitiationState,
	};
}
