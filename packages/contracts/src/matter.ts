import type { ModelSelection } from "./model-selection.ts";
import type { SpaceDocumentMetaDto, SpaceDto } from "./space.ts";
import type { CollaborationPresetMode, RoleInteractionStyle, RoleWorkspaceScope } from "./team.ts";

export type MatterStatus = "open" | "waiting_user" | "archived";
export type MatterVisibility = "org" | "private";
export type MatterSendMode = "conversation" | "discussion" | "dispatch" | "ai_request";
export type MatterMessageChannel = "user" | "internal_collab" | "notice";
export type MatterMessageSenderType = "user" | "member" | "system";
export type MatterCollaborationMode = "lead" | "board";
export type MatterMessageKind = "chat" | "ai_request" | "human_decision" | "observer" | "system_summary";
export type MatterDecisionStatus = "pending" | "approved" | "dismissed" | "answered";

/** Shared wire contract for a Matter record across server storage/HTTP and web UI. */
export interface MatterDto {
	id: string;
	title: string;
	summary: string;
	status: MatterStatus;
	leadMemberId: string | null;
	collaborationMode?: MatterCollaborationMode;
	coordinatorMemberId?: string | null;
	workspaceId: string | null;
	orgId: string | null;
	createdByUserId?: string | null;
	visibility?: MatterVisibility;
	aiMemberIds: string[] | null;
	consultMemberIds?: string[] | null;
	observersEnabled: boolean;
	observerMemberIds: string[];
	discussionAiEnabled?: boolean;
	modelSelection?: ModelSelection | null;
	collaboratorIds: string[];
	createdAt: string;
	updatedAt: string;
}

/** Shared wire contract for a persisted Matter message across server and web UI. */
export interface MatterMessageDto {
	id: string;
	matterId: string;
	channel: MatterMessageChannel;
	senderType: MatterMessageSenderType;
	senderId: string;
	kind?: MatterMessageKind;
	decisionStatus?: MatterDecisionStatus | null;
	boardPostNo?: number | null;
	content: string;
	metadata: Record<string, unknown> | null;
	createdAt: string;
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

export type RoleFitStatus = "matched" | "ambiguous" | "gap_detected";
export type InitiationAssessmentSource = "rules" | "model";
export type DecisionConfidence = "high" | "medium" | "low";

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
	verification?: true;
	kind?: "delegation" | "observer";
}

export interface ProgressActivityDto {
	memberName: string;
	memberId?: string;
	toolCallId?: string;
	toolName?: string;
	toolStatus?: "running" | "success" | "error" | "unknown";
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
	stalledMembers?: Array<{
		memberId: string;
		memberName: string;
		assignmentNumber?: number;
		lastActivityAt: string;
		lastAction: string;
	}>;
	sourceUserMessageId?: string;
	speakerMemberId?: string;
}

export interface ProgressSnapshotDto {
	outcome: "completed" | "failed" | "aborted";
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

export type HumanDecisionAction =
	| { action: "answer"; revision: number; answer: string }
	| { action: "assign"; revision: number; assignedUserId: string }
	| { action: "resume"; revision: number };

export interface MatterDetailPayload {
	matter: MatterDto;
	userMessages: MatterMessageDto[];
	internalCollabMessages: MatterMessageDto[];
	noticeMessages: MatterMessageDto[];
	defaultSpace?: SpaceDto | null;
	spaceDocuments?: SpaceDocumentMetaDto[];
	pendingDialogs: PendingDialogDto[];
	activeRun?: ActiveRunSnapshotDto | null;
}
