import type { ThinkingLevel } from "../rpc/types.ts";

export type MemoryScope = "role_general" | "company_private" | "project_private";
export type MatterStatus = "open" | "waiting_user" | "delivered" | "archived";
export type MatterMessageChannel = "user" | "internal_collab" | "notice";
export type MatterMessageSenderType = "user" | "member" | "system";
export type DeliverableType = "document" | "artifact" | "prototype_image" | "service_url";

export interface TeamMember {
	id: string;
	templateId: string;
	displayName: string;
	roleTitle: string;
	isPrimaryContact: boolean;
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	keywords: string[];
	createdAt: string;
	updatedAt: string;
}

export interface MemberMemory {
	id: string;
	memberId: string;
	scope: MemoryScope;
	workspaceId: string | null;
	content: string;
	sourceMatterId: string | null;
	verified: boolean;
	createdAt: string;
}

export interface WorkspaceLink {
	id: string;
	name: string;
	repoPath: string;
	defaultBranch: string;
	description: string;
	createdAt: string;
}

export interface Matter {
	id: string;
	title: string;
	summary: string;
	status: MatterStatus;
	leadMemberId: string | null;
	workspaceId: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface MatterMessage {
	id: string;
	matterId: string;
	channel: MatterMessageChannel;
	senderType: MatterMessageSenderType;
	senderId: string;
	content: string;
	metadata: Record<string, unknown> | null;
	createdAt: string;
}

export interface Deliverable {
	id: string;
	matterId: string;
	memberId: string;
	type: DeliverableType;
	title: string;
	summary: string;
	contentOrPath: string;
	serviceUrl: string | null;
	version: number;
	feedback: string | null;
	createdAt: string;
}

export interface WorkerSessionRecord {
	messageCursor: string | null;
	id: string;
	memberId: string;
	matterId: string;
	workspaceId: string | null;
	piSessionId: string | null;
	sessionFile: string | null;
	status: "active" | "idle" | "closed";
	lastActiveAt: string;
}
