import type { DatabaseSync } from "node:sqlite";
import { CollaboratorRepo } from "./repos/collaborator-repo.ts";
import { DeliverableRepo, type RecordDeliverableInput } from "./repos/deliverable-repo.ts";
import { MatterRepo } from "./repos/matter-repo.ts";
import { MemberRepo } from "./repos/member-repo.ts";
import { type AddMemoryInput, MemoryRepo } from "./repos/memory-repo.ts";
import { OrgRbacRepo } from "./repos/org-rbac-repo.ts";
import { OrganizationRepo } from "./repos/organization-repo.ts";
import { SessionRepo } from "./repos/session-repo.ts";
import { SpacePageRepo } from "./repos/space-page-repo.ts";
import { SpaceRepo } from "./repos/space-repo.ts";
import { UserAuthRepo } from "./repos/user-auth-repo.ts";
import { WorkspaceFolderRepo } from "./repos/workspace-folder-repo.ts";
import { WorkspaceRepo } from "./repos/workspace-repo.ts";
import { SpaceGitStore } from "./space-git-store.ts";

export {
	DEFAULT_LOCAL_ADMIN_USER_ID,
	DEFAULT_ORGANIZATION_ID,
	DEFAULT_ORGANIZATION_NAME,
	DEFAULT_OWNER_COLLABORATOR_ID,
	defaultMemberGitName,
	MemoryValidationError,
	normalizeMemoryCategory,
	resolveEffectiveGitIdentity,
	slugifyOrganizationName,
	toPublicCollaborator,
	toPublicUser,
} from "./repos/helpers.ts";
export { WorkspaceMutationError } from "./repos/workspace-repo.ts";

/** Unified SQLite store facade delegating to domain-focused repositories. */
export class PersonalAgentStore {
	private readonly members: MemberRepo;
	private readonly orgs: OrganizationRepo;
	private readonly workspaces: WorkspaceRepo;
	private readonly collaborators: CollaboratorRepo;
	private readonly memories: MemoryRepo;
	private readonly deliverables: DeliverableRepo;
	private readonly matters: MatterRepo;
	private readonly sessions: SessionRepo;
	private readonly userAuth: UserAuthRepo;
	private readonly orgRbac: OrgRbacRepo;
	readonly spacePages: SpacePageRepo;
	readonly spaces: SpaceRepo;
	readonly workspaceFolders: WorkspaceFolderRepo;

	constructor(db: DatabaseSync, options?: { spacesDir?: string }) {
		this.spacePages = new SpacePageRepo(db);
		this.spaces = new SpaceRepo(db, new SpaceGitStore(options?.spacesDir));
		this.workspaceFolders = new WorkspaceFolderRepo(db);
		this.members = new MemberRepo(db);
		this.orgs = new OrganizationRepo(db);
		this.workspaces = new WorkspaceRepo(db, this.orgs);
		this.collaborators = new CollaboratorRepo(db, this.orgs);
		this.memories = new MemoryRepo({
			db,
			memberRepo: this.members,
			workspaceRepo: this.workspaces,
			getDeliverable: (id) => this.deliverables.getDeliverable(id),
		});
		this.deliverables = new DeliverableRepo(db, this.memories);
		this.matters = new MatterRepo(db, this.members, this.orgs, this.workspaces);
		this.sessions = new SessionRepo(db);
		this.userAuth = new UserAuthRepo(db);
		this.orgRbac = new OrgRbacRepo(db, this.members);
	}

	// ---- Members ----
	upsertMember(input: Parameters<MemberRepo["upsertMember"]>[0]) {
		return this.members.upsertMember(input);
	}
	updateMemberIdentity(memberId: string, patch: Parameters<MemberRepo["updateMemberIdentity"]>[1]) {
		return this.members.updateMemberIdentity(memberId, patch);
	}
	getMember(id: string) {
		return this.members.getMember(id);
	}
	listMembers() {
		return this.members.listMembers();
	}
	getPrimaryContact() {
		return this.members.getPrimaryContact();
	}
	setPrimaryContact(memberId: string) {
		return this.members.setPrimaryContact(memberId);
	}
	deleteMember(memberId: string) {
		return this.members.deleteMember(memberId);
	}
	countPersonalRoles(userId: string) {
		return this.members.countPersonalRoles(userId);
	}
	isRoleTemplateRemoved(templateId: string) {
		return this.members.isRoleTemplateRemoved(templateId);
	}

