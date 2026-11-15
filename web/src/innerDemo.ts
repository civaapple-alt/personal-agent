import type { InnerMatterGuide, MatterDetailPayload } from "./api.ts";

/** Progress is a projection of persisted execution evidence, never of button clicks. */
export function innerDemoProgress(guide: InnerMatterGuide, detail: MatterDetailPayload): boolean[] {
	const versions = detail.deliverables.filter(
		(item) => item.type === "document" && item.title === guide.deliverableTitle,
	);
	return [
		detail.userMessages.some(
			(msg) =>
				msg.senderType === "member" &&
				msg.senderId === detail.matter.leadMemberId &&
				!msg.metadata?.aborted &&
				!msg.metadata?.failed &&
				!msg.metadata?.observerIntervention,
		),
		guide.collaborationMemberIds.every((id) =>
			detail.internalCollabMessages.some(
				(msg) =>
					msg.senderType === "member" &&
					msg.senderId === id &&
					typeof msg.metadata?.requestMessageId === "string" &&
					!msg.metadata.failed,
			),
		),
		versions.some((item) => item.version === 1),
		versions.some((item) => item.version >= 2) &&
			versions.some((item) => item.version === 1 && Boolean(item.feedback?.trim())),
	];
}
