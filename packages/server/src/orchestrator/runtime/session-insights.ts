/**
 * Deterministic, local-only Pi session insights engine for Personal Agent.
 * Adapted in spirit from JetBrains ThinkRail's `@thinkrail/pi-session-insights` (Apache-2.0):
 * reads Pi `.jsonl` session transcripts on disk with zero LLM calls and zero network requests,
 * masks secrets/paths, and surfaces fixed-rule operational findings.
 */
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
	SessionInsightFinding,
	SessionInsightSessionSummary,
	SessionInsightsReport,
} from "@pa/contracts/session-insights";

export interface SessionInsightSource {
	sessionFile: string;
	sessionId?: string;
	matterId?: string | null;
	memberId?: string | null;
	memberName?: string | null;
	updatedAt?: string;
}

interface ParsedToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

interface ParsedCommandRun {
	commandKey: string;
	rawCommand: string;
	isError: boolean;
	errorSnippet?: string;
}

interface ParsedSession {
	summary: SessionInsightSessionSummary;
	listedSkills: Set<string>;
	loadedSkills: Set<string>;
	fileEdits: Map<string, number>;
	commandRuns: ParsedCommandRun[];
	consecutiveRepeatMax: { tool: string; count: number; sample: string } | null;
	claimedTestsPassedWithoutRun: boolean;
	userInstructions: string[];
	toolStats: Map<string, { calls: number; errors: number }>;
	modelStats: Map<string, { costUsd: number; calls: number }>;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
	[/-----BEGIN [A-Z0-9 ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]+PRIVATE KEY-----/g, "[redacted-private-key]"],
	[/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]"],
	[
		/\b(?:sk-[A-Za-z0-9_-]{16,}|pat_[A-Za-z0-9_-]{12,}|gh[pou]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
		"[redacted]",
	],
	[/:\/\/([^/\s:@]+):([^/\s@]+)@/g, "://[redacted]@"],
	[/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[redacted-email]"],
];

/** Best-effort local redaction for home paths, credentials, tokens, private keys, and emails. */
export function redactInsightText(input: string, homePath: string = homedir()): string {
	let out = input;
	if (homePath && homePath.length > 1) {
		out = out.split(homePath).join("~");
	}
	for (const [pattern, replacement] of SECRET_PATTERNS) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

function truncateLine(text: string, maxLen = 140): string {
	const single = text.replace(/\s+/g, " ").trim();
	if (single.length <= maxLen) return single;
	return `${single.slice(0, maxLen - 1)}…`;
}

function extractTextParts(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		if (rec.type === "text" && typeof rec.text === "string") {
			parts.push(rec.text);
		}
	}
	return parts.join("\n");
}

function extractAvailableSkillsFromText(text: string, target: Set<string>): void {
	if (!text.includes("<available_skills>") && !text.includes("<name>")) return;
	for (const match of text.matchAll(/<skill>[\s\S]*?<name>\s*([a-zA-Z0-9._-]+)\s*<\/name>[\s\S]*?<\/skill>/g)) {
		if (match[1]) target.add(match[1]);
	}
}

function normalizeShellCommandKey(raw: string): string {
	const firstLine = raw.trim().split(/\r?\n/)[0]?.trim() ?? "";
	const tokens = firstLine.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return "";
	// Group by first 2-3 meaningful tokens (e.g. `npm test`, `npm run check`, `git status`, `node --test`)
	const take = tokens[0] === "npm" && tokens[1] === "run" ? 3 : Math.min(2, tokens.length);
	return tokens.slice(0, take).join(" ");
}

function isTestCommand(raw: string): boolean {
	return /\b(?:npm\s+(?:run\s+)?test|node\s+--test|vitest|jest|pytest|bun\s+test|cargo\s+test|go\s+test|phpunit|rspec)\b/i.test(
		raw,
	);
}

function claimsTestsPassed(text: string): boolean {
	return /(?:all\s+tests?\s+(?:passed|pass)|tests?\s+passed|测试(?:全部)?通过|单测(?:全部)?通过|全部\s*\d+\s*(?:项|个)?测试通过)/i.test(
		text,
	);
}

function normalizeInstruction(text: string): string {
	const cleaned = text
		.replace(/<pa_runtime_context>[\s\S]*?<\/pa_runtime_context>/g, "")
		.replace(/\[Current worker startup evidence\][\s\S]*?\[\/Current worker startup evidence\]/g, "")
		.replace(/\[PA workbench reference for this turn\][\s\S]*?\[\/PA workbench reference\]/g, "")
		.trim();
	const lines = cleaned
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length >= 12 && !line.startsWith("#") && !line.startsWith("Recent messages"));
	return (lines.at(-1) ?? cleaned).replace(/\s+/g, " ").trim();
}

function parseSessionNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Parse one Pi `.jsonl` session transcript with fixed deterministic rules. */
export function analyzePiSessionFile(source: SessionInsightSource): ParsedSession | null {
	if (!source.sessionFile || !existsSync(source.sessionFile)) return null;
	let raw: string;
	try {
		raw = readFileSync(source.sessionFile, "utf8");
	} catch {
		return null;
	}
	const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
	if (lines.length === 0) return null;

	let sessionId = source.sessionId ?? basename(source.sessionFile, ".jsonl");
	let startedAt: string | undefined;
	let updatedAt = source.updatedAt;
	let title: string | undefined;
	let turns = 0;
	let toolCallsCount = 0;
	let toolErrorsCount = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let costUsd = 0;

	const listedSkills = new Set<string>();
	const loadedSkills = new Set<string>();
	const fileEdits = new Map<string, number>();
	const commandRuns: ParsedCommandRun[] = [];
	const toolStats = new Map<string, { calls: number; errors: number }>();
	const modelStats = new Map<string, { costUsd: number; calls: number }>();
	const userInstructions: string[] = [];
	const pendingCalls = new Map<string, ParsedToolCall>();

	let lastCallSig = "";
	let repeatRun = 0;
	let consecutiveRepeatMax: { tool: string; count: number; sample: string } | null = null;
	let ranAnyTestCommand = false;
	let claimedTestsPassed = false;

	const recordToolCall = (call: ParsedToolCall) => {
		toolCallsCount += 1;
		pendingCalls.set(call.id, call);
		const stat = toolStats.get(call.name) ?? { calls: 0, errors: 0 };
		stat.calls += 1;
		toolStats.set(call.name, stat);

		const sig = `${call.name}:${JSON.stringify(call.args)}`;
		if (sig === lastCallSig) {
			repeatRun += 1;
		} else {
			lastCallSig = sig;
			repeatRun = 1;
		}
		if (repeatRun >= 3 && (!consecutiveRepeatMax || repeatRun > consecutiveRepeatMax.count)) {
			consecutiveRepeatMax = {
				tool: call.name,
				count: repeatRun,
				sample: truncateLine(redactInsightText(JSON.stringify(call.args)), 100),
			};
		}

		if (call.name === "load_available_skill" && typeof call.args.name === "string") {
			loadedSkills.add(call.args.name.trim());
		}
		if (call.name === "read" && typeof call.args.path === "string" && call.args.path.endsWith("SKILL.md")) {
			const parts = call.args.path.replaceAll("\\", "/").split("/");
			const skillFolder = parts.at(-2);
			if (skillFolder) loadedSkills.add(skillFolder);
		}
		if ((call.name === "edit" || call.name === "write") && typeof call.args.path === "string") {
			const cleanPath = redactInsightText(call.args.path.trim());
			fileEdits.set(cleanPath, (fileEdits.get(cleanPath) ?? 0) + 1);
		}
		if ((call.name === "bash" || call.name === "powershell") && typeof call.args.command === "string") {
			if (isTestCommand(call.args.command)) ranAnyTestCommand = true;
		}
	};

	for (const line of lines) {
		let entry: Record<string, unknown>;
		try {
			const parsed = JSON.parse(line);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			entry = parsed as Record<string, unknown>;
		} catch {
			continue;
		}

		if (typeof entry.timestamp === "string") {
			if (!startedAt) startedAt = entry.timestamp;
			updatedAt = entry.timestamp;
		}
		if (entry.type === "session") {
			if (typeof entry.id === "string" && entry.id.trim()) sessionId = entry.id.trim();
			continue;
		}

		const msg =
			entry.type === "message" && entry.message && typeof entry.message === "object"
				? (entry.message as Record<string, unknown>)
				: entry;
		const role = typeof msg.role === "string" ? msg.role : undefined;

		if (role === "user") {
			turns += 1;
			const text = extractTextParts(msg.content);
			extractAvailableSkillsFromText(text, listedSkills);
			const norm = normalizeInstruction(text);
			if (norm.length >= 12) {
				if (!title) title = truncateLine(redactInsightText(norm), 80);
				userInstructions.push(norm);
			}
		} else if (role === "system" || role === "custom") {
			const text = extractTextParts(msg.content);
			extractAvailableSkillsFromText(text, listedSkills);
		} else if (role === "assistant") {
			const text = extractTextParts(msg.content);
			if (text && claimsTestsPassed(text)) claimedTestsPassed = true;

			const provider = typeof msg.provider === "string" ? msg.provider : undefined;
			const model = typeof msg.model === "string" ? msg.model : undefined;
			const modelKey = provider && model ? `${provider}/${model}` : (model ?? "unknown");
			const usage = msg.usage && typeof msg.usage === "object" ? (msg.usage as Record<string, unknown>) : null;
			if (usage) {
				inputTokens += parseSessionNumber(usage.input);
				outputTokens += parseSessionNumber(usage.output);
				cacheReadTokens += parseSessionNumber(usage.cacheRead);
				cacheWriteTokens += parseSessionNumber(usage.cacheWrite);
				const costObj =
					usage.cost && typeof usage.cost === "object" ? (usage.cost as Record<string, unknown>) : null;
				const msgCost = parseSessionNumber(costObj?.total);
				costUsd += msgCost;
				const mStat = modelStats.get(modelKey) ?? { costUsd: 0, calls: 0 };
				mStat.costUsd += msgCost;
				mStat.calls += 1;
				modelStats.set(modelKey, mStat);
			}

			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (!block || typeof block !== "object") continue;
					const rec = block as Record<string, unknown>;
					if (rec.type === "toolCall" && typeof rec.name === "string") {
						const id = typeof rec.id === "string" ? rec.id : `call_${toolCallsCount}`;
						const args =
							rec.arguments && typeof rec.arguments === "object" && !Array.isArray(rec.arguments)
								? (rec.arguments as Record<string, unknown>)
								: {};
						recordToolCall({ id, name: rec.name, args });
					}
				}
			}
		} else if (role === "toolResult") {
			const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
			const toolName =
				typeof msg.toolName === "string"
					? msg.toolName
					: toolCallId
						? pendingCalls.get(toolCallId)?.name
						: undefined;
			const isError = msg.isError === true;
			if (isError) {
				toolErrorsCount += 1;
				if (toolName) {
					const stat = toolStats.get(toolName) ?? { calls: 0, errors: 0 };
					stat.errors += 1;
					toolStats.set(toolName, stat);
				}
			}
			const pending = toolCallId ? pendingCalls.get(toolCallId) : undefined;
			if (pending && (pending.name === "bash" || pending.name === "powershell")) {
				const rawCommand = typeof pending.args.command === "string" ? pending.args.command : "";
				const commandKey = normalizeShellCommandKey(rawCommand);
				if (commandKey) {
					const resultText = extractTextParts(msg.content);
					commandRuns.push({
						commandKey,
						rawCommand: redactInsightText(rawCommand),
						isError,
						...(isError && resultText ? { errorSnippet: truncateLine(redactInsightText(resultText), 120) } : {}),
					});
				}
			}
		}
	}

	if (!updatedAt) {
		try {
			updatedAt = statSync(source.sessionFile).mtime.toISOString();
		} catch {
			// Ignore stat failure
		}
	}

	return {
		summary: {
			sessionId,
			matterId: source.matterId ?? null,
			memberId: source.memberId ?? null,
			memberName: source.memberName ?? null,
			title,
			startedAt,
			updatedAt,
			turns,
			toolCalls: toolCallsCount,
			toolErrors: toolErrorsCount,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			costUsd: Number(costUsd.toFixed(6)),
			models: [...modelStats.keys()].sort(),
		},
		listedSkills,
		loadedSkills,
		fileEdits,
		commandRuns,
		consecutiveRepeatMax,
		claimedTestsPassedWithoutRun: claimedTestsPassed && !ranAnyTestCommand,
		userInstructions,
		toolStats,
		modelStats,
	};
}

