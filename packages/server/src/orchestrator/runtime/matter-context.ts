import type { MatterMessage } from "../../storage/types.ts";

export interface WorkspaceContext {
	workspaceId: string | null;
	repoPath: string;
	orgId?: string | null;
}

/** Collect document IDs from the scoped messages that recorded their creation or update. */
export function scopedSpaceDocumentIds(messages: MatterMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (!Array.isArray(message.metadata?.spaceDocuments)) continue;
		for (const item of message.metadata.spaceDocuments) {
			if (item && typeof item === "object" && "id" in item && typeof item.id === "string") ids.add(item.id);
		}
	}
	return ids;
}

export function messageMatchesContext(message: MatterMessage, context: WorkspaceContext): boolean {
	return (
		message.metadata?.workspaceId === context.workspaceId &&
		message.metadata?.repoPath === context.repoPath &&
		message.metadata?.orgId === (context.orgId ?? null)
	);
}

function explicitScope(message: MatterMessage): WorkspaceContext | null {
	const metadata = message.metadata;
	if (!metadata || !Object.hasOwn(metadata, "workspaceId") || typeof metadata.repoPath !== "string") return null;
	if (metadata.workspaceId !== null && typeof metadata.workspaceId !== "string") return null;
	if (metadata.orgId !== null && typeof metadata.orgId !== "string") return null;
	return { workspaceId: metadata.workspaceId, repoPath: metadata.repoPath, orgId: metadata.orgId };
}

/** Recover scope from an explicit user-turn anchor for older internal events lacking repoPath.
 * An unscoped user message breaks inheritance. Never infer a project's history from today's matter binding.
 */
export function selectMatterContext(input: WorkspaceContext & { messages: MatterMessage[] }) {
	let turnScope: WorkspaceContext | null = null;
	const messages: MatterMessage[] = [];
	for (const message of input.messages) {
		const explicit = explicitScope(message);
		if (message.channel === "user" && message.senderType === "user") turnScope = explicit;
		const scope = explicit ?? turnScope;
		if (
			!scope ||
			scope.workspaceId !== input.workspaceId ||
			scope.repoPath !== input.repoPath ||
			scope.orgId !== (input.orgId ?? null)
		)
			continue;
		if (message.metadata?.orgId !== scope.orgId) continue;
		if (
			message.metadata &&
			Object.hasOwn(message.metadata, "workspaceId") &&
			message.metadata.workspaceId !== scope.workspaceId
		)
			continue;
		messages.push(message);
	}
	return { messages };
}
