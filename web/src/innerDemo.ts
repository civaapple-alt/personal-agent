import type { InnerMatterGuide, MatterDetailPayload } from "./api.ts";

/** Progress is a projection of persisted execution evidence, never of button clicks. */
export function innerDemoProgress(guide: InnerMatterGuide, detail: MatterDetailPayload): boolean[] {
	const documents = (detail.spaceDocuments ?? []).filter((item) => item.title === guide.deliverableTitle);
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
		documents.length > 0,
		documents.some(
			(doc) =>
				doc.revision >= 2 &&
				(detail.spaceFeedback ?? []).some(
					(item) =>
						item.documentId === doc.id && item.commitHash !== doc.headCommit && Boolean(item.feedback.trim()),
				),
		),
	];
}
