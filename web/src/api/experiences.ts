import { requestJson } from "./client.ts";
import type { DeliverableDto, FeedbackRating } from "./deliverables.ts";
import type { MatterDto } from "./matters.ts";
import type { TeamMemberDto } from "./team.ts";

export type MemoryScope = "role_general" | "company_private" | "project_private";

export type MemoryStatus = "candidate" | "verified" | "superseded" | "rejected";

export type MemoryCategory =
	| "general"
	| "efficiency"
	| "troubleshooting"
	| "collaboration"
	| "user_correction"
	| "domain_constraint";

export type MemoryApplicationOutcome =
	| "applied"
	| "turn_succeeded"
	| "turn_failed"
	| "feedback_positive"
	| "feedback_negative";

export interface MemberMemoryDto {
	id: string;
	memberId: string;
	scope: MemoryScope;
	category: MemoryCategory;
	orgId: string | null;
	workspaceId: string | null;
	content: string;
	rationale?: string;
	sourceMatterId?: string | null;
	sourceDeliverableId?: string | null;
	status: MemoryStatus;
	verified: boolean;
	supersededBy?: string | null;
	supersedesMemoryId?: string | null;
	appliedCount: number;
	positiveCount: number;
	negativeCount: number;
	lastAppliedAt?: string | null;
	createdAt: string;
	updatedAt?: string;
}

export interface MemoryApplicationDto {
	id: string;
	memoryId: string;
	matterId: string;
	memberId: string;
	deliverableId: string | null;
	documentId: string | null;
	commitHash: string | null;
	actorId: string | null;
	outcome: MemoryApplicationOutcome;
	note: string;
	createdAt: string;
}

export function saveMemberMemory(input: {
	memberId: string;
	content: string;
	scope?: MemoryScope;
	category?: MemoryCategory;
	orgId?: string | null;
	workspaceId?: string | null;
	sourceMatterId?: string;
	sourceDeliverableId?: string;
	rationale?: string;
	status?: MemoryStatus;
	verified?: boolean;
	supersedesMemoryId?: string;
}): Promise<{ memory: MemberMemoryDto }> {
	return requestJson("/api/memories", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function updateMemberMemory(
	memoryId: string,
	input: {
		memberId?: string;
		content?: string;
		scope?: MemoryScope;
		category?: MemoryCategory;
		orgId?: string | null;
		workspaceId?: string | null;
		status?: MemoryStatus;
		rationale?: string;
		supersedesMemoryId?: string | null;
	},
): Promise<{ memory: MemberMemoryDto }> {
	return requestJson(`/api/memories/${encodeURIComponent(memoryId)}`, {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export function evaluateMemberMemory(
	memoryId: string,
	input: {
		outcome: "positive" | "negative";
		note?: string;
		matterId?: string;
	},
): Promise<{ memory: MemberMemoryDto }> {
	return requestJson(`/api/memories/${encodeURIComponent(memoryId)}/evaluate`, {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function fetchMemoryApplications(memoryId: string): Promise<{
	memory: MemberMemoryDto;
	applications: MemoryApplicationDto[];
}> {
	return requestJson(`/api/memories/${encodeURIComponent(memoryId)}/applications`);
}

export interface DistillRsiResult {
	ok: boolean;
	aborted?: boolean;
	matter?: MatterDto;
	member?: TeamMemberDto;
	deliverable?: DeliverableDto | null;
	createdMemories: MemberMemoryDto[];
	skippedDuplicates: number;
	summary: string;
	participatingMemberIds?: string[];
}

export function distillRsiExperiences(
	input: {
		matterId: string;
		deliverableId?: string;
		memberId?: string;
		feedback?: string;
		rating?: FeedbackRating;
		scopeMode?: "team" | "single";
	},
	signal?: AbortSignal,
): Promise<DistillRsiResult> {
	return requestJson("/api/rsi/distill", {
		method: "POST",
		body: JSON.stringify(input),
		signal,
	});
}

export function abortRsiDistillation(matterId: string): Promise<{ ok: boolean; aborted: boolean }> {
	return requestJson("/api/rsi/distill/abort", {
		method: "POST",
		body: JSON.stringify({ matterId }),
	});
}
