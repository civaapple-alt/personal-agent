import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveRepoGitUserIdentity } from "../../orchestrator/execution-context.ts";
import type { TeamOrchestrator } from "../../orchestrator/team-orchestrator.ts";
import { DEFAULT_OWNER_COLLABORATOR_ID, type PersonalAgentStore } from "../../storage/repositories.ts";
import type { MemoryCategory, WorkspaceLink } from "../../storage/types.ts";
import type { RequestActor } from "../auth.ts";
import type { DialogBroker } from "../dialog-broker.ts";
import type { ActiveRunState, BackgroundDispatchInput } from "../dispatch-runner.ts";
import type { PreviewManager } from "../preview-manager.ts";

export const MEMORY_CATEGORIES = new Set<MemoryCategory>([
	"general",
	"efficiency",
	"troubleshooting",
	"collaboration",
	"user_correction",
	"domain_constraint",
]);

export interface ServerRouteContext {
	store: PersonalAgentStore;
	orchestrator: TeamOrchestrator;
	previewManager: PreviewManager;
	dialogBroker: DialogBroker;
	rolesDir?: string;
	uploadsDir?: string;
	memoryUploads: Map<string, { buffer: Buffer; mimeType: string }>;
	activeRuns: Map<string, ActiveRunState>;
	broadcast: (eventName: string, payload: unknown) => void;
	revokeTokenSessions: (collaboratorId: string, reason: string) => void;
	runDispatchInBackground: (input: BackgroundDispatchInput) => void;
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

export function formatMemoryMap(store: PersonalAgentStore): Record<string, unknown[]> {
	const result: Record<string, unknown[]> = {};
	for (const member of store.listMembers()) {
		result[member.id] = store.listMemberMemories(member.id);
	}
	return result;
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
		if (!store.getCollaborator(trimmed)) continue;
		seen.add(trimmed);
		ids.push(trimmed);
	}
	return ids;
}
