import type {
	ActiveDelegationDto,
	MatterDto,
	MatterMessageDto,
	MatterProgressDto,
	MemberMemoryDto,
	MessageFileDto,
	MessageImageDto,
	ProgressActivityDto,
	ProgressSnapshotDto,
} from "../api.ts";
import { STAGE_ORDER } from "./formatters.ts";

export function parseProgressSnapshot(
	metadata: Record<string, unknown> | null | undefined,
): ProgressSnapshotDto | null {
	const raw = metadata?.progressSnapshot;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const rec = raw as Record<string, unknown>;
	const stage =
		typeof rec.stage === "string" && STAGE_ORDER.includes(rec.stage as MatterProgressDto["stage"])
			? (rec.stage as MatterProgressDto["stage"])
			: null;
	const outcome =
		rec.outcome === "completed"
			? "completed"
			: rec.outcome === "aborted"
				? "aborted"
				: rec.outcome === "failed"
					? "failed"
					: null;
	const label = typeof rec.label === "string" ? rec.label : "";
	if (!stage || !outcome || !label) return null;
	const activeDelegations = Array.isArray(rec.activeDelegations)
		? rec.activeDelegations.filter(
				(item): item is ActiveDelegationDto =>
					Boolean(item) &&
					typeof item === "object" &&
					typeof (item as ActiveDelegationDto).memberId === "string" &&
					typeof (item as ActiveDelegationDto).memberName === "string" &&
					typeof (item as ActiveDelegationDto).stageLabel === "string",
			)
		: undefined;
	const recentLogs = Array.isArray(rec.recentLogs)
		? rec.recentLogs.filter(
				(item): item is ProgressActivityDto =>
					Boolean(item) &&
					typeof item === "object" &&
					typeof (item as ProgressActivityDto).memberName === "string" &&
					typeof (item as ProgressActivityDto).summary === "string" &&
					typeof (item as ProgressActivityDto).at === "string",
			)
		: undefined;
	return {
		outcome,
		stage,
		label,
		toolName: typeof rec.toolName === "string" ? rec.toolName : undefined,
		toolSummary: typeof rec.toolSummary === "string" ? rec.toolSummary : undefined,
		startedAt: typeof rec.startedAt === "string" ? rec.startedAt : "",
		capturedAt: typeof rec.capturedAt === "string" ? rec.capturedAt : "",
		elapsedSeconds:
			typeof rec.elapsedSeconds === "number" && Number.isFinite(rec.elapsedSeconds) ? rec.elapsedSeconds : 0,
		activeDelegations: activeDelegations?.length ? activeDelegations : undefined,
		recentLogs: recentLogs?.length ? recentLogs : undefined,
		leadMemberId: typeof rec.leadMemberId === "string" ? rec.leadMemberId : undefined,
		leadMemberName: typeof rec.leadMemberName === "string" ? rec.leadMemberName : undefined,
	};
}

export function isKeyNoticeEvent(rawContent: string): boolean {
	try {
		const parsed = JSON.parse(rawContent) as {
			type?: string;
			method?: string;
			isError?: boolean;
		};
		if (parsed.type === "tool_execution_start" || parsed.method === "runtime_model_usage") return false;
		if (parsed.type === "tool_execution_end") return Boolean(parsed.isError);
		return true;
	} catch {
		if (rawContent.includes('"type":"tool_execution_start"')) return false;
		if (rawContent.includes('"type":"tool_execution_end"')) {
			return rawContent.includes('"isError":true');
		}
		return true;
	}
}

export function formatNoticeEventLine(rawContent: string): string {
	try {
		const parsed = JSON.parse(rawContent) as {
			type?: string;
			method?: string;
			toolName?: string;
			args?: { path?: string; command?: string; title?: string };
			isError?: boolean;
			message?: string;
			tools?: string[];
			scope?: string;
			content?: string;
			createdCount?: number;
			kind?: string;
			source?: string;
			truncated?: boolean;
			firstRequest?: { cacheRead: number; input: number; cacheWrite: number };
			totals?: { cacheRead: number; input: number; cacheWrite: number };
		};
		const detail = parsed.args?.path
			? ` (${parsed.args.path})`
			: parsed.args?.command
				? ` (${parsed.args.command.replace(/\s+/g, " ").trim().slice(0, 80)})`
				: parsed.args?.title
					? ` (${parsed.args.title})`
					: "";
		if (parsed.type === "tool_execution_start") {
			return `开始工具 ${parsed.toolName ?? "tool"}${detail}`;
		}
		if (parsed.type === "tool_execution_end") {
			return `结束工具 ${parsed.toolName ?? "tool"}${parsed.isError ? "（失败）" : ""}`;
		}
		if (parsed.method === "runtime_ready") {
			return `工作进程就绪（${parsed.tools?.join(", ") ?? "标准工具"}）`;
		}
		if (parsed.method === "web_fetch_evidence") {
			const action =
				parsed.kind === "temporary_clone"
					? "GitHub 临时副本（跨轮次可能失效）"
					: parsed.kind === "github_api"
						? "GitHub API 视图（未确认本地克隆）"
						: "GitHub 内容（获取方式未确认）";
			return `已获取 ${action}${parsed.source ? `：${parsed.source}` : ""}${parsed.truncated ? "；返回内容有截断" : ""}`;
		}
		if (parsed.method === "runtime_model_usage" && parsed.firstRequest && parsed.totals) {
			const first = parsed.firstRequest;
			const total = parsed.totals;
			return `缓存读入 tokens（首个有效请求 ${first.cacheRead}/${first.input + first.cacheRead + first.cacheWrite}，本轮 ${total.cacheRead}/${total.input + total.cacheRead + total.cacheWrite}）`;
		}
		if (parsed.method === "rsi_candidate_proposed") {
			const snippet = (parsed.content ?? "").slice(0, 48);
			return `提出待核验经验（${parsed.scope ?? "role_general"}）：${snippet}`;
		}
		if (parsed.method === "rsi_distilled") {
			return `AI 经验提炼完成（新增 ${parsed.createdCount ?? 0} 条待核验候选）`;
		}
		if (parsed.method === "error" && parsed.message) {
			return `执行异常：${parsed.message}`;
		}
		if (parsed.message) return parsed.message;
	} catch {
		// Gracefully recover truncated historical JSON notices (e.g. large tool outputs).
		const typeMatch = rawContent.match(/"type"\s*:\s*"(tool_execution_start|tool_execution_end)"/);
		if (typeMatch) {
			const toolName = rawContent.match(/"toolName"\s*:\s*"([^"]+)"/)?.[1] ?? "tool";
			const isError = /"isError"\s*:\s*true/.test(rawContent);
			if (typeMatch[1] === "tool_execution_start") {
				const pathArg = rawContent.match(/"path"\s*:\s*"([^"]+)"/)?.[1];
				const cmdArg = rawContent.match(/"command"\s*:\s*"([^"]{1,80})/)?.[1];
				const detail = pathArg ? ` (${pathArg})` : cmdArg ? ` (${cmdArg})` : "";
				return `开始工具 ${toolName}${detail}`;
			}
			return `结束工具 ${toolName}${isError ? "（失败）" : ""}`;
		}
	}
	return rawContent.length > 240 ? `${rawContent.slice(0, 240)}…` : rawContent;
}

