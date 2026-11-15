export interface TeamMemberDto {
	id: string;
	templateId: string;
	displayName: string;
	roleTitle: string;
	isPrimaryContact: boolean;
	provider: string;
	model: string;
	thinkingLevel: string;
	keywords: string[];
}

export interface WorkspaceDto {
	id: string;
	name: string;
	repoPath: string;
	defaultBranch: string;
	description: string;
}

export interface MatterDto {
	id: string;
	title: string;
	summary: string;
	status: "open" | "waiting_user" | "delivered" | "archived";
	leadMemberId: string | null;
	workspaceId: string | null;
	observerMemberIds?: string[];
	createdAt: string;
	updatedAt: string;
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

export type FeedbackRating = "positive" | "negative" | "neutral";
export type MemoryScope = "role_general" | "company_private" | "project_private";
export type MemoryStatus = "candidate" | "verified" | "superseded" | "rejected";
export type MemoryApplicationOutcome =
	| "applied"
	| "turn_succeeded"
	| "turn_failed"
	| "feedback_positive"
	| "feedback_negative";

export interface DeliverableDto {
	id: string;
	matterId: string;
	memberId: string;
	type: "document" | "artifact" | "prototype_image" | "service_url";
	title: string;
	summary: string;
	contentOrPath: string;
	serviceUrl: string | null;
	version: number;
	feedback: string | null;
	feedbackRating?: FeedbackRating | null;
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

export interface PreviewServiceDto {
	id: string;
	title: string;
	url: string;
	port: number;
	cwd: string;
	status: "starting" | "running" | "stopped" | "failed";
	deliverableId: string | null;
}

export interface MemberMemoryDto {
	id: string;
	memberId: string;
	scope: MemoryScope;
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
	outcome: MemoryApplicationOutcome;
	note: string;
	createdAt: string;
}

export interface RoleTemplateDto {
	id: string;
	name: string;
	title: string;
	version: string;
	skills: string[];
	tools: string[];
	keywords: string[];
	shareable: boolean;
	responsibilities: string;
}

export interface ActiveDelegationDto {
	memberId: string;
	memberName: string;
	stageLabel: string;
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

export interface BootstrapPayload {
	members: TeamMemberDto[];
	templates: RoleTemplateDto[];
	workspaces: WorkspaceDto[];
	matters: MatterDto[];
	deliverables: DeliverableDto[];
	pendingDialogs: PendingDialogDto[];
	previews: PreviewServiceDto[];
	memoriesByMember: Record<string, MemberMemoryDto[]>;
	activeRuns?: Record<string, ActiveRunSnapshotDto>;
}

export interface MatterDetailPayload {
	matter: MatterDto;
	userMessages: MatterMessageDto[];
	internalCollabMessages: MatterMessageDto[];
	noticeMessages: MatterMessageDto[];
	deliverables: DeliverableDto[];
	pendingDialogs: PendingDialogDto[];
	activeRun?: ActiveRunSnapshotDto | null;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, {
		...init,
		headers: {
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	const data = (await res.json()) as T & { error?: string };
	if (!res.ok) {
		throw new Error(data.error ?? `Request failed (${res.status})`);
	}
	return data;
}

export function fetchBootstrap(): Promise<BootstrapPayload> {
	return requestJson<BootstrapPayload>("/api/bootstrap");
}

export function fetchMatterDetail(matterId: string): Promise<MatterDetailPayload> {
	return requestJson<MatterDetailPayload>(`/api/matters/${encodeURIComponent(matterId)}`);
}

export function createMatter(input: {
	prompt: string;
	preferredMemberId?: string;
	workspaceId?: string;
	observerMemberIds?: string[];
	title?: string;
}): Promise<{ matter: MatterDto; assignedMember: TeamMemberDto }> {
	return requestJson("/api/matters", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function postMatterMessage(
	matterId: string,
	input: { prompt: string; preferredMemberId?: string; observerMemberIds?: string[] },
): Promise<{ accepted: boolean }> {
	return requestJson(`/api/matters/${encodeURIComponent(matterId)}/messages`, {
		method: "POST",
		body: JSON.stringify(input),
	});
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

export interface DeliverableFeedbackResult {
	ok: boolean;
	deliverableId: string;
	feedback: string;
	rating: FeedbackRating | null;
	evaluatedMemoryIds: string[];
	distilledMemories: MemberMemoryDto[];
}

export function submitDeliverableFeedback(
	deliverableId: string,
	payload:
		| string
		| {
				feedback?: string;
				rating?: FeedbackRating;
				autoDistill?: boolean;
		  },
): Promise<DeliverableFeedbackResult> {
	const body = typeof payload === "string" ? { feedback: payload } : payload;
	return requestJson(`/api/deliverables/${encodeURIComponent(deliverableId)}/feedback`, {
		method: "POST",
		body: JSON.stringify(body),
	});
}

export function addWorkspace(input: {
	name: string;
	repoPath: string;
	defaultBranch?: string;
	description?: string;
}): Promise<{ workspace: WorkspaceDto }> {
	return requestJson("/api/workspaces", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function stopPreview(previewId: string): Promise<{ preview: PreviewServiceDto }> {
	return requestJson(`/api/previews/${encodeURIComponent(previewId)}/stop`, {
		method: "POST",
		body: "{}",
	});
}

export function createMember(input: {
	name: string;
	title: string;
	responsibilities?: string;
	keywords?: string[];
	skills?: string[];
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	isPrimaryContact?: boolean;
}): Promise<{ member: TeamMemberDto }> {
	return requestJson("/api/members", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function setPrimaryMember(memberId: string): Promise<{ member: TeamMemberDto }> {
	return requestJson(`/api/members/${encodeURIComponent(memberId)}/primary`, {
		method: "POST",
		body: "{}",
	});
}

export function exportMemberPackage(memberId: string): Promise<{
	id: string;
	filename: string;
	markdown: string;
}> {
	return requestJson(`/api/members/${encodeURIComponent(memberId)}/export`);
}

export function importMemberPackage(markdown: string): Promise<{ member: TeamMemberDto }> {
	return requestJson("/api/members/import", {
		method: "POST",
		body: JSON.stringify({ markdown }),
	});
}

export function saveMemberMemory(input: {
	memberId: string;
	content: string;
	scope?: MemoryScope;
	workspaceId?: string;
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
		content?: string;
		scope?: MemoryScope;
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
	matter: MatterDto;
	member: TeamMemberDto;
	deliverable: DeliverableDto | null;
	createdMemories: MemberMemoryDto[];
	skippedDuplicates: number;
	summary: string;
}

export function distillRsiExperiences(input: {
	matterId: string;
	deliverableId?: string;
	memberId?: string;
	feedback?: string;
	rating?: FeedbackRating;
}): Promise<DistillRsiResult> {
	return requestJson("/api/rsi/distill", {
		method: "POST",
		body: JSON.stringify(input),
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

export function updateMatterObservers(matterId: string, observerMemberIds: string[]): Promise<{ matter: MatterDto }> {
	return requestJson(`/api/matters/${encodeURIComponent(matterId)}`, {
		method: "PATCH",
		body: JSON.stringify({ observerMemberIds }),
	});
}
