import type { InnerMatterGuide } from "../../../src/demo/inner-matter-definition.ts";
import { requestJson } from "./client.ts";
import type { DeliverableDto } from "./deliverables.ts";
import type { ModelSelection } from "./models.ts";
import type { RoleInteractionStyle, RoleWorkspaceScope, TeamMemberDto } from "./team.ts";

export type MatterVisibility = "org" | "private";

export type MatterSendMode = "discussion" | "dispatch" | "ai_request";

export interface MatterDto {
	id: string;
	title: string;
	summary: string;
	status: "open" | "waiting_user" | "delivered" | "archived";
	leadMemberId: string | null;
	workspaceId: string | null;
	orgId?: string | null;
	createdByUserId?: string | null;
	visibility?: MatterVisibility;
	aiMemberIds?: string[] | null;
	consultMemberIds?: string[] | null;
	observersEnabled?: boolean;
	observerMemberIds?: string[];
	discussionAiEnabled?: boolean;
	modelSelection?: ModelSelection | null;
	collaboratorIds?: string[];
	createdAt: string;
	updatedAt: string;
}

export interface MessageImageDto {
	url?: string;
	mimeType: string;
	name?: string;
}

export interface UploadImagePayload {
	data: string;
	mimeType: string;
	name?: string;
}

export interface ComposerImageAttachment extends UploadImagePayload {
	id: string;
	name: string;
	previewUrl: string;
	sizeBytes: number;
}

export interface MessageFileDto {
	url?: string;
	kind?: "file" | "pasted_text";
	name: string;
	mimeType: string;
	sizeBytes?: number;
	lineCount?: number;
	charCount?: number;
	previewText?: string;
}

export interface UploadFilePayload {
	kind: "file" | "pasted_text";
	name: string;
	mimeType: string;
	content: string;
}

export interface ComposerFileAttachment extends UploadFilePayload {
	id: string;
	sizeBytes: number;
	lineCount: number;
	charCount: number;
	previewText: string;
}

export interface MatterMessageDto {
	id: string;
	matterId: string;
	channel: "user" | "internal_collab" | "notice";
	senderType: "user" | "member" | "system";
	senderId: string;
	content: string;
	metadata?: Record<string, unknown> | null;
	createdAt: string;
}

export interface PendingDialogDto {
	id: string;
	matterId: string;
	memberId: string;
	memberName: string;
	request: {
		id: string;
		method: "select" | "confirm" | "input" | "editor";
		title: string;
		message?: string;
		options?: string[];
		placeholder?: string;
		prefill?: string;
	};
	createdAt: string;
}

export type CollaborationPresetMode = "solo" | "lead_consult" | "lead_review" | "human_first";

export type RoleFitStatus = "matched" | "ambiguous" | "gap_detected";

export interface MatterInitiationCandidateDto {
	memberId: string;
	displayName: string;
	roleTitle: string;
	score: number;
	matchedSignals: string[];
	tools: string[];
}

export interface RoleGapSuggestionDto {
	missingRoleTitle: string;
	suggestedJob: string;
	suggestedAntiJobs: string[];
	suggestedInteractionStyle: RoleInteractionStyle;
	suggestedWorkspaceScope: RoleWorkspaceScope;
	reason: string;
}

export type InitiationAssessmentSource = "rules" | "model";

export type DecisionConfidence = "high" | "medium" | "low";

export interface MatterInitiationAssessmentDto {
	fitStatus: RoleFitStatus;
	headline: string;
	explanation: string;
	recommendedMode: CollaborationPresetMode;
	recommendedLeadId: string | null;
	recommendedAiMemberIds: string[];
	recommendedConsultIds?: string[];
	recommendedObserverIds: string[];
	candidates: MatterInitiationCandidateDto[];
	gapSuggestion?: RoleGapSuggestionDto;
	assessmentSource?: InitiationAssessmentSource;
	confidence?: DecisionConfidence;
	repoReadEnabled?: boolean;
	repoReadPaths?: string[];
	usedRepoRead?: boolean;
}

export interface ActiveDelegationDto {
	memberId: string;
	memberName: string;
	stageLabel: string;
	fromMemberId?: string;
	fromMemberName?: string;
	requestMessageId?: string;
	parentRequestMessageId?: string;
	delegationNumber?: number;
	kind?: "delegation" | "observer";
}

export interface ProgressActivityDto {
	memberName: string;
	summary: string;
	at: string;
}

export interface MatterProgressDto {
	matterId: string;
	stage: "starting" | "thinking" | "tool" | "waiting_user" | "finalizing";
	label: string;
	toolName?: string;
	toolSummary?: string;
	activeDelegations?: ActiveDelegationDto[];
	recentLogs?: ProgressActivityDto[];
	collabUpdated?: boolean;
	sourceUserMessageId?: string;
	speakerMemberId?: string;
}

export interface ProgressSnapshotDto {
	outcome: "failed" | "aborted";
	stage: MatterProgressDto["stage"];
	label: string;
	toolName?: string;
	toolSummary?: string;
	startedAt: string;
	capturedAt: string;
	elapsedSeconds: number;
	activeDelegations?: ActiveDelegationDto[];
	recentLogs?: ProgressActivityDto[];
	leadMemberId?: string;
	leadMemberName?: string;
}

export interface ActiveRunSnapshotDto extends MatterProgressDto {
	startedAt: number;
	streamingDelta?: string;
}

export interface MatterDetailPayload {
	demoGuide?: InnerMatterGuide;
	matter: MatterDto;
	userMessages: MatterMessageDto[];
	internalCollabMessages: MatterMessageDto[];
	noticeMessages: MatterMessageDto[];
	deliverables: DeliverableDto[];
	pendingDialogs: PendingDialogDto[];
	activeRun?: ActiveRunSnapshotDto | null;
}

export function fetchMatterDetail(matterId: string): Promise<MatterDetailPayload> {
	return requestJson<MatterDetailPayload>(`/api/matters/${encodeURIComponent(matterId)}`);
}

export function openInnerMatterDemo(): Promise<{ matter: MatterDto }> {
	return requestJson("/api/demos/inner-matter", { method: "POST", body: "{}" });
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
}): Promise<{
	matter: MatterDto;
	assignedMember: TeamMemberDto;
	aiDiscussionTriggered?: boolean;
	aiDiscussionSkippedReason?: string;
}> {
	return requestJson("/api/matters", {
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
	return requestJson(`/api/matters/${encodeURIComponent(matterId)}/messages`, {
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

export function updateMatterDiscussionAiEnabled(
	matterId: string,
	discussionAiEnabled: boolean,
): Promise<{ matter: MatterDto }> {
	return requestJson(`/api/matters/${encodeURIComponent(matterId)}`, {
		method: "PATCH",
		body: JSON.stringify({ discussionAiEnabled }),
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
