import type { InnerMatterGuide, InnerMatterStep } from "../../src/demo/inner-matter-definition.ts";
export type { InnerMatterGuide, InnerMatterStep };

export type PlatformRole = "super_admin" | "user";
export type UserStatus = "active" | "pending_review" | "disabled";
export type OrgMemberRole = "org_owner" | "org_admin" | "org_member" | "org_viewer";
export type RegistrationMode = "open_auto" | "open_review" | "invite_only";
export type WorkspaceSourceType = "local" | "cloned";
export type WorkspaceVisibility = "org" | "restricted";
export type MatterVisibility = "org" | "private";

export interface AccountUserDto {
	id: string;
	email: string;
	displayName: string;
	platformRole: PlatformRole;
	status: UserStatus;
	maxOrgs: number;
	maxActiveDispatches: number;
	canDispatchAi: boolean;
	createdAt: string;
	updatedAt: string;
	lastLoginAt: string | null;
}

export interface PlatformSettingsDto {
	registrationMode: RegistrationMode;
	workspacesRoot: string;
	allowLocalWorkspacePath: boolean;
	localWorkspaceAllowlist: string[];
	allowCommandPreviews: boolean;
	defaultMaxOrgs: number;
	defaultMaxActiveDispatches: number;
	pstackDir?: string | null;
	updatedAt: string;
}

export interface OrganizationMemberDto {
	orgId: string;
	userId: string;
	orgRole: OrgMemberRole;
	roleTitle: string;
	createdAt: string;
	updatedAt: string;
	email?: string;
	displayName?: string;
	userStatus?: UserStatus;
}

export interface OrganizationInviteDto {
	id: string;
	orgId: string;
	orgRole: OrgMemberRole;
	createdByUserId: string;
	maxUses: number;
	usedCount: number;
	expiresAt: string | null;
	revokedAt: string | null;
	createdAt: string;
}

export interface OrganizationAiRoleConfigDto {
	orgId: string;
	memberId: string;
	enabled: boolean;
	isPrimaryContact: boolean;
	displayNameOverride: string | null;
	modelOverride: string | null;
	updatedAt: string;
}

export interface AuditLogEntryDto {
	id: string;
	actorUserId: string | null;
	actorEmail: string | null;
	action: string;
	targetType: string;
	targetId: string | null;
	orgId: string | null;
	detail: Record<string, unknown> | null;
	ipAddress: string | null;
	createdAt: string;
}

export interface OrganizationDto {
	id: string;
	name: string;
	slug?: string;
	gitEmailDomain: string;
	description: string;
	isDefault?: boolean;
	workspacesDir?: string | null;
	createdByUserId?: string | null;
	orgRole?: OrgMemberRole;
	createdAt: string;
	updatedAt: string;
}

export interface TeamMemberDto {
	id: string;
	templateId: string;
	displayName: string;
	roleTitle: string;
	isPrimaryContact: boolean;
	ownerOrgId?: string | null;
	provider: string;
	model: string;
	thinkingLevel: string;
	keywords: string[];
	gitName: string;
	gitEmail: string;
	identitySummary: string;
}

export interface WorkspaceDto {
	id: string;
	orgId: string | null;
	name: string;
	repoPath: string;
	defaultBranch: string;
	description: string;
	sourceType?: "local" | "clone" | WorkspaceSourceType;
	cloneUrl?: string | null;
	visibility?: WorkspaceVisibility;
	allowedUserIds?: string[];
	repoGitUser?: { name: string; email: string } | null;
}

export type CollaboratorRole = "owner" | "collaborator";

export interface CollaboratorDto {
	id: string;
	name: string;
	roleTitle: string;
	permissionRole: CollaboratorRole;
	orgId: string | null;
	token?: string;
	createdAt: string;
	updatedAt: string;
}

let authRevokedHandler: ((message?: string) => void) | null = null;

export function setAuthRevokedHandler(handler: ((message?: string) => void) | null): void {
	authRevokedHandler = handler;
}

export interface AuthSessionPayload {
	authenticated: boolean;
	requireAuth?: boolean;
	permissionRequired: boolean;
	revokedSession?: boolean;
	pendingApproval?: boolean;
	needsAdminSetup?: boolean;
	registrationMode?: RegistrationMode;
	authKind?: "session" | "legacy_token" | "loopback" | null;
	currentUser: CollaboratorDto | null;
	accountUser?: AccountUserDto | null;
}

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
	observersEnabled?: boolean;
	observerMemberIds?: string[];
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

