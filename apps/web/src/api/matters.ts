import type {
	ActiveDelegationDto,
	ActiveRunSnapshotDto,
	DecisionConfidence,
	HumanDecisionAction,
	InitiationAssessmentSource,
	MatterCollaborationMode,
	MatterDecisionStatus,
	MatterDetailPayload,
	MatterDto,
	MatterInitiationAssessmentDto,
	MatterInitiationCandidateDto,
	MatterMessageDto,
	MatterMessageKind,
	MatterProgressDto,
	MatterSendMode,
	MatterStatus,
	MatterVisibility,
	MessageFileDto,
	MessageImageDto,
	PendingDialogDto,
	ProgressActivityDto,
	ProgressSnapshotDto,
	RoleFitStatus,
	RoleGapSuggestionDto,
	UploadFilePayload,
	UploadImagePayload,
} from "@pa/contracts/matter";
import type { ModelSelection } from "@pa/contracts/model-selection";
import type { CollaborationPresetMode, TeamMemberDto } from "@pa/contracts/team";
import { requestJson } from "./client.ts";

export type {
	ActiveDelegationDto,
	ActiveRunSnapshotDto,
	CollaborationPresetMode,
	DecisionConfidence,
	HumanDecisionAction,
	InitiationAssessmentSource,
	MatterCollaborationMode,
	MatterDecisionStatus,
	MatterDetailPayload,
	MatterDto,
	MatterInitiationAssessmentDto,
	MatterInitiationCandidateDto,
	MatterMessageDto,
	MatterMessageKind,
	MatterProgressDto,
	MatterSendMode,
	MatterStatus,
	MatterVisibility,
	MessageFileDto,
	MessageImageDto,
	PendingDialogDto,
	ProgressActivityDto,
	ProgressSnapshotDto,
	RoleFitStatus,
	RoleGapSuggestionDto,
	UploadFilePayload,
	UploadImagePayload,
};

export interface ComposerImageAttachment extends UploadImagePayload {
	id: string;
	name: string;
	previewUrl: string;
	sizeBytes: number;
}

export interface ComposerFileAttachment extends UploadFilePayload {
	id: string;
	sizeBytes: number;
	lineCount: number;
	charCount: number;
	previewText: string;
}

export function fetchMatterDetail(matterId: string): Promise<MatterDetailPayload> {
	return requestJson<MatterDetailPayload>(`/api/matters/${encodeURIComponent(matterId)}`);
}

export function actOnHumanDecision(matterId: string, messageId: string, input: HumanDecisionAction) {
	return requestJson<{ message: MatterMessageDto; resumed: boolean }>(
		`/api/matters/${encodeURIComponent(matterId)}/messages/${encodeURIComponent(messageId)}/human-decision`,
		{ method: "POST", body: JSON.stringify(input) },
	);
}

export function assessMatterInitiation(
	input: {
		prompt: string;
		hasImages?: boolean;
		hasFiles?: boolean;
		workspaceId?: string;
		orgId?: string | null;
		preferredMemberId?: string;
		mode?: "rules" | "model";
		readRepo?: boolean;
	},
	signal?: AbortSignal,
): Promise<MatterInitiationAssessmentDto> {
	return requestJson("/api/matters/assess", {
		method: "POST",
		body: JSON.stringify(input),
		signal,
	});
}

