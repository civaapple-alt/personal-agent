#!/usr/bin/env node
/**
 * Standalone, zero-dependency, read-only Pi Session Insights CLI for Personal Agent.
 * Adapted in spirit from JetBrains ThinkRail's `@thinkrail/pi-session-insights` (Apache-2.0).
 * Reads local Pi `.jsonl` session transcripts with zero model calls and zero network requests.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../../../..");

const SECRET_PATTERNS = [
	[/-----BEGIN [A-Z0-9 ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]+PRIVATE KEY-----/g, "[redacted-private-key]"],
	[/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]"],
	[/\b(?:sk-[A-Za-z0-9_-]{16,}|pat_[A-Za-z0-9_-]{12,}|gh[pou]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, "[redacted]"],
	[/:\/\/([^/\s:@]+):([^/\s@]+)@/g, "://[redacted]@"],
	[/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[redacted-email]"],
];

function redact(text) {
	let out = String(text ?? "");
	const home = homedir();
	if (home && home.length > 1) out = out.split(home).join("~");
	for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
	return out;
}

function truncate(text, max = 120) {
	const single = String(text ?? "").replace(/\s+/g, " ").trim();
	return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

function extractText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function parseArgs(argv) {
	const opts = { dir: null, db: null, matter: null, limit: 30, json: false, help: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "-h" || arg === "--help") opts.help = true;
		else if (arg === "--json") opts.json = true;
		else if (arg === "--dir") opts.dir = argv[++i] ?? null;
		else if (arg === "--db") opts.db = argv[++i] ?? null;
		else if (arg === "--matter") opts.matter = argv[++i] ?? null;
		else if (arg === "--limit") opts.limit = Math.max(1, Math.min(100, Number(argv[++i] ?? "30") || 30));
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return opts;
}

function discoverFiles(dir, limit) {
	if (!dir || !existsSync(dir)) return [];
	const found = [];
	const visit = (cur, depth) => {
		if (depth > 4) return;
		let entries;
		try {
			entries = readdirSync(cur, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(cur, entry.name);
			if (entry.isDirectory()) visit(full, depth + 1);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				try {
					found.push({ file: full, mtimeMs: statSync(full).mtimeMs });
				} catch {
					// ignore
				}
			}
		}
	};
	visit(resolve(dir), 0);
	found.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return found.slice(0, limit).map((x) => ({ sessionFile: x.file }));
}

function lookupMatterSessions(dbPath, matterId, limit) {
	if (!dbPath || !existsSync(dbPath)) return [];
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const rows = db
			.prepare(
				`SELECT pi_session_id, member_id, session_file, last_active_at
				 FROM worker_sessions WHERE matter_id = ? AND session_file IS NOT NULL
				 ORDER BY last_active_at DESC LIMIT ?`,
			)
			.all(matterId, limit);
		return rows.map((r) => ({
			sessionId: r.pi_session_id ? String(r.pi_session_id) : undefined,
			memberId: String(r.member_id),
			sessionFile: String(r.session_file),
		}));
	} finally {
		db.close();
	}
}

function analyzeFile(source) {
	if (!existsSync(source.sessionFile)) return null;
	const lines = readFileSync(source.sessionFile, "utf8")
		.split(/\r?\n/)
		.filter((l) => l.trim().length > 0);
	let sessionId = source.sessionId ?? basename(source.sessionFile, ".jsonl");
	let turns = 0;
	let toolCalls = 0;
	let toolErrors = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let costUsd = 0;
	const listedSkills = new Set();
	const loadedSkills = new Set();
	const fileEdits = new Map();
	const commands = [];
	const pending = new Map();
	let ranTest = false;
	let claimedTestPass = false;

	const scanSkills = (text) => {
		if (!text.includes("<name>")) return;
		for (const m of text.matchAll(/<skill>[\s\S]*?<name>\s*([a-zA-Z0-9._-]+)\s*<\/name>[\s\S]*?<\/skill>/g)) {
			if (m[1]) listedSkills.add(m[1]);
		}
	};

	for (const line of lines) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		if (entry.type === "session" && typeof entry.id === "string") {
			sessionId = entry.id;
			continue;
		}
		const msg = entry.type === "message" && entry.message ? entry.message : entry;
		if (msg.role === "user") {
			turns += 1;
			scanSkills(extractText(msg.content));
		} else if (msg.role === "system" || msg.role === "custom") {
			scanSkills(extractText(msg.content));
		} else if (msg.role === "assistant") {
			const text = extractText(msg.content);
			if (/(?:all\s+tests?\s+pass|tests?\s+passed|测试(?:全部)?通过)/i.test(text)) claimedTestPass = true;
			if (msg.usage && typeof msg.usage === "object") {
				inputTokens += Number(msg.usage.input ?? 0) || 0;
				outputTokens += Number(msg.usage.output ?? 0) || 0;
				cacheReadTokens += Number(msg.usage.cacheRead ?? 0) || 0;
				costUsd += Number(msg.usage.cost?.total ?? 0) || 0;
			}
			if (Array.isArray(msg.content)) {
				for (const b of msg.content) {
					if (b?.type !== "toolCall" || typeof b.name !== "string") continue;
					toolCalls += 1;
					const args = b.arguments && typeof b.arguments === "object" ? b.arguments : {};
					pending.set(b.id ?? `c_${toolCalls}`, { name: b.name, args });
					if (b.name === "load_available_skill" && typeof args.name === "string") loadedSkills.add(args.name.trim());
					if (b.name === "read" && typeof args.path === "string" && args.path.endsWith("SKILL.md")) {
						const folder = args.path.replaceAll("\\", "/").split("/").at(-2);
						if (folder) loadedSkills.add(folder);
					}
					if ((b.name === "edit" || b.name === "write") && typeof args.path === "string") {
						const p = redact(args.path.trim());
						fileEdits.set(p, (fileEdits.get(p) ?? 0) + 1);
					}
					if ((b.name === "bash" || b.name === "powershell") && typeof args.command === "string") {
						if (/\b(?:npm\s+(?:run\s+)?test|node\s+--test|vitest|jest|pytest|bun\s+test|cargo\s+test|go\s+test)\b/i.test(args.command)) {
							ranTest = true;
						}
					}
				}
			}
		} else if (msg.role === "toolResult") {
			const isError = msg.isError === true;
			if (isError) toolErrors += 1;
			const call = pending.get(msg.toolCallId);
			if (call && (call.name === "bash" || call.name === "powershell") && typeof call.args.command === "string") {
				const tokens = call.args.command.trim().split(/\r?\n/)[0].trim().split(/\s+/).filter(Boolean);
				const key = tokens.slice(0, tokens[0] === "npm" && tokens[1] === "run" ? 3 : 2).join(" ");
				if (key) commands.push({ key, isError, snippet: isError ? truncate(redact(extractText(msg.content)), 100) : "" });
			}
		}
	}

	return {
		sessionId,
		memberId: source.memberId ?? null,
		turns,
		toolCalls,
		toolErrors,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		costUsd: Number(costUsd.toFixed(4)),
		listedSkills,
		loadedSkills,
		fileEdits,
		commands,
		unverifiedTestClaim: claimedTestPass && !ranTest,
	};
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.log(`Usage:
  node pa-extensions/self-inspect/skills/pa-self-inspection/scripts/session-insights.mjs [options]

Options:
  --matter <id>   Inspect Pi sessions linked to a matter ID (read-only SQLite)
  --dir <path>    Override sessions directory (default: <dataDir>/sessions)
  --db <path>     Override SQLite DB path (default: <dataDir>/personal-agent.db)
  --limit <N>     Max sessions to scan (default: 30)
  --json          Output structured JSON`);
		return;
	}
	const dataDir = resolve(process.env.PA_DATA_DIR || join(REPO_ROOT, ".data"));
	const sessionsDir = resolve(opts.dir || join(dataDir, "sessions"));
	const dbPath = resolve(opts.db || process.env.PA_DB_PATH || join(dataDir, "personal-agent.db"));
	const sources = opts.matter ? lookupMatterSessions(dbPath, opts.matter, opts.limit) : discoverFiles(sessionsDir, opts.limit);
	const parsed = sources.map(analyzeFile).filter(Boolean);

	const findings = [];
	const cmdAgg = new Map();
	const listed = new Map();
	const loaded = new Set();
	for (const s of parsed) {
		for (const c of s.commands) {
			const acc = cmdAgg.get(c.key) ?? { total: 0, fail: 0, snippet: "" };
			acc.total += 1;
			if (c.isError) {
				acc.fail += 1;
				if (!acc.snippet && c.snippet) acc.snippet = c.snippet;
			}
			cmdAgg.set(c.key, acc);
		}
		for (const sk of s.listedSkills) listed.set(sk, (listed.get(sk) ?? 0) + 1);
		for (const sk of s.loadedSkills) loaded.add(sk);
		for (const [fp, cnt] of s.fileEdits) {
			if (cnt >= 5) findings.push({ kind: "file_rework", severity: "warn", title: `Rework: ${basename(fp)} edited ${cnt}x in ${s.sessionId.slice(0, 8)}`, detail: fp });
		}
		if (s.unverifiedTestClaim) {
			findings.push({ kind: "unverified_claim", severity: "warn", title: `Unverified test claim in ${s.sessionId.slice(0, 8)}`, detail: "Assistant claimed tests passed without a test command run" });
		}
	}
	for (const [cmd, st] of cmdAgg) {
		if (st.fail >= 2 && st.fail / st.total >= 0.25) {
			findings.push({ kind: "failing_command", severity: "error", title: `Command "${cmd}" failed ${st.fail}/${st.total}`, detail: st.snippet || "Repeated failure" });
		}
	}
	const minSessions = parsed.length >= 2 ? 2 : 1;
	const unused = [...listed.entries()].filter(([k, c]) => c >= minSessions && !loaded.has(k)).map(([k]) => k).sort();
	if (unused.length > 0) {
		findings.push({ kind: "unused_skill", severity: "warn", title: `${unused.length} listed skills never loaded`, detail: unused.join(", ") });
	}

	const report = {
		generatedAt: new Date().toISOString(),
		sessions: parsed.length,
		turns: parsed.reduce((a, b) => a + b.turns, 0),
		toolCalls: parsed.reduce((a, b) => a + b.toolCalls, 0),
		toolErrors: parsed.reduce((a, b) => a + b.toolErrors, 0),
		inputTokens: parsed.reduce((a, b) => a + b.inputTokens, 0),
		outputTokens: parsed.reduce((a, b) => a + b.outputTokens, 0),
		cacheReadTokens: parsed.reduce((a, b) => a + b.cacheReadTokens, 0),
		totalCostUsd: Number(parsed.reduce((a, b) => a + b.costUsd, 0).toFixed(4)),
		findings,
	};

	if (opts.json) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}
	console.log(`Session Insights · ${report.sessions} sessions · ${report.turns} turns · ${report.toolCalls} tool calls (${report.toolErrors} errors) · $${report.totalCostUsd}`);
	if (findings.length === 0) {
		console.log("  No rule findings.");
	} else {
		for (const f of findings) {
			console.log(`  [${f.severity}] ${f.title}${f.detail ? ` — ${f.detail}` : ""}`);
		}
	}
}

main();