/** Recursively discover `.jsonl` Pi session files under a sessions directory. */
export function discoverPiSessionFiles(sessionDir: string, limit = 50): SessionInsightSource[] {
	if (!sessionDir || !existsSync(sessionDir)) return [];
	const found: Array<{ file: string; mtimeMs: number }> = [];
	const visit = (dir: string, depth: number) => {
		if (depth > 4) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(full, depth + 1);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				try {
					found.push({ file: full, mtimeMs: statSync(full).mtimeMs });
				} catch {
					// Ignore unreadable files
				}
			}
		}
	};
	visit(resolve(sessionDir), 0);
	found.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return found.slice(0, limit).map((item) => ({
		sessionFile: item.file,
		updatedAt: new Date(item.mtimeMs).toISOString(),
	}));
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Aggregate deterministic operational insights across one or more Pi session transcripts. */
export function buildSessionInsightsReport(
	sources: SessionInsightSource[],
	scope: { matterId?: string | null; memberId?: string | null } = {},
): SessionInsightsReport {
	const seenFiles = new Set<string>();
	const parsedSessions: ParsedSession[] = [];
	for (const source of sources) {
		const normalizedFile = resolve(source.sessionFile);
		if (seenFiles.has(normalizedFile)) continue;
		seenFiles.add(normalizedFile);
		const parsed = analyzePiSessionFile(source);
		if (parsed) parsedSessions.push(parsed);
	}

	parsedSessions.sort((a, b) => (b.summary.updatedAt ?? "").localeCompare(a.summary.updatedAt ?? ""));

	let totalTurns = 0;
	let totalToolCalls = 0;
	let totalToolErrors = 0;
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCostUsd = 0;

	const toolTotals = new Map<string, { calls: number; errors: number }>();
	const modelTotals = new Map<string, { costUsd: number; calls: number }>();
	const commandAgg = new Map<
		string,
		{ total: number; failures: number; sessions: Set<string>; snippets: Set<string> }
	>();
	const skillListingCounts = new Map<string, number>();
	const skillLoadedAny = new Set<string>();
	const instructionSessions = new Map<string, { sample: string; sessions: Set<string> }>();
	const findings: SessionInsightFinding[] = [];

	for (const session of parsedSessions) {
		const s = session.summary;
		totalTurns += s.turns;
		totalToolCalls += s.toolCalls;
		totalToolErrors += s.toolErrors;
		totalInput += s.inputTokens;
		totalOutput += s.outputTokens;
		totalCacheRead += s.cacheReadTokens;
		totalCacheWrite += s.cacheWriteTokens;
		totalCostUsd += s.costUsd;

		for (const [tool, stat] of session.toolStats) {
			const acc = toolTotals.get(tool) ?? { calls: 0, errors: 0 };
			acc.calls += stat.calls;
			acc.errors += stat.errors;
			toolTotals.set(tool, acc);
		}
		for (const [model, stat] of session.modelStats) {
			const acc = modelTotals.get(model) ?? { costUsd: 0, calls: 0 };
			acc.costUsd += stat.costUsd;
			acc.calls += stat.calls;
			modelTotals.set(model, acc);
		}
		for (const run of session.commandRuns) {
			const acc = commandAgg.get(run.commandKey) ?? {
				total: 0,
				failures: 0,
				sessions: new Set<string>(),
				snippets: new Set<string>(),
			};
			acc.total += 1;
			if (run.isError) {
				acc.failures += 1;
				acc.sessions.add(s.sessionId);
				if (run.errorSnippet) acc.snippets.add(run.errorSnippet);
			}
			commandAgg.set(run.commandKey, acc);
		}
		for (const skill of session.listedSkills) {
			skillListingCounts.set(skill, (skillListingCounts.get(skill) ?? 0) + 1);
		}
		for (const skill of session.loadedSkills) {
			skillLoadedAny.add(skill);
		}
		for (const [filePath, count] of session.fileEdits) {
			if (count >= 5) {
				findings.push({
					id: `rework:${s.sessionId}:${filePath}`,
					kind: "file_rework",
					severity: "warn",
					title: `高频返工：${basename(filePath)} 在单会话内被修改 ${count} 次`,
					detail: `文件 ${filePath} 在会话 ${s.sessionId.slice(0, 8)} 中连续编辑/写入 ${count} 次，建议检查是否缺少前置验证或清晰规约。`,
					evidence: [filePath],
					count,
				});
			}
		}
		if (session.consecutiveRepeatMax) {
			const rep = session.consecutiveRepeatMax;
			findings.push({
				id: `repeat-call:${s.sessionId}:${rep.tool}`,
				kind: "repeated_tool_call",
				severity: "warn",
				title: `连续重复调用：${rep.tool} 连续相同参数执行 ${rep.count} 次`,
				detail: `会话 ${s.sessionId.slice(0, 8)} 出现连续 ${rep.count} 次相同参数调用，可能陷入重试循环。`,
				evidence: [rep.sample],
				count: rep.count,
			});
		}
		if (session.claimedTestsPassedWithoutRun) {
			findings.push({
				id: `unverified-claim:${s.sessionId}`,
				kind: "unverified_claim",
				severity: "warn",
				title: `未经测试执行即宣称测试通过（${s.sessionId.slice(0, 8)}）`,
				detail: "回复中包含“测试通过 / tests pass”表述，但该会话未观察到任何测试命令执行记录（启发式审计）。",
				evidence: [s.memberName ? `${s.memberName} (${s.sessionId.slice(0, 8)})` : s.sessionId.slice(0, 8)],
			});
		}

		const seenInSession = new Set<string>();
		for (const instruction of session.userInstructions) {
			const normKey = instruction
				.toLowerCase()
				.replace(/[^\p{L}\p{N}\s]/gu, " ")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 80);
			if (normKey.length < 16 || seenInSession.has(normKey)) continue;
			seenInSession.add(normKey);
			const acc = instructionSessions.get(normKey) ?? {
				sample: truncateLine(redactInsightText(instruction), 100),
				sessions: new Set<string>(),
			};
			acc.sessions.add(s.sessionId);
			instructionSessions.set(normKey, acc);
		}
	}

	// 1. Failing commands
	for (const [cmd, stats] of commandAgg) {
		const failRate = stats.total > 0 ? stats.failures / stats.total : 0;
		if (stats.failures >= 2 && failRate >= 0.25) {
			const pct = Math.round(failRate * 100);
			findings.push({
				id: `failing-cmd:${cmd}`,
				kind: "failing_command",
				severity: "error",
				title: `命令“${cmd}”失败 ${stats.failures}/${stats.total} 次（${pct}%）`,
				detail: `跨 ${stats.sessions.size} 个会话重复失败，建议排查环境脚本或沉淀为固定检查 Skill。`,
				evidence: [...stats.snippets].slice(0, 2),
				count: stats.failures,
				suggestSkillCapture: true,
			});
		}
	}

	// 2. Unused listed skills ("僵尸 Skill")
	const minSessionsForUnused = parsedSessions.length >= 2 ? 2 : 1;
	const unusedSkills = [...skillListingCounts.entries()]
		.filter(([name, count]) => count >= minSessionsForUnused && !skillLoadedAny.has(name))
		.map(([name]) => name)
		.sort();
	if (unusedSkills.length > 0) {
		const estTokens = unusedSkills.length * 28;
		findings.push({
			id: `unused-skills:${unusedSkills.length}`,
			kind: "unused_skill",
			severity: "warn",
			title: `${unusedSkills.length} 个 Skill 已列出但从未被加载（每轮约消耗 ≈${estTokens} tokens）`,
			detail: `从未被按需读取的 Skill：${unusedSkills.slice(0, 10).join("、")}${unusedSkills.length > 10 ? " 等" : ""}。`,
			evidence: unusedSkills.slice(0, 10),
			count: unusedSkills.length,
		});
	}

	// 3. Cost outliers (> 3x median when >= 3 cost-bearing sessions exist)
	const costBearing = parsedSessions.filter((s) => s.summary.costUsd > 0);
	if (costBearing.length >= 3) {
		const med = median(costBearing.map((s) => s.summary.costUsd));
		if (med > 0) {
			const outliers = costBearing.filter((s) => s.summary.costUsd > Math.max(med * 3, 0.05));
			if (outliers.length > 0) {
				const maxSession = outliers.reduce((best, cur) =>
					cur.summary.costUsd > best.summary.costUsd ? cur : best,
				);
				findings.push({
					id: `cost-outlier:${maxSession.summary.sessionId}`,
					kind: "cost_outlier",
					severity: "warn",
					title: `${outliers.length} 个会话成本超过中位数（$${med.toFixed(2)}）的 3 倍`,
					detail: `最高单会话成本 $${maxSession.summary.costUsd.toFixed(2)}（${maxSession.summary.sessionId.slice(0, 8)}），约为中位数的 ${(maxSession.summary.costUsd / med).toFixed(1)}×。`,
					evidence: outliers
						.slice(0, 3)
						.map((o) => `${o.summary.sessionId.slice(0, 8)}: $${o.summary.costUsd.toFixed(2)}`),
					count: outliers.length,
				});
			}
		}
	}

	// 4. Repeated user instructions across sessions -> direct Skill capture signal
	for (const [key, acc] of instructionSessions) {
		if (acc.sessions.size >= 2) {
			findings.push({
				id: `repeated-instruction:${key.slice(0, 24)}`,
				kind: "repeated_instruction",
				severity: "info",
				title: `同类指令跨 ${acc.sessions.size} 个会话重复出现，建议沉淀为 Skill`,
				detail: `“${acc.sample}” — 可通过 propose_skill 将这套步骤或脚本固化，下次直接复用。`,
				evidence: [acc.sample],
				count: acc.sessions.size,
				suggestSkillCapture: true,
			});
		}
	}

	const severityOrder = { error: 0, warn: 1, info: 2 };
	findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || (b.count ?? 0) - (a.count ?? 0));

	return {
		generatedAt: new Date().toISOString(),
		scope: {
			matterId: scope.matterId ?? null,
			memberId: scope.memberId ?? null,
			sessionCount: parsedSessions.length,
		},
		usage: {
			sessions: parsedSessions.length,
			turns: totalTurns,
			toolCalls: totalToolCalls,
			toolErrors: totalToolErrors,
			inputTokens: totalInput,
			outputTokens: totalOutput,
			cacheReadTokens: totalCacheRead,
			cacheWriteTokens: totalCacheWrite,
			totalCostUsd: Number(totalCostUsd.toFixed(4)),
			byModel: [...modelTotals.entries()]
				.map(([model, stat]) => ({ model, costUsd: Number(stat.costUsd.toFixed(4)), calls: stat.calls }))
				.sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls),
			byTool: [...toolTotals.entries()]
				.map(([tool, stat]) => ({ tool, calls: stat.calls, errors: stat.errors }))
				.sort((a, b) => b.calls - a.calls),
		},
		findings: findings.slice(0, 30),
		recentSessions: parsedSessions.slice(0, 20).map((s) => s.summary),
		privacyNote: "仅在本机只读分析 Pi 会话文件，无模型调用、无网络请求；路径与凭据已做脱敏处理。",
	};
}

