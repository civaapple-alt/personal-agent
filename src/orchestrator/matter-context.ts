import type { Deliverable, MatterMessage } from "../storage/types.ts";

export interface WorkspaceContext {
	workspaceId: string | null;
	repoPath: string;
}

function explicitScope(message: MatterMessage): WorkspaceContext | null {
	const metadata = message.metadata;
	if (!metadata || !Object.hasOwn(metadata, "workspaceId") || typeof metadata.repoPath !== "string") return null;
	if (metadata.workspaceId !== null && typeof metadata.workspaceId !== "string") return null;
	return { workspaceId: metadata.workspaceId, repoPath: metadata.repoPath };
}

/** Recover scope from an explicit user-turn anchor for older internal events lacking repoPath.
 * An unscoped user message breaks inheritance. Never infer a project's history from today's matter binding.
 */
export function selectMatterContext(
	input: WorkspaceContext & { messages: MatterMessage[]; deliverables: Deliverable[] },
) {
	let turnScope: WorkspaceContext | null = null;
	const messages: MatterMessage[] = [];
	const deliverableIds = new Set<string>();
	for (const message of input.messages) {
		const explicit = explicitScope(message);
		if (message.channel === "user" && message.senderType === "user") turnScope = explicit;
		const scope = explicit ?? turnScope;
		if (!scope || scope.workspaceId !== input.workspaceId || scope.repoPath !== input.repoPath) continue;
		if (
			message.metadata &&
			Object.hasOwn(message.metadata, "workspaceId") &&
			message.metadata.workspaceId !== scope.workspaceId
		)
			continue;
		messages.push(message);
		if (
			message.channel === "user" &&
			message.senderType === "member" &&
			Array.isArray(message.metadata?.deliverableIds)
		) {
			for (const id of message.metadata.deliverableIds) if (typeof id === "string") deliverableIds.add(id);
		}
	}
	return { messages, deliverables: input.deliverables.filter((delivery) => deliverableIds.has(delivery.id)) };
}