export type FeedbackRating = "positive" | "negative" | "neutral";
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
	outcome: MemoryApplicationOutcome;
	note: string;
	createdAt: string;
}

export type CollaborationPresetMode = "solo" | "lead_consult" | "lead_review" | "human_first";
export type RoleFitStatus = "matched" | "ambiguous" | "gap_detected";
export type RoleInteractionStyle = "lead_direct" | "consult_specialist" | "risk_observer" | "mixed";
export type RoleWorkspaceScope = "read_write_code" | "read_only_repo" | "no_repo_docs";

export interface RoleTemplateDto {
	id: string;
	name: string;
	title: string;
	roleKind?: "business" | "architect";
	version: string;
	skills: string[];
	mcpDependencies?: string[];
	tools: string[];
	keywords: string[];
	shareable: boolean;
	antiJobs?: string[];
	responsibilities: string;
}

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
	recommendedObserverIds: string[];
	candidates: MatterInitiationCandidateDto[];
	gapSuggestion?: RoleGapSuggestionDto;
	assessmentSource?: InitiationAssessmentSource;
	confidence?: DecisionConfidence;
	repoReadEnabled?: boolean;
	repoReadPaths?: string[];
	usedRepoRead?: boolean;
}

export interface RoleArchitectDraftDto {
	template: RoleTemplateDto & {
		defaultProvider: string;
		defaultModel: string;
		thinkingLevel: string;
		isPrimaryContact: boolean;
		sections: Record<string, string>;
	};
	markdown: string;
	antiJobs: string[];
	toolSummary: string;
	recommendedParticipation: RoleInteractionStyle;
	designNotes: string[];
	capabilityReport?: {
		skills: Array<{ name: string; state: "file_present" | "missing" }>;
		mcpDependencies: Array<{ name: string; state: "runtime_check_required" }>;
	};
	verificationPlanState?: "specified" | "missing";
	designSource?: "rules" | "model";
}

export interface MetaArchitectMessageDto {
	role: "user" | "assistant";
	content: string;
}

export interface MetaArchitectBlueprintProposalDto {
	draft: RoleArchitectDraftDto;
	rationale: string;
}

export interface MetaArchitectFormationSuggestionDto {
	mode: CollaborationPresetMode;
	existingMemberIds: string[];
	observerMemberIds: string[];
	rationale: string;
}

export interface MetaArchitectHealthFindingDto {
	status: "ok" | "warn";
	title: string;
	detail: string;
	evidence?: Array<{
		id: string;
		kind: "role" | "message" | "feedback" | "memory";
		sourceId: string;
		matterId?: string;
		label: string;
		excerpt: string;
	}>;
}

export interface MetaArchitectRoleAdjustmentDto {
	memberId: string;
	memberName: string;
	currentTools: string[];
	suggestedTools?: string[];
	addAntiJobs?: string[];
	workflowNote?: string;
	rationale: string;
}

export interface MetaArchitectChatResultDto {
	reply: string;
	followUpQuestions: string[];
	healthFindings?: MetaArchitectHealthFindingDto[];
	roleAdjustments?: MetaArchitectRoleAdjustmentDto[];
	blueprints: MetaArchitectBlueprintProposalDto[];
	recommendedFormation?: MetaArchitectFormationSuggestionDto;
	usedHealthcheck: boolean;
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
	innerDemoAvailable?: boolean;
	authKind?: "session" | "legacy_token" | "loopback" | null;
	currentUser?: CollaboratorDto;
	accountUser?: AccountUserDto | null;
	platformPolicy?: {
		registrationMode: RegistrationMode;
		allowLocalWorkspacePath: boolean;
		allowCommandPreviews: boolean;
	};
	collaborators?: CollaboratorDto[];
	members: TeamMemberDto[];
	templates: RoleTemplateDto[];
	workspaces: WorkspaceDto[];
	organizations: OrganizationDto[];
	orgMembersByOrgId?: Record<string, OrganizationMemberDto[]>;
	orgAiRolesByOrgId?: Record<
		string,
		{
			configured: boolean;
			configs: OrganizationAiRoleConfigDto[];
			effectiveMemberIds: string[];
		}
	>;
	matters: MatterDto[];
	deliverables: DeliverableDto[];
	pendingDialogs: PendingDialogDto[];
	previews: PreviewServiceDto[];
	memoriesByMember: Record<string, MemberMemoryDto[]>;
	activeRuns?: Record<string, ActiveRunSnapshotDto>;
}