const MEMORY_STATUS_SORT_ORDER: Record<string, number> = {
	candidate: 0,
	verified: 1,
	superseded: 2,
	rejected: 3,
};

export function collectMatterMemories(
	memoriesByMember: Record<string, MemberMemoryDto[]>,
	matterId: string,
): MemberMemoryDto[] {
	const items: MemberMemoryDto[] = [];
	for (const list of Object.values(memoriesByMember)) {
		for (const memory of list) {
			if (memory.sourceMatterId === matterId) {
				items.push(memory);
			}
		}
	}
	return items.sort((a, b) => {
		const aRank = MEMORY_STATUS_SORT_ORDER[a.status] ?? 9;
		const bRank = MEMORY_STATUS_SORT_ORDER[b.status] ?? 9;
		if (aRank !== bRank) return aRank - bRank;
		return b.createdAt.localeCompare(a.createdAt);
	});
}

export function collectMatterParticipantIds(params: {
	matter?: MatterDto | null;
	userMessages?: MatterMessageDto[];
	internalCollabMessages?: MatterMessageDto[];
}): string[] {
	const ids = new Set<string>();
	if (params.matter?.leadMemberId) ids.add(params.matter.leadMemberId);
	for (const id of params.matter?.observerMemberIds ?? []) {
		if (id) ids.add(id);
	}
	for (const msg of params.userMessages ?? []) {
		if (msg.senderType === "member" && msg.senderId) ids.add(msg.senderId);
	}
	for (const msg of params.internalCollabMessages ?? []) {
		if (msg.senderType === "member" && msg.senderId) ids.add(msg.senderId);
		const toMemberId =
			msg.metadata && typeof msg.metadata.toMemberId === "string" ? msg.metadata.toMemberId : undefined;
		if (toMemberId) ids.add(toMemberId);
	}
	return Array.from(ids);
}

/** Extracts lightweight image attachment references stored on a user message's metadata. */
export function parseMessageImages(metadata: Record<string, unknown> | null | undefined): MessageImageDto[] {
	const raw = metadata?.images;
	if (!Array.isArray(raw)) return [];
	const images: MessageImageDto[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const mimeType = typeof record.mimeType === "string" ? record.mimeType.trim() : "";
		const url = typeof record.url === "string" ? record.url.trim() : undefined;
		const name = typeof record.name === "string" ? record.name.trim() : undefined;
		if (!mimeType && !url) continue;
		images.push({
			...(url ? { url } : {}),
			mimeType: mimeType || "image/png",
			...(name ? { name } : {}),
		});
	}
	return images;
}

/** Extracts lightweight uploaded file and pasted-text attachment references stored on message metadata. */
export function parseMessageFiles(metadata: Record<string, unknown> | null | undefined): MessageFileDto[] {
	const raw = metadata?.files;
	if (!Array.isArray(raw)) return [];
	const files: MessageFileDto[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const name = typeof record.name === "string" ? record.name.trim() : "";
		const mimeType = typeof record.mimeType === "string" ? record.mimeType.trim() : "text/plain";
		const url = typeof record.url === "string" ? record.url.trim() : undefined;
		const kind = record.kind === "pasted_text" ? "pasted_text" : "file";
		if (!name && !url) continue;
		files.push({
			...(url ? { url } : {}),
			kind,
			name: name || "attachment.txt",
			mimeType: mimeType || "text/plain",
			...(typeof record.sizeBytes === "number" ? { sizeBytes: record.sizeBytes } : {}),
			...(typeof record.lineCount === "number" ? { lineCount: record.lineCount } : {}),
			...(typeof record.charCount === "number" ? { charCount: record.charCount } : {}),
			...(typeof record.previewText === "string" ? { previewText: record.previewText } : {}),
		});
	}
	return files;
}