	// ---- Memories ----
	addMemory(input: AddMemoryInput) {
		return this.memories.addMemory(input);
	}
	getMemory(id: string) {
		return this.memories.getMemory(id);
	}
	findActiveDuplicateMemory(
		memberId: string,
		scope: Parameters<MemoryRepo["findActiveDuplicateMemory"]>[1],
		workspaceId: string | null,
		content: string,
		orgId: string | null = null,
	) {
		return this.memories.findActiveDuplicateMemory(memberId, scope, workspaceId, content, orgId);
	}
	updateMemory(id: string, patch: Parameters<MemoryRepo["updateMemory"]>[1]) {
		return this.memories.updateMemory(id, patch);
	}
	validateMemoryReplacement(
		replacement: Parameters<MemoryRepo["validateMemoryReplacement"]>[0],
		targetId: string | null,
	) {
		return this.memories.validateMemoryReplacement(replacement, targetId);
	}
	listRelevantMemories(
		memberId: string,
		workspaceId: string | null,
		options?: Parameters<MemoryRepo["listRelevantMemories"]>[2],
	) {
		return this.memories.listRelevantMemories(memberId, workspaceId, options);
	}
	listMemberMemories(memberId: string) {
		return this.memories.listMemberMemories(memberId);
	}
	recordMemoryApplications(input: Parameters<MemoryRepo["recordMemoryApplications"]>[0]) {
		return this.memories.recordMemoryApplications(input);
	}
	evaluateMemory(input: Parameters<MemoryRepo["evaluateMemory"]>[0]) {
		return this.memories.evaluateMemory(input);
	}
	clearDeliverableMemoryFeedback(deliverableId: string) {
		return this.memories.clearDeliverableMemoryFeedback(deliverableId);
	}
	evaluateMatterMemories(input: Parameters<MemoryRepo["evaluateMatterMemories"]>[0]) {
		return this.memories.evaluateMatterMemories(input);
	}
	listMemoryApplications(memoryId: string, limit?: number) {
		return this.memories.listMemoryApplications(memoryId, limit);
	}

	// ---- Organizations & Workspaces ----
	upsertOrganization(input: Parameters<OrganizationRepo["upsertOrganization"]>[0]) {
		return this.orgs.upsertOrganization(input);
	}
	updateOrganization(id: string, patch: Parameters<OrganizationRepo["updateOrganization"]>[1]) {
		return this.orgs.updateOrganization(id, patch);
	}
	setDefaultOrganization(id: string) {
		return this.orgs.setDefaultOrganization(id);
	}
	getDefaultOrganization() {
		return this.orgs.getDefaultOrganization();
	}
	ensureDefaultOrganization() {
		return this.orgs.ensureDefaultOrganization();
	}
	assignOrphanWorkspacesToDefaultOrganization() {
		return this.workspaces.assignOrphanWorkspacesToDefaultOrganization();
	}
	getOrganization(id: string) {
		return this.orgs.getOrganization(id);
	}
	listOrganizations() {
		return this.orgs.listOrganizations();
	}
	upsertWorkspace(input: Parameters<WorkspaceRepo["upsertWorkspace"]>[0]) {
		return this.workspaces.upsertWorkspace(input);
	}
	updateWorkspace(id: string, patch: Parameters<WorkspaceRepo["updateWorkspace"]>[1]) {
		return this.workspaces.updateWorkspace(id, patch);
	}
	getWorkspace(id: string) {
		return this.workspaces.getWorkspace(id);
	}
	listWorkspaces() {
		return this.workspaces.listWorkspaces();
	}
	hasWorkspaceScopeConflict(workspaceId: string) {
		return this.workspaces.hasWorkspaceScopeConflict(workspaceId);
	}