export function createMatter(input: {
	mode?: MatterSendMode;
	prompt: string;
	images?: UploadImagePayload[];
	files?: UploadFilePayload[];
	preferredMemberId?: string;
	workspaceId?: string;
	orgId?: string | null;
	aiMemberIds?: string[] | null;
	consultMemberIds?: string[] | null;
	observersEnabled?: boolean;
	observerMemberIds?: string[];
	discussionAiEnabled?: boolean;
	modelSelection?: ModelSelection | null;
	collaboratorIds?: string[];
	visibility?: MatterVisibility;
	title?: string;
	collaborationMode?: MatterCollaborationMode;
	coordinatorMemberId?: string | null;
}): Promise<{
	matter: MatterDto;
	assignedMember: TeamMemberDto;
	mode?: MatterSendMode;
	aiDiscussionTriggered?: boolean;
	aiDiscussionSkippedReason?: string;
}> {
	return requestJson(input.mode === "conversation" ? "/api/matters/conversation" : "/api/matters", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function postMatterMessage(
	matterId: string,
	input: {
		mode?: MatterSendMode;
		prompt: string;
		images?: UploadImagePayload[];
		files?: UploadFilePayload[];
		preferredMemberId?: string;
		observerMemberIds?: string[];
	},
): Promise<{
	accepted: boolean;
	mode?: MatterSendMode;
	message?: MatterMessageDto;
	matter?: MatterDto;
	aiDiscussionTriggered?: boolean;
	aiDiscussionSkippedReason?: string;
}> {
	const suffix = input.mode === "conversation" ? "/messages/conversation" : "/messages";
	return requestJson(`/api/matters/${encodeURIComponent(matterId)}${suffix}`, {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function approveAiRequest(
	matterId: string,
	messageId: string,
	input?: { preferredMemberId?: string; observerMemberIds?: string[] },
): Promise<{ accepted: boolean; matterId: string; approvedMessageId: string }> {
	return requestJson(
		`/api/matters/${encodeURIComponent(matterId)}/messages/${encodeURIComponent(messageId)}/approve-ai`,
		{
			method: "POST",
			body: JSON.stringify(input ?? {}),
		},
	);
}

export function dismissAiRequest(
	matterId: string,
	messageId: string,
): Promise<{ ok: boolean; message?: MatterMessageDto }> {
	return requestJson(
		`/api/matters/${encodeURIComponent(matterId)}/messages/${encodeURIComponent(messageId)}/dismiss-ai`,
		{
			method: "POST",
			body: "{}",
		},
	);
}

export function respondToDialog(
	dialogId: string,
	payload: { confirmed?: boolean; value?: string; cancelled?: true },
): Promise<{ ok: boolean }> {
	return requestJson(`/api/dialogs/${encodeURIComponent(dialogId)}/respond`, {
		method: "POST",
		body: JSON.stringify(payload),
	});
}

export function abortMatter(matterId: string): Promise<{ ok: boolean; aborted: boolean }> {
	return requestJson(`/api/matters/${encodeURIComponent(matterId)}/abort`, {
		method: "POST",
		body: "{}",
	});
}

export function updateMatterWorkspace(matterId: string, workspaceId: string | null): Promise<{ matter: MatterDto }> {
	return requestJson(`/api/matters/${encodeURIComponent(matterId)}`, {
		method: "PATCH",
		body: JSON.stringify({ workspaceId }),
	});
}

export function updateMatterOrganization(matterId: string, orgId: string | null): Promise<{ matter: MatterDto }> {
	return requestJson(`/api/matters/${encodeURIComponent(matterId)}`, {
		method: "PATCH",
		body: JSON.stringify({ orgId }),
	});
}

export function updateMatterObservers(matterId: string, observerMemberIds: string[]): Promise<{ matter: MatterDto }> {
	return requestJson(`/api/matters/${encodeURIComponent(matterId)}`, {
		method: "PATCH",
		body: JSON.stringify({ observerMemberIds }),
	});
}

export function updateMatterModelSelection(
	matterId: string,
	modelSelection: ModelSelection | null,
): Promise<{ matter: MatterDto }> {
	return requestJson(`/api/matters/${encodeURIComponent(matterId)}`, {
		method: "PATCH",
		body: JSON.stringify({ modelSelection }),
	});
}

export function updateMatterLead(matterId: string, leadMemberId: string): Promise<{ matter: MatterDto }> {
	return requestJson(`/api/matters/${encodeURIComponent(matterId)}`, {
		method: "PATCH",
		body: JSON.stringify({ leadMemberId }),
	});
}

export function updateMatterAiMembers(matterId: string, aiMemberIds: string[] | null): Promise<{ matter: MatterDto }> {
	return requestJson(`/api/matters/${encodeURIComponent(matterId)}`, {
		method: "PATCH",
		body: JSON.stringify({ aiMemberIds }),
	});
}

export function updateMatterConsultMembers(
	matterId: string,
	consultMemberIds: string[] | null,
): Promise<{ matter: MatterDto }> {
	return requestJson(`/api/matters/${encodeURIComponent(matterId)}`, {
		method: "PATCH",
		body: JSON.stringify({ consultMemberIds }),
	});
}

export function updateMatterObserversEnabled(
	matterId: string,
	observersEnabled: boolean,
): Promise<{ matter: MatterDto }> {
	return requestJson(`/api/matters/${encodeURIComponent(matterId)}`, {
		method: "PATCH",
		body: JSON.stringify({ observersEnabled }),
	});
}

export function updateMatterCollaborators(matterId: string, collaboratorIds: string[]): Promise<{ matter: MatterDto }> {
	return requestJson(`/api/matters/${encodeURIComponent(matterId)}`, {
		method: "PATCH",
		body: JSON.stringify({ collaboratorIds }),
	});
}

export function updateMatterVisibility(matterId: string, visibility: MatterVisibility): Promise<{ matter: MatterDto }> {
	return requestJson(`/api/matters/${encodeURIComponent(matterId)}`, {
		method: "PATCH",
		body: JSON.stringify({ visibility }),
	});
}

export function updateMatterStatus(matterId: string, status: "archived" | "open"): Promise<{ matter: MatterDto }> {
	return requestJson(`/api/matters/${encodeURIComponent(matterId)}`, {
		method: "PATCH",
		body: JSON.stringify({ status }),
	});
}

export function updateMatterCollaborationMode(
	matterId: string,
	collaborationMode: MatterCollaborationMode,
	coordinatorMemberId?: string | null,
): Promise<{ matter: MatterDto }> {
	return requestJson(`/api/matters/${encodeURIComponent(matterId)}`, {
		method: "PATCH",
		body: JSON.stringify({
			collaborationMode,
			...(coordinatorMemberId !== undefined ? { coordinatorMemberId } : {}),
		}),
	});
}
