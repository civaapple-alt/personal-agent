import type { RoleTemplate } from "../roles/types.ts";
import type { Matter, MatterMessage, TeamMember } from "../storage/types.ts";
import { selectMatterContext, type WorkspaceContext } from "./matter-context.ts";

interface RuntimeSnapshot {
	tools: string[];
	mode: "internal";
	discussion: boolean | null;
	createdAt: string;
	turnId: string | null;
}

function runtimeSnapshot(message: MatterMessage): RuntimeSnapshot | undefined {
	if (message.channel !== "notice" || message.senderType !== "system") return;
	try {
		const event: unknown = JSON.parse(message.content);
		if (
			!event ||
			typeof event !== "object" ||
			!("method" in event) ||
			event.method !== "runtime_ready" ||
			!("sessionMode" in event) ||
			event.sessionMode !== "internal" ||
			!("tools" in event) ||
			!Array.isArray(event.tools) ||
			!event.tools.every((tool): tool is string => typeof tool === "string")
		)
			return;
		return {
			tools: event.tools,
			mode: "internal",
			discussion:
				"discussionMode" in event && typeof event.discussionMode === "boolean" ? event.discussionMode : null,
			createdAt: message.createdAt,
			turnId:
				typeof message.metadata?.sourceUserMessageId === "string" ? message.metadata.sourceUserMessageId : null,
		};
	} catch {
		return;
	}
}

const compact = (value: string, limit: number) => value.replace(/\s+/gu, " ").trim().slice(0, limit);
const list = (items: string[], count = 12) =>
	items
		.slice(0, count)
		.map((s) => compact(s, 100))
		.join(", ") || "none declared";

/** A scoped snapshot, not a prediction of what a future worker will be granted. */
export function buildTeamCapabilities(
	input: WorkspaceContext & {
		matter: Matter;
		members: TeamMember[];
		messages: MatterMessage[];
		getTemplate: (member: TeamMember) => RoleTemplate | undefined;
	},
): string {
	const history = selectMatterContext(input).messages;
	const snapshots = new Map<string, RuntimeSnapshot>();
	for (const message of history) {
		const snapshot = runtimeSnapshot(message);
		if (snapshot) snapshots.set(message.senderId, snapshot);
	}
	const lines = [
		"Team capability cards: role definitions are declarations, not proof of skill or permissions. Runtime records below are past internal-delegation startup snapshots for this matter and workspace, not live availability or proof of a successful tool call. Unknown means no matching record. Configured runtime tools are shared across role execution modes; actual availability may change between turns.",
		"A missing internal-delegation snapshot for the lead does not mean the lead has not started; the lead's current startup is reported separately.",
	];
	for (const member of input.members.slice(0, 40)) {
		const template = input.getTemplate(member);
		const consult =
			member.id !== input.matter.leadMemberId &&
			(input.matter.consultMemberIds == null || input.matter.consultMemberIds.includes(member.id));
		const observer = input.matter.observersEnabled && input.matter.observerMemberIds.includes(member.id);
		const snapshot = snapshots.get(member.id);
		lines.push(
			[
				`- ${compact(member.id, 100)} · ${compact(member.displayName, 100)} (${compact(member.roleTitle, 100)}): ${member.id === input.matter.leadMemberId ? "lead" : consult ? "consultable" : "not consultable"}${observer ? ", observer" : ""}.`,
				template
					? `  Role definition — responsibilities: ${compact(template.sections.responsibilitiesAndBoundaries, 360) || "not declared"}; boundaries: ${list(template.antiJobs ?? [], 5)}; role tool suggestions (not an allowlist): ${list(template.tools)}; declared skills: ${list(template.skills)}; declared MCP dependencies: ${list(template.mcpDependencies)}.`
					: "  Role definition unavailable; responsibilities, boundaries, tools, and skills are unknown.",
				snapshot
					? `  Last internal startup: ${snapshot.createdAt}; discussion mode: ${snapshot.discussion === null ? "unknown" : snapshot.discussion}; source turn: ${snapshot.turnId ?? "unknown"}; tools: ${list(snapshot.tools, 40)}.`
					: "  Last internal startup: unknown in this matter and workspace.",
			].join("\n"),
		);
	}
	if (input.members.length > 40) lines.push(`Showing 40 of ${input.members.length} visible members.`);
	lines.push(
		"Choose collaborators based on the task, responsibilities, boundaries, consult permission and available evidence. If required capability is unknown, say so and verify only when needed. Do not assume that a role title, a tool name, or a previous startup proves successful execution or current availability. Having bash can allow writes even without write/edit tools; Pi is not an OS sandbox. Observer and independent verification can use the same runtime tools; their collaboration responsibilities remain distinct.",
	);
	return lines.join("\n");
}