	// ---- Collaborators ----
	ensureOwnerCollaborator(defaultName?: string) {
		return this.collaborators.ensureOwnerCollaborator(defaultName);
	}
	upsertCollaborator(input: Parameters<CollaboratorRepo["upsertCollaborator"]>[0]) {
		return this.collaborators.upsertCollaborator(input);
	}
	regenerateCollaboratorToken(id: string) {
		return this.collaborators.regenerateCollaboratorToken(id);
	}
	deleteCollaborator(id: string) {
		return this.collaborators.deleteCollaborator(id);
	}
	getCollaborator(id: string) {
		return this.collaborators.getCollaborator(id);
	}
	getCollaboratorByToken(token: string) {
		return this.collaborators.getCollaboratorByToken(token);
	}
	listCollaborators(orgId?: string) {
		return this.collaborators.listCollaborators(orgId);
	}

	// ---- Matters & Messages ----
	createMatter(input: Parameters<MatterRepo["createMatter"]>[0]) {
		return this.matters.createMatter(input);
	}
	getMatter(id: string) {
		return this.matters.getMatter(id);
	}
	listMatters() {
		return this.matters.listMatters();
	}
	updateMatterStatus(matterId: string, status: Parameters<MatterRepo["updateMatterStatus"]>[1], summary?: string) {
		return this.matters.updateMatterStatus(matterId, status, summary);
	}
	updateMatterWorkspace(matterId: string, workspaceId: string | null) {
		return this.matters.updateMatterWorkspace(matterId, workspaceId);
	}
	updateMatterOrganization(matterId: string, orgId: string | null) {
		return this.matters.updateMatterOrganization(matterId, orgId);
	}
	updateMatterObservers(matterId: string, observerMemberIds: string[]) {
		return this.matters.updateMatterObservers(matterId, observerMemberIds);
	}
	updateMatterObserversEnabled(matterId: string, enabled: boolean) {
		return this.matters.updateMatterObserversEnabled(matterId, enabled);
	}
	updateMatterAiMembers(matterId: string, aiMemberIds: string[] | null) {
		return this.matters.updateMatterAiMembers(matterId, aiMemberIds);
	}
	updateMatterConsultMembers(matterId: string, consultMemberIds: string[] | null) {
		return this.matters.updateMatterConsultMembers(matterId, consultMemberIds);
	}
	updateMatterDiscussionAiEnabled(matterId: string, enabled: boolean) {
		return this.matters.updateMatterDiscussionAiEnabled(matterId, enabled);
	}
	updateMatterCollaborators(matterId: string, collaboratorIds: string[]) {
		return this.matters.updateMatterCollaborators(matterId, collaboratorIds);
	}
	addMatterCollaborator(matterId: string, collaboratorId: string) {
		return this.matters.addMatterCollaborator(matterId, collaboratorId);
	}
	updateMatterLead(matterId: string, memberId: string) {
		return this.matters.updateMatterLead(matterId, memberId);
	}
	getMessage(messageId: string) {
		return this.matters.getMessage(messageId);
	}
	updateMessageMetadata(messageId: string, metadata: Record<string, unknown>) {
		return this.matters.updateMessageMetadata(messageId, metadata);
	}
	transitionAiRequest(...args: Parameters<MatterRepo["transitionAiRequest"]>) {
		return this.matters.transitionAiRequest(...args);
	}
	transitionHumanDecision(...args: Parameters<MatterRepo["transitionHumanDecision"]>) {
		return this.matters.transitionHumanDecision(...args);
	}
	appendMessage(input: Parameters<MatterRepo["appendMessage"]>[0]) {
		return this.matters.appendMessage(input);
	}
	listMessages(matterId: string, channel?: Parameters<MatterRepo["listMessages"]>[1]) {
		return this.matters.listMessages(matterId, channel);
	}

	// ---- Deliverables ----
	recordDeliverable(input: RecordDeliverableInput) {
		return this.deliverables.recordDeliverable(input);
	}
	recordDeliverables(inputs: RecordDeliverableInput[]) {
		return this.deliverables.recordDeliverables(inputs);
	}
	recordTurnOutcome(input: Parameters<DeliverableRepo["recordTurnOutcome"]>[0]) {
		return this.deliverables.recordTurnOutcome(input);
	}
	linkDeliverableApplications(deliverableId: string, applicationIds: string[]) {
		return this.deliverables.linkDeliverableApplications(deliverableId, applicationIds);
	}
	getDeliverable(id: string) {
		return this.deliverables.getDeliverable(id);
	}
	listDeliverables(matterId?: string) {
		return this.deliverables.listDeliverables(matterId);
	}
	recordDeliverableFeedback(
		deliverableId: string,
		feedback: string,
		rating?: Parameters<DeliverableRepo["recordDeliverableFeedback"]>[2],
	) {
		return this.deliverables.recordDeliverableFeedback(deliverableId, feedback, rating);
	}
	addDeliverableFeedback(
		deliverableId: string,
		feedback: string,
		rating?: Parameters<DeliverableRepo["addDeliverableFeedback"]>[2],
	) {
		return this.deliverables.addDeliverableFeedback(deliverableId, feedback, rating);
	}