export interface AdminUserRowDto extends AccountUserDto {
	ownedOrgCount: number;
	orgMemberships: OrganizationMemberDto[];
}

export interface AdminOverviewPayload {
	settings: PlatformSettingsDto;
	users: AdminUserRowDto[];
	organizations: OrganizationDto[];
	activeRuns: Array<{ matterId: string; title: string; label: string; startedAt: number }>;
	auditLogs: AuditLogEntryDto[];
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
		if (
			res.status === 401 &&
			url !== "/api/auth/login" &&
			url !== "/api/auth/register" &&
			url !== "/api/auth/setup-admin" &&
			url !== "/api/auth/session"
		) {
			authRevokedHandler?.(data.error ?? "当前登录态已失效或无访问权限，请重新登录");
		}
		throw new Error(data.error ?? `Request failed (${res.status})`);
	}
	return data;
}

export interface OrgInvitePreviewDto {
	valid: boolean;
	reason?: string;
	orgId?: string;
	orgName?: string;
	orgRole?: OrgMemberRole;
	alreadyMember?: boolean;
	existingRole?: OrgMemberRole | null;
}

export function fetchAuthSession(): Promise<AuthSessionPayload> {
	return requestJson<AuthSessionPayload>("/api/auth/session");
}

export function fetchOrgInvitePreview(token: string): Promise<OrgInvitePreviewDto> {
	return requestJson<OrgInvitePreviewDto>(`/api/auth/invite-preview?token=${encodeURIComponent(token)}`);
}

