import { useCallback, useEffect, useRef, useState } from "react";
import {
	assessMatterInitiation,
	type CollaborationPresetMode,
	type MatterInitiationAssessmentDto,
	type RoleGapSuggestionDto,
	type TeamMemberDto,
} from "../api.ts";

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
	const [architectOpen, setArchitectOpen] = useState(false);
	const [architectSeed, setArchitectSeed] = useState<RoleGapSuggestionDto | null>(null);
	const seqRef = useRef(0);

	const fallbackLeadId =
		selectedMemberId !== "auto" && members.some((m) => m.id === selectedMemberId)
			? selectedMemberId
			: (members.find((m) => m.isPrimaryContact)?.id ?? members[0]?.id ?? null);

	useEffect(() => {
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
		const seq = ++seqRef.current;
		setAssessing(true);
		const timer = window.setTimeout(() => {
			void assessMatterInitiation({
				prompt: trimmed,
				hasImages: composerImageCount > 0,
				workspaceId: selectedWorkspaceId || undefined,
				preferredMemberId: selectedMemberId === "auto" ? undefined : selectedMemberId,
			})
				.then((result) => {
					if (seqRef.current === seq) {
						setAssessment(result);
					}
				})
				.catch(() => {
					if (seqRef.current === seq) {
						setAssessment(null);
					}
				})
				.finally(() => {
					if (seqRef.current === seq) {
						setAssessing(false);
					}
				});
		}, 280);
		return () => window.clearTimeout(timer);
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
				const allIds = members.map((m) => m.id);
				setDraftAiMemberIds(options?.aiIds?.length ? options.aiIds : allIds.length > 0 ? allIds : null);
				setDraftObserverMemberIds([]);
				setDraftObserversEnabled(false);
				return;
			}
			// lead_review: targeted observers (default 1 QA/reviewer if none specified yet)
			const allIds = members.map((m) => m.id);
			const defaultObserver =
				options?.observerIds && options.observerIds.length > 0
					? options.observerIds.filter((id) => id !== leadId)
					: (() => {
							const qaOrOther =
								members.find((m) => m.id !== leadId && m.templateId === "qa-manager") ??
								members.find((m) => m.id !== leadId);
							return qaOrOther ? [qaOrOther.id] : [];
						})();
			const nextAiIds = options?.aiIds?.length
				? Array.from(new Set([...(leadId ? [leadId] : []), ...options.aiIds, ...defaultObserver]))
				: allIds;
			setDraftAiMemberIds(nextAiIds.length > 0 ? nextAiIds : null);
			setDraftObserverMemberIds(defaultObserver);
			setDraftObserversEnabled(defaultObserver.length > 0);
		},
		[fallbackLeadId, members, setComposerMode, setDraftAiMemberIds, setDraftObserversEnabled, setSelectedMemberId],
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

	const openArchitectForGap = useCallback((gap?: RoleGapSuggestionDto) => {
		setArchitectSeed(gap ?? null);
		setArchitectOpen(true);
	}, []);

	const resetInitiationState = useCallback(() => {
		setDraftPresetMode("lead_consult");
		setDraftAiMemberIds(null);
		setDraftObserverMemberIds([]);
		setDraftObserversEnabled(false);
		setDraftCollaboratorIds([]);
		setAssessment(null);
		setComposerMode("dispatch");
	}, [setComposerMode, setDraftAiMemberIds, setDraftObserversEnabled]);

	return {
		draftPresetMode,
		draftObserverMemberIds,
		draftCollaboratorIds,
		assessment,
		assessing,
		architectOpen,
		architectSeed,
		setDraftObserverMemberIds,
		setDraftCollaboratorIds,
		setDraftPresetMode,
		setArchitectOpen,
		setArchitectSeed,
		applyPresetMode,
		applyAssessmentRecommendation,
		openArchitectForGap,
		resetInitiationState,
	};
}