	// ---- Worker Sessions & Leases ----
	recordWorkerSession(input: Parameters<SessionRepo["recordWorkerSession"]>[0]) {
		return this.sessions.recordWorkerSession(input);
	}
	findWorkerSession(matterId: string, memberId: string, contextKey: string, workspaceId: string | null) {
		return this.sessions.findWorkerSession(matterId, memberId, contextKey, workspaceId);
	}
	finishWorkerSession(id: string, status: "idle" | "closed") {
		return this.sessions.finishWorkerSession(id, status);
	}
	hasLiveMatterLease(matterId: string) {
		return this.sessions.hasLiveMatterLease(matterId);
	}
	acquireMatterLease(matterId: string, ownerId: string) {
		return this.sessions.acquireMatterLease(matterId, ownerId);
	}
	releaseMatterLease(matterId: string, ownerId: string) {
		return this.sessions.releaseMatterLease(matterId, ownerId);
	}

	// ---- Platform Users, Sessions, Settings & Audit ----
	ensureLocalBootstrapAdmin(defaultName?: string) {
		return this.userAuth.ensureLocalBootstrapAdmin(defaultName);
	}
	hasPasswordedAdmin() {
		return this.userAuth.hasPasswordedAdmin();
	}
	setupInitialAdmin(input: Parameters<UserAuthRepo["setupInitialAdmin"]>[0]) {
		return this.userAuth.setupInitialAdmin(input);
	}
	createUser(input: Parameters<UserAuthRepo["createUser"]>[0]) {
		return this.userAuth.createUser(input);
	}
	authenticateUser(email: string, password: string) {
		return this.userAuth.authenticateUser(email, password);
	}
	getUserById(id: string) {
		return this.userAuth.getUserById(id);
	}
	getUserByEmail(email: string) {
		return this.userAuth.getUserByEmail(email);
	}
	listUsers() {
		return this.userAuth.listUsers();
	}
	updateUser(userId: string, patch: Parameters<UserAuthRepo["updateUser"]>[1]) {
		return this.userAuth.updateUser(userId, patch);
	}
	createSession(userId: string, meta?: Parameters<UserAuthRepo["createSession"]>[1]) {
		return this.userAuth.createSession(userId, meta);
	}
	getSessionAndUserByToken(rawToken: string) {
		return this.userAuth.getSessionAndUserByToken(rawToken);
	}
	getSessionAndUserByHash(sessionHash: string) {
		return this.userAuth.getSessionAndUserByHash(sessionHash);
	}
	revokeSessionByToken(rawToken: string) {
		return this.userAuth.revokeSessionByToken(rawToken);
	}
	revokeAllUserSessions(userId: string) {
		return this.userAuth.revokeAllUserSessions(userId);
	}
	getPlatformSettings(defaultWorkspacesRoot?: string) {
		return this.userAuth.getPlatformSettings(defaultWorkspacesRoot);
	}
	updatePlatformSettings(
		patch: Parameters<UserAuthRepo["updatePlatformSettings"]>[0],
		defaultWorkspacesRoot?: string,
	) {
		return this.userAuth.updatePlatformSettings(patch, defaultWorkspacesRoot);
	}
	recordAuditLog(input: Parameters<UserAuthRepo["recordAuditLog"]>[0]) {
		return this.userAuth.recordAuditLog(input);
	}
	listAuditLogs(options?: Parameters<UserAuthRepo["listAuditLogs"]>[0]) {
		return this.userAuth.listAuditLogs(options);
	}