export function setupInitialAdmin(input: {
	email: string;
	password: string;
	displayName: string;
}): Promise<{ ok: boolean; accountUser: AccountUserDto }> {
	return requestJson("/api/auth/setup-admin", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function registerWithEmail(input: {
	email: string;
	password: string;
	displayName: string;
	inviteToken?: string;
}): Promise<{ ok: boolean; pendingApproval?: boolean; accountUser: AccountUserDto }> {
	return requestJson("/api/auth/register", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function loginWithEmail(input: { email: string; password: string; inviteToken?: string }): Promise<{
	ok: boolean;
	pendingApproval?: boolean;
	joinedOrgId?: string | null;
	accountUser?: AccountUserDto;
}> {
	return requestJson("/api/auth/login", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function loginWithInviteToken(token: string): Promise<{ ok: boolean; currentUser: CollaboratorDto }> {
	return requestJson("/api/auth/login", {
		method: "POST",
		body: JSON.stringify({ token }),
	});
}

export function changeAccountPassword(input: {
	currentPassword: string;
	newPassword: string;
}): Promise<{ ok: boolean }> {
	return requestJson("/api/auth/change-password", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function logoutAuthSession(): Promise<{ ok: boolean }> {
	return requestJson("/api/auth/logout", {
		method: "POST",
		body: "{}",
	});
}

export function fetchBootstrap(): Promise<BootstrapPayload> {
	return requestJson<BootstrapPayload>("/api/bootstrap");
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
	observersEnabled?: boolean;
	observerMemberIds?: string[];
	collaboratorIds?: string[];
	visibility?: MatterVisibility;
	title?: string;
}): Promise<{ matter: MatterDto; assignedMember: TeamMemberDto }> {
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
): Promise<{ accepted: boolean; mode?: MatterSendMode; message?: MatterMessageDto; matter?: MatterDto }> {
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

export interface DeliverableFeedbackResult {
	ok: boolean;
	deliverableId: string;
	feedback: string;
	rating: FeedbackRating | null;
	evaluatedMemoryIds: string[];
	distilledMemories: MemberMemoryDto[];
	distillationError?: string;
}

export function submitDeliverableFeedback(
	deliverableId: string,
	payload:
		| string
		| {
				feedback?: string;
				rating?: FeedbackRating;
				autoDistill?: boolean;
				scopeMode?: "team" | "single";
		  },
): Promise<DeliverableFeedbackResult> {
	const body = typeof payload === "string" ? { feedback: payload } : payload;
	return requestJson(`/api/deliverables/${encodeURIComponent(deliverableId)}/feedback`, {
		method: "POST",
		body: JSON.stringify(body),
	});
}

export function createOrganization(input: {
	id?: string;
	name: string;
	gitEmailDomain?: string;
	description?: string;
	aiMemberIds?: string[];
	primaryAiMemberId?: string;
}): Promise<{ organization: OrganizationDto }> {
	return requestJson("/api/organizations", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function updateOrganization(
	orgId: string,
	input: { name?: string; gitEmailDomain?: string; description?: string; isDefault?: boolean },
): Promise<{ organization: OrganizationDto }> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}`, {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export function setDefaultOrganization(orgId: string): Promise<{ organization: OrganizationDto }> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}/default`, {
		method: "POST",
	});
}

export function addWorkspace(input: {
	orgId?: string | null;
	name: string;
	sourceType?: "local" | "clone" | WorkspaceSourceType;
	cloneUrl?: string;
	repoPath?: string;
	defaultBranch?: string;
	description?: string;
	visibility?: WorkspaceVisibility;
	allowedUserIds?: string[];
}): Promise<{ workspace: WorkspaceDto }> {
	return requestJson("/api/workspaces", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function updateWorkspace(
	workspaceId: string,
	input: {
		orgId?: string | null;
		name?: string;
		defaultBranch?: string;
		description?: string;
		visibility?: WorkspaceVisibility;
		allowedUserIds?: string[];
	},
): Promise<{ workspace: WorkspaceDto }> {
	return requestJson(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export function stopPreview(previewId: string): Promise<{ preview: PreviewServiceDto }> {
	return requestJson(`/api/previews/${encodeURIComponent(previewId)}/stop`, {
		method: "POST",
		body: "{}",
	});
}

export function designRoleDraft(
	input: {
		oneJob: string;
		antiJobs?: string[];
		quietWhen?: string;
		interactionStyle?: RoleInteractionStyle;
		workspaceScope?: RoleWorkspaceScope;
		roleName?: string;
		roleTitle?: string;
		keywords?: string[];
		workflowRules?: string;
		constraints?: string;
		skills?: string[];
		mcpDependencies?: string[];
		communicationStyle?: string;
		verificationPlan?: string | { task: string; successCriteria: string; boundaryCheck: string };
		isPrimaryContact?: boolean;
		mode?: "rules" | "model";
	},
	signal?: AbortSignal,
): Promise<RoleArchitectDraftDto> {
	return requestJson("/api/members/design", {
		method: "POST",
		body: JSON.stringify(input),
		signal,
	});
}

export function chatWithRoleArchitect(
	input: {
		messages: MetaArchitectMessageDto[];
		matterPrompt?: string;
		workspaceId?: string | null;
		includeHealthcheck?: boolean;
	},
	signal?: AbortSignal,
): Promise<MetaArchitectChatResultDto> {
	return requestJson("/api/members/architect/chat", {
		method: "POST",
		body: JSON.stringify(input),
		signal,
	});
}

export interface CreateMemberPayload {
	id?: string;
	name: string;
	title: string;
	responsibilities?: string;
	keywords?: string[];
	skills?: string[];
	mcpDependencies?: string[];
	tools?: string[];
	antiJobs?: string[];
	sections?: Record<string, string>;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	isPrimaryContact?: boolean;
	gitName?: string;
	gitEmail?: string;
	identitySummary?: string;
}

export function createMember(input: CreateMemberPayload): Promise<{ member: TeamMemberDto }> {
	return requestJson("/api/members", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function createMembersBatch(members: CreateMemberPayload[]): Promise<{ members: TeamMemberDto[] }> {
	return requestJson("/api/members/batch", {
		method: "POST",
		body: JSON.stringify({ members }),
	});
}

export interface ApplyMemberAdjustmentPayload {
	memberId: string;
	tools?: string[];
	addAntiJobs?: string[];
	workflowNote?: string;
}

export function applyMemberAdjustments(
	adjustments: ApplyMemberAdjustmentPayload[],
): Promise<{ members: TeamMemberDto[] }> {
	return requestJson("/api/members/adjustments/apply", {
		method: "POST",
		body: JSON.stringify({ adjustments }),
	});
}

export interface ApplyMatterRoleProposalsPayload {
	action?: "apply" | "dismiss";
	members?: CreateMemberPayload[];
	adjustments?: ApplyMemberAdjustmentPayload[];
	matterJoinMode?: "none" | "consult" | "observer" | "lead";
}

export function applyMatterRoleProposals(
	matterId: string,
	messageId: string,
	input: ApplyMatterRoleProposalsPayload,
): Promise<{
	ok: boolean;
	createdMembers: TeamMemberDto[];
	updatedMembers: TeamMemberDto[];
	message: MatterMessageDto | null;
	matter: MatterDto;
}> {
	return requestJson(
		`/api/matters/${encodeURIComponent(matterId)}/messages/${encodeURIComponent(messageId)}/apply-role-proposals`,
		{
			method: "POST",
			body: JSON.stringify(input),
		},
	);
}

export function updateMemberIdentity(
	memberId: string,
	input: {
		displayName?: string;
		roleTitle?: string;
		gitName?: string;
		gitEmail?: string;
		identitySummary?: string;
	},
): Promise<{ member: TeamMemberDto }> {
	return requestJson(`/api/members/${encodeURIComponent(memberId)}`, {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export function setPrimaryMember(memberId: string): Promise<{ member: TeamMemberDto }> {
	return requestJson(`/api/members/${encodeURIComponent(memberId)}/primary`, {
		method: "POST",
		body: "{}",
	});
}

export function deleteMember(memberId: string): Promise<{ ok: boolean; deletedMemberId: string }> {
	return requestJson(`/api/members/${encodeURIComponent(memberId)}`, {
		method: "DELETE",
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

export function joinOrganizationByInvite(
	inviteToken: string,
): Promise<{ ok: boolean; organization: OrganizationDto; membership: OrganizationMemberDto }> {
	return requestJson("/api/organizations/join", {
		method: "POST",
		body: JSON.stringify({ inviteToken }),
	});
}

export function fetchOrgMembers(orgId: string): Promise<{ members: OrganizationMemberDto[] }> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}/members`);
}

export function addOrgMember(
	orgId: string,
	input: { email?: string; userId?: string; orgRole: OrgMemberRole; roleTitle?: string },
): Promise<{ member: OrganizationMemberDto }> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}/members`, {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function updateOrgMember(
	orgId: string,
	userId: string,
	input: { orgRole?: OrgMemberRole; roleTitle?: string },
): Promise<{ member: OrganizationMemberDto }> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export function removeOrgMember(orgId: string, userId: string): Promise<{ ok: boolean }> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, {
		method: "DELETE",
	});
}

export function fetchOrgInvites(orgId: string): Promise<{ invites: OrganizationInviteDto[] }> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}/invites`);
}

export function createOrgInvite(
	orgId: string,
	input: { orgRole: OrgMemberRole; maxUses?: number; expiresInHours?: number },
): Promise<{ invite: OrganizationInviteDto; rawToken: string }> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}/invites`, {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function revokeOrgInvite(orgId: string, inviteId: string): Promise<{ invite: OrganizationInviteDto }> {
	return requestJson(
		`/api/organizations/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}/revoke`,
		{ method: "POST", body: "{}" },
	);
}

export function updateOrgAiRoles(
	orgId: string,
	roles: Array<{
		memberId: string;
		enabled: boolean;
		isPrimaryContact?: boolean;
		displayNameOverride?: string | null;
		modelOverride?: string | null;
	}>,
): Promise<{
	configs: OrganizationAiRoleConfigDto[];
	effectiveMembers: TeamMemberDto[];
}> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}/ai-roles`, {
		method: "PUT",
		body: JSON.stringify({ roles }),
	});
}

export function fetchAdminOverview(): Promise<AdminOverviewPayload> {
	return requestJson("/api/admin/overview");
}

export function updateAdminSettings(
	input: Partial<{
		registrationMode: RegistrationMode;
		workspacesRoot: string;
		allowLocalWorkspacePath: boolean;
		localWorkspaceAllowlist: string[];
		allowCommandPreviews: boolean;
		defaultMaxOrgs: number;
		defaultMaxActiveDispatches: number;
	}>,
): Promise<{ settings: PlatformSettingsDto }> {
	return requestJson("/api/admin/settings", {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export function updateAdminUser(
	userId: string,
	input: Partial<{
		displayName: string;
		platformRole: PlatformRole;
		status: UserStatus;
		maxOrgs: number;
		maxActiveDispatches: number;
		canDispatchAi: boolean;
	}>,
): Promise<{ user: AccountUserDto }> {
	return requestJson(`/api/admin/users/${encodeURIComponent(userId)}`, {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export function abortAdminMatter(matterId: string): Promise<{ ok: boolean; aborted: boolean }> {
	return requestJson(`/api/admin/matters/${encodeURIComponent(matterId)}/abort`, {
		method: "POST",
		body: "{}",
	});
}

export function createCollaborator(input: {
	id?: string;
	name: string;
	roleTitle?: string;
	permissionRole?: CollaboratorRole;
	orgId?: string | null;
}): Promise<{ collaborator: CollaboratorDto }> {
	return requestJson("/api/collaborators", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function updateCollaborator(
	id: string,
	input: { name?: string; roleTitle?: string; permissionRole?: CollaboratorRole; orgId?: string | null },
): Promise<{ collaborator: CollaboratorDto }> {
	return requestJson(`/api/collaborators/${encodeURIComponent(id)}`, {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export function regenerateCollaboratorToken(id: string): Promise<{ collaborator: CollaboratorDto }> {
	return requestJson(`/api/collaborators/${encodeURIComponent(id)}/regenerate-token`, {
		method: "POST",
		body: "{}",
	});
}

export function deleteCollaborator(id: string): Promise<{ ok: boolean }> {
	return requestJson(`/api/collaborators/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
}

export type RuntimeExtensionSourceKind = "builtin" | "builtin_conditional" | "pi_builtin" | "operator_env";
export type RuntimeExtensionStatus = "active" | "conditional" | "inactive" | "error";
export type RuntimeExtensionFileStatus = "present" | "missing" | "builtin" | "unknown";

export interface RuntimeExtensionDto {
	id: string;
	name: string;
	sourceKind: RuntimeExtensionSourceKind;
	status: RuntimeExtensionStatus;
	entryPath: string | null;
	fileStatus: RuntimeExtensionFileStatus;
	scopeSummary: string;
	description: string;
	registeredTools: string[];
	hooks: string[];
	declaredByRoles: string[];
	mcpServers: string[];
	error?: string | null;
}

export interface RuntimeIsolationModeDto {
	id: "worker" | "decision" | "architect" | "distill";
	label: string;
	usage: string;
	sessionStrategy: string;
	extensionsPolicy: string;
	toolsPolicy: string;
}

export interface RuntimeBaseInfoDto {
	name: string;
	executable: string;
	transport: string;
	available: boolean;
	version: string | null;
	probeError: string | null;
	nodeVersion: string;
	platform: string;
	pathsRedacted: boolean;
	sessionMode: "persisted" | "no_session";
	sessionDir: string | null;
	defaultCwd: string | null;
	pstack: {
		configured: boolean;
		available: boolean;
		root: string | null;
		version: string | null;
		modeSha256: string | null;
		skillCount: number;
		error: string | null;
		source?: "env" | "settings" | "none";
		defaultCloneUrl?: string;
	};
	isolationModes: RuntimeIsolationModeDto[];
	envFlags: {
		turnTimeoutMs: number;
		promptTimeoutMs: number;
		idleTimeoutMs: number;
		customExtensionsEnvConfigured: boolean;
		pstackDirEnvConfigured: boolean;
	};
}

export interface RuntimeConfigItemDto {
	key: string;
	label: string;
	value: string;
	defaultValue?: string;
	overridden?: boolean;
}

export interface RuntimeConfigSectionDto {
	id: "env" | "paths" | "rpc" | "orchestrator";
	title: string;
	items: RuntimeConfigItemDto[];
}

export interface RuntimeOverviewDto {
	base: RuntimeBaseInfoDto;
	extensions: RuntimeExtensionDto[];
	configSections: RuntimeConfigSectionDto[];
	summary: {
		activeCount: number;
		conditionalCount: number;
		operatorCount: number;
		inactiveCount: number;
		errorCount: number;
	};
	checkedAt: string;
}

export function fetchRuntimeOverview(): Promise<RuntimeOverviewDto> {
	return requestJson("/api/runtime");
}

export function enableRuntimePstack(input?: { cloneUrl?: string; update?: boolean }): Promise<{
	source: "cloned" | "updated" | "existing";
	repoPath: string;
	settings: PlatformSettingsDto;
	overview: RuntimeOverviewDto;
}> {
	return requestJson("/api/admin/runtime/pstack/enable", {
		method: "POST",
		body: JSON.stringify(input ?? {}),
	});
}

export function disableRuntimePstack(): Promise<{
	settings: PlatformSettingsDto;
	overview: RuntimeOverviewDto;
}> {
	return requestJson("/api/admin/runtime/pstack/disable", {
		method: "POST",
		body: JSON.stringify({}),
	});
}
