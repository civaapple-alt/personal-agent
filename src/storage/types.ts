import type { ThinkingLevel } from "../rpc/types.ts";

export type MemoryScope = "role_general" | "company_private" | "project_private";
export type MemoryStatus = "candidate" | "verified" | "rejected" | "superseded";
export type MemoryCategory =
	| "general"
	| "efficiency"
	| "troubleshooting"
	| "collaboration"
	| "user_correction"
	| "domain_constraint";
export type FeedbackRating = "positive" | "negative" | "neutral";
export type MemoryApplicationOutcome =
	| "applied"
	| "turn_succeeded"
	| "turn_failed"
	| "feedback_positive"
	| "feedback_negative";
export type MatterStatus = "open" | "waiting_user" | "delivered" | "archived";
export type MatterMessageChannel = "user" | "internal_collab" | "notice";
export type MatterMessageSenderType = "user" | "member" | "system";
export type DeliverableType = "document" | "artifact" | "prototype_image" | "service_url";
export type CollaboratorRole = "owner" | "collaborator";

export interface Collaborator {
	id: string;
	orgId: string | null;
	name: string;
	roleTitle: string;
	permissionRole: CollaboratorRole;
	token: string;
	createdAt: string;
	updatedAt: string;
}

export type PublicCollaborator = Omit<Collaborator, "token">;

export interface Organization {
	id: string;
	name: string;
	gitEmailDomain: string;
	description: string;
	isDefault: boolean;
	createdAt: string;
	updatedAt: string;
}

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
	gitName: string;
	gitEmail: string;
	identitySummary: string;
	createdAt: string;
	updatedAt: string;
}

export interface MemberMemory {
	id: string;
	memberId: string;
	scope: MemoryScope;
	category: MemoryCategory;
	orgId: string | null;
	workspaceId: string | null;
	content: string;
	rationale: string;
	sourceMatterId: string | null;
	sourceDeliverableId: string | null;
	status: MemoryStatus;
	verified: boolean;
	supersededBy: string | null;
	supersedesMemoryId: string | null;
	appliedCount: number;
	positiveCount: number;
	negativeCount: number;
	lastAppliedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface MemoryApplicationRecord {
	id: string;
	memoryId: string;
	matterId: string;
	memberId: string;
	deliverableId: string | null;
	outcome: MemoryApplicationOutcome;
	note: string;
	createdAt: string;
}

export interface WorkspaceLink {
	id: string;
	orgId: string | null;
	name: string;
	repoPath: string;
	defaultBranch: string;
	description: string;
	repoGitUser?: { name: string; email: string } | null;
	createdAt: string;
}

export interface Matter {
	id: string;
	title: string;
	summary: string;
	status: MatterStatus;
	leadMemberId: string | null;
	workspaceId: string | null;
	orgId: string | null;
	aiMemberIds: string[] | null;
	observersEnabled: boolean;
	observerMemberIds: string[];
	collaboratorIds: string[];
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
	feedbackRating: FeedbackRating | null;
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
