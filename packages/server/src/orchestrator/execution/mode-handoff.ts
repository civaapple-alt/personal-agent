import type { BoardMemberRecord, BoardPostSummaryRecord } from "../../storage/repos/board-repo.ts";
import type { PersonalAgentStore } from "../../storage/repositories.ts";

const LEAD_TO_BOARD_MAX_CHARS = 3200;
const BOARD_TO_LEAD_MAX_CHARS = 2800;

function trimToBudget(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n…(truncated to budget)`;
}

function summarizeInline(raw: string, maxChars: number): string {
	const single = raw.replace(/\s+/g, " ").trim();
	return single.length <= maxChars ? single : `${single.slice(0, maxChars - 1)}…`;
}

/**
 * Build bounded prior Lead conversation & Space document context when Coordinator starts on a matter
 * that previously accumulated Lead turns or saved deliverables (`Lead -> Board` upgrade handoff).
 */
export function buildLeadToBoardHandoffBlock(
	store: PersonalAgentStore,
	matterId: string,
	excludeUserMessageId?: string,
): string {
	const priorMessages = store
		.listMessages(matterId, "user")
		.filter((msg) => msg.id !== excludeUserMessageId)
		.slice(-6);
	const spaceDocs = store.spaces.listDocuments({ matterId }).slice(0, 8);

	if (priorMessages.length === 0 && spaceDocs.length === 0) {
		return "";
	}

	const sections: string[] = [
		"[Lead -> Board Handoff Context]",
		"This matter previously ran in Lead mode before escalating to Board collaboration. Preserve settled decisions and reuse existing deliverables rather than starting from scratch:",
	];

	if (priorMessages.length > 0) {
		sections.push("## Prior Lead Conversation Turns (latest 6)");
		for (const msg of priorMessages) {
			const speaker = msg.senderType === "user" ? "User" : msg.senderId;
			sections.push(`- ${speaker}: ${summarizeInline(msg.content, 360)}`);
		}
	}

	if (spaceDocs.length > 0) {
		sections.push("## Linked Space Documents (inspect via `read_space` if needed)");
		for (const doc of spaceDocs) {
			sections.push(`- \`${doc.id}\` (${doc.docType}, rev=${doc.revision}): ${doc.title}`);
		}
	}

	return trimToBudget(sections.join("\n"), LEAD_TO_BOARD_MAX_CHARS);
}

function formatBoardMemberLine(member: BoardMemberRecord): string {
	const scope = member.ownedScope.length > 0 ? ` scope=[${member.ownedScope.join(", ")}]` : "";
	return `- @${member.agentId} (${member.displayName}, role=${member.boardRole}, status=${member.status}${scope})`;
}

function formatKeyBoardPostLine(post: BoardPostSummaryRecord): string {
	const files =
		post.artifacts?.files && post.artifacts.files.length > 0
			? ` files=[${post.artifacts.files.map((f) => (typeof f === "string" ? f : f.path)).join(", ")}]`
			: "";
	const verdict = post.verification?.verdict ? ` [verdict=${post.verification.verdict}]` : "";
	return `- #${post.postNo} [${post.kind}] @${post.authorId}${verdict}: ${summarizeInline(post.summary, 240)}${files}`;
}

/**
 * Build bounded Board collaboration summary (`roster`, key posts, and Space deliverables) for Lead follow-up turns
 * after a user switches back from `board` to `lead` (`Board -> Lead` handoff).
 */
export function buildBoardToLeadHandoffBlock(store: PersonalAgentStore, matterId: string): string {
	const members = store.listBoardMembers(matterId);
	if (members.length === 0) {
		return "";
	}
	const recentPosts = store
		.listBoardPostSummaries(matterId, { order: "desc", limit: 24 })
		.filter((post) => !post.id.startsWith("bpost_msg_"))
		.slice(0, 12);
	const spaceDocs = store.spaces.listDocuments({ matterId }).slice(0, 8);

	const keyPosts = recentPosts
		.filter(
			(post) =>
				post.kind === "summary" ||
				post.kind === "verify_pass" ||
				post.kind === "verify_rework" ||
				post.kind === "handoff",
		)
		.slice(0, 6)
		.reverse();
	const displayPosts = keyPosts.length > 0 ? keyPosts : [...recentPosts].slice(0, 4).reverse();

	const sections: string[] = [
		"[Board -> Lead Handoff Context]",
		"This matter previously executed in Board collaboration mode. Ground follow-up answers and small tweaks in the completed board deliverables below:",
	];

	if (members.length > 0) {
		sections.push("## Board Roster");
		for (const member of members.slice(0, 10)) {
			sections.push(formatBoardMemberLine(member));
		}
	}

	if (displayPosts.length > 0) {
		sections.push("## Latest Board Posts");
		for (const post of displayPosts) {
			sections.push(formatKeyBoardPostLine(post));
		}
	}

	if (spaceDocs.length > 0) {
		sections.push("## Linked Space Documents");
		for (const doc of spaceDocs) {
			sections.push(`- \`${doc.id}\` (${doc.docType}, rev=${doc.revision}): ${doc.title}`);
		}
	}

	return trimToBudget(sections.join("\n"), BOARD_TO_LEAD_MAX_CHARS);
}
