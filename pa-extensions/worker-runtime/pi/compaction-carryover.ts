import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PA_COMPACTION_CARRYOVER_CUSTOM_TYPE = "pa.compaction-carryover";

const DEFAULT_MAX_SKILL_CHARS = 4_000;
const DEFAULT_MAX_TOTAL_CHARS = 16_000;
const SKILL_BLOCK_RE = /<skill\s+name="([^"]+)"\s+location="([^"]+)"[^>]*>/g;
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n*/;

export interface CompactBranchEntry {
	id?: string;
	type?: string;
	message?: {
		role?: string;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		content?: unknown;
	};
}

export interface CompactionCarryoverOptions {
	cwd?: string;
	firstKeptEntryId?: string;
	maxSkillChars?: number;
	maxTotalChars?: number;
}

function extractTextParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts;
}

function resolveReadablePath(rawPath: string, cwd: string): string | undefined {
	const trimmed = rawPath.trim().replace(/^@/, "");
	if (!trimmed) return undefined;
	const expanded = trimmed === "~" || trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(1)) : trimmed;
	try {
		const local = expanded.startsWith("file://") ? fileURLToPath(expanded) : expanded;
		const full = resolve(cwd, local);
		try {
			return realpathSync(full);
		} catch {
			return full;
		}
	} catch {
		return undefined;
	}
}

function isSkillFilePath(filePath: string): boolean {
	return basename(filePath).toLowerCase() === "skill.md";
}

function stripFrontmatter(markdown: string): string {
	return markdown.replace(FRONTMATTER_RE, "").trim();
}

function deriveSkillName(filePath: string, explicitName?: string): string {
	if (explicitName?.trim()) return explicitName.trim();
	const parts = filePath.replaceAll("\\", "/").split("/").filter(Boolean);
	return parts.length >= 2 ? (parts[parts.length - 2] ?? "skill") : "skill";
}

function compactInline(text: string, maxLen = 100): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;
}

/**
 * Extracts bounded Skill bodies, saved Space document anchors, and completed delegation anchors
 * from compacted Pi session entries so persistent role sessions retain adopted methods after compaction.
 */
