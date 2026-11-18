import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { resolveRepoGitUserIdentity } from "../../orchestrator/execution-context.ts";
import type { PiCliProbeResult, ServerRuntimeConfig } from "../../orchestrator/runtime-info.ts";
import type { TeamOrchestrator } from "../../orchestrator/team-orchestrator.ts";
import { DEFAULT_OWNER_COLLABORATOR_ID, type PersonalAgentStore } from "../../storage/repositories.ts";
import type { MemoryCategory, WorkspaceLink } from "../../storage/types.ts";
import { canAccessOrganization, canAccessWorkspace, canManageOrganization } from "../acl.ts";
import { extractClientIp, isSuperAdminActor, type RequestActor } from "../auth.ts";
import type { DialogBroker } from "../dialog-broker.ts";
import type { ActiveRunState, BackgroundDispatchInput } from "../dispatch-runner.ts";
import type { InnerMatterDemo } from "../inner-matter.ts";
import type { PreviewManager } from "../preview-manager.ts";
import type { SseBroadcastScope } from "../sse.ts";

export const MEMORY_CATEGORIES = new Set<MemoryCategory>([
	"general",
	"efficiency",
	"troubleshooting",
	"collaboration",
	"user_correction",
	"domain_constraint",
]);

export interface ServerRouteContext {
	innerMatterDemo?: InnerMatterDemo;
	store: PersonalAgentStore;
	orchestrator: TeamOrchestrator;
	previewManager: PreviewManager;
	dialogBroker: DialogBroker;
	probePiCli?: () => Promise<PiCliProbeResult>;
	getServerRuntimeConfig?: () => ServerRuntimeConfig;
	rolesDir?: string;
	withRoleMutation: <T>(action: () => Promise<T>) => Promise<T>;
	uploadsDir?: string;
	memoryUploads: Map<string, { buffer: Buffer; mimeType: string }>;
	activeRuns: Map<string, ActiveRunState>;
	broadcast: (eventName: string, payload: unknown, scope?: SseBroadcastScope) => void;
	revokeTokenSessions: (collaboratorId: string, reason: string) => void;
	runDispatchInBackground: (input: BackgroundDispatchInput) => void;
	requireAuth?: boolean;
	defaultWorkspacesRoot?: string;
	dataDir?: string;
}

export interface RouteRequest {
	req: IncomingMessage;
	res: ServerResponse;
	method: string;
	pathname: string;
	actor: RequestActor | null;
}

export function enrichWorkspace(ws: WorkspaceLink): WorkspaceLink {
	return {
		...ws,
		repoGitUser: resolveRepoGitUserIdentity(ws.repoPath),
	};
}

export function formatWorkspaceForActor(
	store: PersonalAgentStore,
	ws: WorkspaceLink,
	actor: RequestActor,
): WorkspaceLink {
	const allowedUserIds = ws.visibility === "restricted" ? store.listWorkspaceMemberIds(ws.id) : undefined;
	if (isSuperAdminActor(actor) || canManageOrganization(store, actor, ws.orgId)) {
		return {
			...enrichWorkspace(ws),
			...(allowedUserIds ? { allowedUserIds } : {}),
		};
	}
	return {
		...ws,
		repoPath: ws.sourceType === "cloned" ? `托管仓库/${basename(ws.repoPath)}` : basename(ws.repoPath) || ws.name,
		repoGitUser: null,
		...(allowedUserIds ? { allowedUserIds } : {}),
	};
}

export function formatScopedMemoryMap(store: PersonalAgentStore, actor: RequestActor): Record<string, unknown[]> {
	const result: Record<string, unknown[]> = {};
	const wsCache = new Map<string, WorkspaceLink | null>();
	const getWs = (wsId: string) => {
		if (!wsCache.has(wsId)) wsCache.set(wsId, store.getWorkspace(wsId));
		return wsCache.get(wsId) ?? null;
	};
	for (const member of store.listMembers()) {
		if (member.ownerOrgId && !canAccessOrganization(store, actor, member.ownerOrgId)) {
			continue;
		}
		result[member.id] = store.listMemberMemories(member.id).filter((mem) => {
			if (mem.scope === "role_general") return true;
			if (mem.scope === "company_private") {
				return mem.orgId ? canAccessOrganization(store, actor, mem.orgId) : false;
			}
			if (mem.workspaceId) {
				const ws = getWs(mem.workspaceId);
				if (ws) return canAccessWorkspace(store, actor, ws);
			}
			return mem.orgId ? canAccessOrganization(store, actor, mem.orgId) : false;
		});
	}
	return result;
}

export function formatMemoryMap(store: PersonalAgentStore): Record<string, unknown[]> {
	const result: Record<string, unknown[]> = {};
	for (const member of store.listMembers()) {
		result[member.id] = store.listMemberMemories(member.id);
	}
	return result;
}

export function auditActorAction(
	ctx: ServerRouteContext,
	req: IncomingMessage,
	actor: RequestActor | null,
	input: {
		action: string;
		targetType?: string;
		targetId?: string;
		orgId?: string | null;
		detail?: Record<string, unknown> | null;
	},
): void {
	ctx.store.recordAuditLog({
		actorUserId: actor?.user?.id ?? null,
		actorEmail: actor?.user?.email ?? "",
		actorName: actor?.user?.displayName ?? actor?.collaborator.name ?? "system",
		action: input.action,
		targetType: input.targetType ?? "",
		targetId: input.targetId ?? "",
		orgId: input.orgId ?? null,
		detail: input.detail ?? null,
		ip: extractClientIp(req),
	});
}

export function broadcastDistilledMemories(
	broadcast: (event: string, data: unknown) => void,
	fallbackMemberId: string,
	createdMemories: Array<{ memberId: string }>,
): void {
	if (createdMemories.length === 0) return;
	const memberIds = Array.from(new Set(createdMemories.map((m) => m.memberId)));
	for (const targetMemberId of memberIds) {
		broadcast("memory_updated", {
			memberId: targetMemberId,
			createdMemories: createdMemories.filter((m) => m.memberId === targetMemberId),
		});
	}
	if (!memberIds.includes(fallbackMemberId)) {
		broadcast("memory_updated", { memberId: fallbackMemberId, createdMemories: [] });
	}
}

export function parseObserverMemberIds(raw: unknown, store: PersonalAgentStore): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (!trimmed || seen.has(trimmed) || !store.getMember(trimmed)) continue;
		seen.add(trimmed);
		ids.push(trimmed);
	}
	return ids;
}

export function parseCollaboratorIds(raw: unknown, store: PersonalAgentStore): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (!trimmed || trimmed === DEFAULT_OWNER_COLLABORATOR_ID || seen.has(trimmed)) continue;
		if (!store.getCollaborator(trimmed) && !store.getUserById(trimmed)) continue;
		seen.add(trimmed);
		ids.push(trimmed);
	}
	return ids;
}