	// ---- Organization Members, Invites, Org AI Roles, Workspace & Upload ACL ----
	upsertOrgMember(input: Parameters<OrgRbacRepo["upsertOrgMember"]>[0]) {
		return this.orgRbac.upsertOrgMember(input);
	}
	removeOrgMember(orgId: string, userId: string) {
		return this.orgRbac.removeOrgMember(orgId, userId);
	}
	getOrgMembership(orgId: string, userId: string) {
		return this.orgRbac.getOrgMembership(orgId, userId);
	}
	listOrgMembers(orgId: string) {
		return this.orgRbac.listOrgMembers(orgId);
	}
	listUserOrganizations(userId: string) {
		return this.orgRbac.listUserOrganizations(userId);
	}
	countOwnedOrganizations(userId: string) {
		return this.orgRbac.countOwnedOrganizations(userId);
	}
	createOrgInvite(input: Parameters<OrgRbacRepo["createOrgInvite"]>[0]) {
		return this.orgRbac.createOrgInvite(input);
	}
	listOrgInvites(orgId: string) {
		return this.orgRbac.listOrgInvites(orgId);
	}
	revokeOrgInvite(orgId: string, inviteId: string) {
		return this.orgRbac.revokeOrgInvite(orgId, inviteId);
	}
	peekOrgInviteByToken(rawToken: string) {
		return this.orgRbac.peekOrgInviteByToken(rawToken);
	}
	consumeOrgInviteByToken(rawToken: string, userId: string) {
		return this.orgRbac.consumeOrgInviteByToken(rawToken, userId);
	}
	hasOrgAiRolesConfigured(orgId: string) {
		return this.orgRbac.hasOrgAiRolesConfigured(orgId);
	}

	enableNewGlobalRolesForOrg(orgId: string, memberIds: string[]) {
		this.orgRbac.enableNewGlobalRolesForOrg(orgId, memberIds);
	}
	listOrgAiRoleConfigs(orgId: string) {
		return this.orgRbac.listOrgAiRoleConfigs(orgId);
	}
	setOrgAiPrimaryContact(orgId: string, memberId: string) {
		return this.orgRbac.setOrgAiPrimaryContact(orgId, memberId);
	}

	setOrgAiRolesBatch(
		orgId: string,
		roles: Parameters<OrgRbacRepo["setOrgAiRolesBatch"]>[1],
		useRoleGitIdentity?: boolean,
	) {
		return this.orgRbac.setOrgAiRolesBatch(orgId, roles, useRoleGitIdentity);
	}
	resolveEffectiveOrgMembers(orgId: string) {
		return this.orgRbac.resolveEffectiveOrgMembers(orgId);
	}
	resolveEffectiveOrgMembersForUser(orgId: string, userId?: string | null) {
		return this.orgRbac.resolveEffectiveOrgMembersForUser(orgId, userId);
	}
	resolveMemberForOrg(orgId: string | null | undefined, member: Parameters<OrgRbacRepo["resolveMemberForOrg"]>[1]) {
		return this.orgRbac.resolveMemberForOrg(orgId, member);
	}
	setWorkspaceAccess(
		workspaceId: string,
		visibility: Parameters<WorkspaceRepo["setWorkspaceAccess"]>[1],
		allowedUserIds: string[],
	) {
		return this.workspaces.setWorkspaceAccess(workspaceId, visibility, allowedUserIds);
	}
	listWorkspaceMemberIds(workspaceId: string) {
		return this.workspaces.listWorkspaceMemberIds(workspaceId);
	}
	isWorkspaceMember(workspaceId: string, userId: string) {
		return this.workspaces.isWorkspaceMember(workspaceId, userId);
	}
	recordUpload(input: Parameters<OrgRbacRepo["recordUpload"]>[0]) {
		return this.orgRbac.recordUpload(input);
	}
	getUploadRecord(filename: string) {
		return this.orgRbac.getUploadRecord(filename);
	}
	findLegacyUploadMatterId(filename: string) {
		return this.orgRbac.findLegacyUploadMatterId(filename);
	}
	updateMatterModelSelection(...args: Parameters<MatterRepo["updateMatterModelSelection"]>) {
		return this.matters.updateMatterModelSelection(...args);
	}

	updateMatterVisibility(matterId: string, visibility: Parameters<MatterRepo["updateMatterVisibility"]>[1]) {
		return this.matters.updateMatterVisibility(matterId, visibility);
	}
}