export function buildCompactionCarryover(
	entries: readonly CompactBranchEntry[],
	options: CompactionCarryoverOptions = {},
): string | undefined {
	const cwd = options.cwd ?? process.cwd();
	const maxSkillChars = options.maxSkillChars ?? DEFAULT_MAX_SKILL_CHARS;
	const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;

	const cutIndex = options.firstKeptEntryId ? entries.findIndex((entry) => entry.id === options.firstKeptEntryId) : -1;
	const compacted = cutIndex > 0 ? entries.slice(0, cutIndex) : entries;

	const pendingReads = new Map<string, string>();
	const pendingSpaceSaves = new Map<string, { title?: string; docType?: string }>();
	const pendingDelegations = new Map<string, { memberId?: string; task?: string }>();

	const skillOrder: Array<{ name: string; filePath: string }> = [];
	const spaceAnchors = new Map<string, string>();
	const delegationAnchors: string[] = [];

	const recordSkill = (filePath: string, explicitName?: string) => {
		const name = deriveSkillName(filePath, explicitName);
		const existingIdx = skillOrder.findIndex((item) => item.filePath === filePath);
		if (existingIdx >= 0) skillOrder.splice(existingIdx, 1);
		skillOrder.push({ name, filePath });
	};

	for (const entry of compacted) {
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;

		if (msg.role === "user") {
			for (const text of extractTextParts(msg.content)) {
				SKILL_BLOCK_RE.lastIndex = 0;
				let match = SKILL_BLOCK_RE.exec(text);
				while (match) {
					const name = match[1];
					const location = match[2];
					if (location) {
						const resolved = resolveReadablePath(location, cwd);
						if (resolved) recordSkill(resolved, name);
					}
					match = SKILL_BLOCK_RE.exec(text);
				}
			}
			continue;
		}

		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (!part || typeof part !== "object") continue;
				const rec = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
				if (rec.type !== "toolCall" || typeof rec.id !== "string" || typeof rec.name !== "string") continue;
				const args = (rec.arguments && typeof rec.arguments === "object" ? rec.arguments : {}) as Record<
					string,
					unknown
				>;

				if (rec.name === "read" && typeof args.path === "string") {
					const resolved = resolveReadablePath(args.path, cwd);
					if (resolved && isSkillFilePath(resolved)) {
						pendingReads.set(rec.id, resolved);
					}
				} else if (rec.name === "save_space_page") {
					pendingSpaceSaves.set(rec.id, {
						title: typeof args.title === "string" ? args.title : undefined,
						docType: typeof args.docType === "string" ? args.docType : undefined,
					});
				} else if (rec.name === "delegate_to_member") {
					pendingDelegations.set(rec.id, {
						memberId: typeof args.memberId === "string" ? args.memberId : undefined,
						task: typeof args.task === "string" ? args.task : undefined,
					});
				}
			}
			continue;
		}

		if (msg.role === "toolResult" && !msg.isError && typeof msg.toolCallId === "string") {
			const skillPath = pendingReads.get(msg.toolCallId);
			if (skillPath) {
				pendingReads.delete(msg.toolCallId);
				recordSkill(skillPath);
				continue;
			}
			const spaceSave = pendingSpaceSaves.get(msg.toolCallId);
			if (spaceSave) {
				pendingSpaceSaves.delete(msg.toolCallId);
				let pageId: string | undefined;
				let title = spaceSave.title;
				for (const text of extractTextParts(msg.content)) {
					try {
						const parsed = JSON.parse(text) as { page?: { id?: string; title?: string; docType?: string } };
						if (parsed?.page?.id) pageId = parsed.page.id;
						if (parsed?.page?.title) title = parsed.page.title;
					} catch {
						// Ignore non-JSON tool output
					}
				}
				const key = pageId ?? title ?? msg.toolCallId;
				const label = [
					title ? `「${compactInline(title, 60)}」` : undefined,
					pageId ? `(${pageId})` : undefined,
					spaceSave.docType ? `[${spaceSave.docType}]` : undefined,
				]
					.filter(Boolean)
					.join(" ");
				if (label) spaceAnchors.set(key, label);
				continue;
			}
			const delegation = pendingDelegations.get(msg.toolCallId);
			if (delegation) {
				pendingDelegations.delete(msg.toolCallId);
				if (delegation.memberId) {
					const summary = delegation.task
						? `${delegation.memberId}: ${compactInline(delegation.task, 80)}`
						: delegation.memberId;
					delegationAnchors.push(summary);
				}
			}
		}
	}

	const sections: string[] = [];

	if (spaceAnchors.size > 0 || delegationAnchors.length > 0) {
		const anchorLines: string[] = ["## Matter Anchors Preserved Across Compaction"];
		if (spaceAnchors.size > 0) {
			anchorLines.push(`- Saved Space pages: ${[...spaceAnchors.values()].slice(-8).join("; ")}`);
		}
		if (delegationAnchors.length > 0) {
			anchorLines.push(`- Completed delegations: ${delegationAnchors.slice(-6).join("; ")}`);
		}
		sections.push(anchorLines.join("\n"));
	}

	const restoredSkills: string[] = [];
	let remainingChars = maxTotalChars;
	// Keep most recently loaded skills within budget, emitted in load order (most recent last).
	const selected: Array<{ name: string; filePath: string; body: string; truncated: boolean }> = [];
	for (let i = skillOrder.length - 1; i >= 0; i -= 1) {
		const item = skillOrder[i]!;
		let raw: string;
		try {
			raw = readFileSync(item.filePath, "utf8");
		} catch {
			continue;
		}
		const body = stripFrontmatter(raw);
		if (!body) continue;
		const allowed = Math.min(maxSkillChars, remainingChars);
		if (allowed < 200) break;
		const truncated = body.length > allowed;
		const snippet = truncated ? `${body.slice(0, allowed - 1).trimEnd()}…` : body;
		remainingChars -= snippet.length;
		selected.unshift({ ...item, body: snippet, truncated });
	}

	for (const skill of selected) {
		const truncNote = skill.truncated ? " [truncated — re-read file before relying on omitted sections]" : "";
		restoredSkills.push(
			`<restored_skill name="${skill.name}" path="${skill.filePath}">${truncNote}\n${skill.body}\n</restored_skill>`,
		);
	}

	if (restoredSkills.length > 0) {
		sections.push(
			[
				"## Skills Restored After Compaction",
				"Context compaction summarized earlier turns, including skills loaded in them. Adopted skills are restored below (most recently loaded last). Keep following the ones relevant to this task.",
				"",
				restoredSkills.join("\n\n"),
			].join("\n"),
		);
	}

	if (sections.length === 0) return undefined;
	return `<pa_compaction_carryover>\n${sections.join("\n\n")}\n</pa_compaction_carryover>`;
}