/** Render a concise Markdown summary suitable for CLI scripts and matter retrospectives. */
export function formatSessionInsightsMarkdown(report: SessionInsightsReport): string {
	const lines: string[] = [];
	lines.push("## 确定性会话洞察（Session Insights）");
	lines.push(
		`- 覆盖范围：${report.usage.sessions} 个 Pi 会话 · ${report.usage.turns} 轮 · ${report.usage.toolCalls} 次工具调用（失败 ${report.usage.toolErrors} 次）`,
	);
	lines.push(
		`- 用量统计：Input ${report.usage.inputTokens} / Output ${report.usage.outputTokens} / CacheRead ${report.usage.cacheReadTokens} · Pi 记录成本 $${report.usage.totalCostUsd.toFixed(4)}`,
	);
	if (report.findings.length === 0) {
		lines.push("- 异常发现：未命中高风险规则（无反复失败命令、无僵尸 Skill、无高频返工或重复死循环）。");
	} else {
		lines.push("### 关键发现");
		for (const item of report.findings) {
			const icon = item.severity === "error" ? "✗" : item.severity === "warn" ? "!" : "·";
			const tag = item.suggestSkillCapture ? " [建议沉淀为 Skill]" : "";
			lines.push(`- ${icon} **${item.title}**${tag}：${item.detail}`);
		}
	}
	if (report.usage.byTool.length > 0) {
		const topTools = report.usage.byTool
			.slice(0, 8)
			.map((t) => `${t.tool} ${t.calls}${t.errors > 0 ? ` (错 ${t.errors})` : ""}`)
			.join(" · ");
		lines.push(`- 高频工具：${topTools}`);
	}
	lines.push(`- 隐私边界：${report.privacyNote}`);
	return lines.join("\n");
}
