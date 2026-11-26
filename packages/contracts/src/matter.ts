import type { ModelSelection } from "./model-selection.ts";

export type MatterStatus = "open" | "waiting_user" | "archived";
export type MatterVisibility = "org" | "private";
export type MatterSendMode = "conversation" | "discussion" | "dispatch" | "ai_request";
export type MatterMessageChannel = "user" | "internal_collab" | "notice";
export type MatterMessageSenderType = "user" | "member" | "system";

/** Shared wire contract for a Matter record across server storage/HTTP and web UI. */
export interface MatterDto {
	id: string;
	title: string;
	summary: string;
	status: MatterStatus;
	leadMemberId: string | null;
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
	content: string;
	metadata: Record<string, unknown> | null;
	createdAt: string;
}
