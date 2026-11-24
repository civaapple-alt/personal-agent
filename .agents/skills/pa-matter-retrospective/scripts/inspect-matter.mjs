#!/usr/bin/env node
/**
 * Read-only matter retrospective inspector for Personal Agent (PA).
 *
 * Works with both:
 *   - Local personal loopback mode: `PORT=4310 npm run start:web` (HTTP read-only API)
 *   - Authenticated team mode:      `PA_REQUIRE_AUTH=1 PA_HOST=0.0.0.0 PORT=4310 npm run start:web`
 *     (HTTP with `--token` / `PA_TOKEN`, `--email` + `--password`, or automatic read-only SQLite fallback)
 *
 * Strictly read-only: never writes to the database, sessions, or triggers AI turns.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../../..");

function printHelp() {
	console.log(`Usage:
  node .agents/skills/pa-matter-retrospective/scripts/inspect-matter.mjs <matter-url-or-id> [options]
  node .agents/skills/pa-matter-retrospective/scripts/inspect-matter.mjs --recent [N] [options]

Options:
  --source <auto|api|db>   Data source strategy (default: auto)
  --base-url <url>         Override workbench base URL (default: from URL or http://127.0.0.1:4310)
  --token <token>          Bearer / X-PA-Token for authenticated HTTP (or env PA_TOKEN)
  --email <email>          Account email for authenticated HTTP login (or env PA_EMAIL)
  --password <password>    Account password for authenticated HTTP login (or env PA_PASSWORD)
  --db <path>              Local SQLite DB path (default: <dataDir>/personal-agent.db)
  --sessions               Also inspect associated Pi session JSONL files (read-only)
  --insights               Include deterministic Session Insights (failing commands, unused skills, rework, cost)
  --full                   Do not truncate long message or tool contents
  --json                   Output structured JSON instead of Markdown summary
  --recent [N]             List the most recent N matters (default: 10)
  -h, --help               Show this help

Examples:
  node .agents/skills/pa-matter-retrospective/scripts/inspect-matter.mjs http://127.0.0.1:4310/#/chats/mat_xxx
  PA_TOKEN=pat_xxx node .agents/skills/pa-matter-retrospective/scripts/inspect-matter.mjs http://127.0.0.1:4310/#/chats/mat_xxx --sessions
  PA_EMAIL=admin@example.com PA_PASSWORD=secret node .agents/skills/pa-matter-retrospective/scripts/inspect-matter.mjs http://127.0.0.1:4310/#/chats/mat_xxx
  node .agents/skills/pa-matter-retrospective/scripts/inspect-matter.mjs mat_xxx --source db --sessions
  node .agents/skills/pa-matter-retrospective/scripts/inspect-matter.mjs --recent 5`);
}

function parseArgs(argv) {
	const opts = {
		target: null,
		source: "auto",
		baseUrl: null,
		token: process.env.PA_TOKEN || null,
		email: process.env.PA_EMAIL || null,
		password: process.env.PA_PASSWORD || null,
		dbPath: null,
		sessions: false,
		insights: false,
		full: false,
		json: false,
		recent: null,
		help: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "-h" || arg === "--help") {
			opts.help = true;
		} else if (arg === "--sessions") {
			opts.sessions = true;
		} else if (arg === "--insights") {
			opts.insights = true;
		} else if (arg === "--full") {
			opts.full = true;
		} else if (arg === "--json") {
			opts.json = true;
		} else if (arg === "--source") {
			opts.source = argv[++i] ?? "auto";
		} else if (arg === "--base-url") {
			opts.baseUrl = argv[++i] ?? null;
		} else if (arg === "--token") {
			opts.token = argv[++i] ?? null;
		} else if (arg === "--email") {
			opts.email = argv[++i] ?? null;
		} else if (arg === "--password") {
			opts.password = argv[++i] ?? null;
		} else if (arg === "--db") {
			opts.dbPath = argv[++i] ?? null;
		} else if (arg === "--recent") {
			const next = argv[i + 1];
			if (next && /^\d+$/u.test(next)) {
				opts.recent = Number.parseInt(next, 10);
				i += 1;
			} else {
				opts.recent = 10;
			}
		} else if (!arg.startsWith("-") && !opts.target) {
			opts.target = arg;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!["auto", "api", "db"].includes(opts.source)) {
		throw new Error(`Invalid --source value: ${opts.source} (expected auto|api|db)`);
	}
	return opts;
}

function parseTarget(target) {
	if (!target) return { matterId: null, origin: null };
	const trimmed = target.trim();
	if (/^https?:\/\//iu.test(trimmed)) {
		const parsed = new URL(trimmed);
		const hashMatch = parsed.hash.match(/\/chats\/([^/?#]+)/u);
		const pathMatch = parsed.pathname.match(/\/(?:api\/matters|chats)\/([^/?#]+)/u);
		const matterId = decodeURIComponent((hashMatch?.[1] ?? pathMatch?.[1] ?? "").trim()) || null;
		const host = parsed.hostname === "0.0.0.0" ? "127.0.0.1" : parsed.hostname;
		const origin = `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ""}`;
		return { matterId, origin };
	}
	return { matterId: trimmed, origin: null };
}

function resolveDefaultBaseUrl(originFromTarget) {
	if (originFromTarget) return originFromTarget;
	const port = process.env.PA_PORT || process.env.PORT || "4310";
	const rawHost = process.env.PA_HOST || "127.0.0.1";
	const host = rawHost === "0.0.0.0" || rawHost === "::" ? "127.0.0.1" : rawHost;
	return `http://${host}:${port}`;
}

function resolveDefaultDbPath() {
	if (process.env.PA_DB_PATH) return resolve(process.env.PA_DB_PATH);
	const dataDir = process.env.PA_DATA_DIR ? resolve(process.env.PA_DATA_DIR) : resolve(REPO_ROOT, ".data");
	return resolve(dataDir, "personal-agent.db");
}

function getRepoGitHead() {
	try {
		return execFileSync("git", ["-C", REPO_ROOT, "log", "-1", "--format=%h %cs %s"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

function safeJsonParse(raw, fallback = null) {
	if (typeof raw !== "string" || !raw) return fallback;
	try {
		return JSON.parse(raw);
	} catch {
		return fallback;
	}
}

function truncate(text, maxLen, full) {
	if (typeof text !== "string") return "";
	if (full || text.length <= maxLen) return text;
	return `${text.slice(0, maxLen)}…[truncated, total ${text.length} chars]`;
}

async function fetchJson(url, token) {
	const headers = { Accept: "application/json" };
	if (token) headers.Authorization = `Bearer ${token}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5000);
	try {
		const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
		const text = await res.text();
		const body = safeJsonParse(text, { raw: text });
		return { ok: res.ok, status: res.status, body };
	} catch (error) {
		return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error), body: null };
	} finally {
		clearTimeout(timer);
	}
}

async function loginWithCredentials(baseUrl, email, password) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5000);
	try {
		const res = await fetch(`${baseUrl}/api/auth/login`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				Origin: baseUrl,
			},
			body: JSON.stringify({ email, password }),
			signal: controller.signal,
		});
		const text = await res.text();
		const body = safeJsonParse(text, { raw: text });
		if (!res.ok) {
			return {
				ok: false,
				token: null,
				reason: `login HTTP ${res.status}${body?.error ? ` (${body.error})` : ""}`,
			};
		}
		const setCookies =
			typeof res.headers.getSetCookie === "function"
				? res.headers.getSetCookie()
				: [res.headers.get("set-cookie")].filter(Boolean);
		const match = setCookies.join("; ").match(/pa_session=([^;]+)/u);
		const rawToken = match?.[1]?.trim() || null;
		if (!rawToken) {
			return { ok: false, token: null, reason: "login succeeded without session token" };
		}
		return { ok: true, token: rawToken, reason: null };
	} catch (error) {
		return { ok: false, token: null, reason: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
}

async function logoutSession(baseUrl, token) {
	if (!token) return;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 3000);
	try {
		await fetch(`${baseUrl}/api/auth/logout`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, Origin: baseUrl },
			signal: controller.signal,
		});
	} catch {
		// Best-effort cleanup of temporary inspection session.
	} finally {
		clearTimeout(timer);
	}
}

function openReadOnlyDb(dbPath) {
	if (!existsSync(dbPath)) {
		throw new Error(`SQLite database not found: ${dbPath}`);
	}
	return new DatabaseSync(dbPath, { readOnly: true });
}

function queryRecentFromDb(dbPath, limit) {
	const db = openReadOnlyDb(dbPath);
	try {
		return db
			.prepare(
				`SELECT m.id, m.title, m.status, m.visibility, m.org_id, m.workspace_id, m.lead_member_id,
				        m.created_at, m.updated_at, w.name AS workspace_name, w.repo_path,
				        (SELECT COUNT(*) FROM matter_messages mm WHERE mm.matter_id = m.id AND mm.channel = 'user') AS user_msg_count
				 FROM matters m
				 LEFT JOIN workspace_links w ON w.id = m.workspace_id
				 ORDER BY m.updated_at DESC
				 LIMIT ?`,
			)
			.all(limit);
	} finally {
		db.close();
	}
}

function normalizeDbMessage(row) {
	return {
		id: row.id,
		matterId: row.matter_id,
		channel: row.channel,
		senderType: row.sender_type,
		senderId: row.sender_id,
		senderName: row.sender_name,
		content: row.content,
		createdAt: row.created_at,
		metadata: safeJsonParse(row.metadata_json, {}),
	};
}

function queryMatterFromDb(dbPath, matterId) {
	const db = openReadOnlyDb(dbPath);
	try {
		const m = db.prepare("SELECT * FROM matters WHERE id = ?").get(matterId);
		if (!m) return null;
		const org = m.org_id ? db.prepare("SELECT id, name, slug, use_role_git_identity FROM organizations WHERE id = ?").get(m.org_id) : null;
		const workspace = m.workspace_id
			? db
					.prepare(
						"SELECT id, org_id, name, repo_path, default_branch, source_type, clone_url, visibility FROM workspace_links WHERE id = ?",
					)
					.get(m.workspace_id)
			: null;
		const workspaceFolders = m.workspace_id
			? db
					.prepare(
						"SELECT id, label, path, source_type, role, load_rules, load_skills FROM workspace_folders WHERE workspace_id = ? ORDER BY sort_order ASC",
					)
					.all(m.workspace_id)
			: [];
		const allMessages = db
			.prepare("SELECT * FROM matter_messages WHERE matter_id = ? ORDER BY created_at ASC, rowid ASC")
			.all(matterId)
			.map(normalizeDbMessage);
		const workerSessions = db
			.prepare(
				`SELECT id, member_id, workspace_id, pi_session_id, session_file, status, last_active_at, context_key, message_cursor
				 FROM worker_sessions WHERE matter_id = ? ORDER BY last_active_at ASC, rowid ASC`,
			)
			.all(matterId);
		const spaceDocuments = db
			.prepare(
				`SELECT id, space_id, title, doc_type, entry_kind, file_path, head_commit, revision, updated_at
				 FROM space_documents WHERE matter_id = ? ORDER BY updated_at DESC`,
			)
			.all(matterId);
		const settingsRow = db.prepare("SELECT value_json, updated_at FROM platform_settings WHERE key = 'platform_settings'").get();
		const rawSettings = safeJsonParse(settingsRow?.value_json, null);
		const safeSettings = rawSettings
			? {
					registrationMode: rawSettings.registrationMode,
					allowLocalWorkspacePath: rawSettings.allowLocalWorkspacePath,
					allowCommandPreviews: rawSettings.allowCommandPreviews,
					systemOneEnabled: rawSettings.systemOneEnabled,
					webSearchProvider: rawSettings.webSearchProvider,
					defaultModelSelection: rawSettings.defaultModelSelection,
					updatedAt: settingsRow?.updated_at ?? null,
				}
			: null;

		return {
			matter: {
				id: m.id,
				title: m.title,
				status: m.status,
				visibility: m.visibility,
				orgId: m.org_id,
				workspaceId: m.workspace_id,
				leadMemberId: m.lead_member_id,
				aiMemberIds: safeJsonParse(m.ai_member_ids_json, []),
				consultMemberIds: safeJsonParse(m.consult_member_ids_json, null),
				observersEnabled: Boolean(m.observers_enabled),
				observerMemberIds: safeJsonParse(m.observer_ids_json, []),
				discussionAiEnabled: Boolean(m.discussion_ai_enabled),
				modelSelection: safeJsonParse(m.model_selection_json, null),
				createdByUserId: m.created_by_user_id,
				createdAt: m.created_at,
				updatedAt: m.updated_at,
			},
			organization: org,
			workspace,
			workspaceFolders,
			userMessages: allMessages.filter((msg) => msg.channel === "user"),
			internalCollabMessages: allMessages.filter((msg) => msg.channel === "internal_collab"),
			noticeMessages: allMessages.filter((msg) => msg.channel === "notice"),
			workerSessions,
			spaceDocuments,
			platformSettings: safeSettings,
		};
	} finally {
		db.close();
	}
}

function summarizeWorkerSessions(workerSessions) {
	const byKey = new Map();
	for (const s of workerSessions ?? []) {
		const key = `${s.member_id}|${s.pi_session_id}|${s.context_key}`;
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, {
				memberId: s.member_id,
				piSessionId: s.pi_session_id,
				sessionFile: s.session_file,
				fileExists: Boolean(s.session_file && existsSync(s.session_file)),
				contextKey: s.context_key,
				recordCount: 1,
				firstActiveAt: s.last_active_at,
				lastActiveAt: s.last_active_at,
			});
		} else {
			existing.recordCount += 1;
			existing.lastActiveAt = s.last_active_at;
		}
	}
	return [...byKey.values()];
}

function inspectPiSessionFile(sessionFile, full) {
	if (!sessionFile || !existsSync(sessionFile)) {
		return { sessionFile, exists: false, entries: [] };
	}
	const lines = readFileSync(sessionFile, "utf8").split(/\r?\n/u).filter(Boolean);
	const summary = {
		sessionFile,
		exists: true,
		lineCount: lines.length,
		header: null,
		modelChanges: [],
		turns: [],
	};
	let currentTurn = null;
	for (let i = 0; i < lines.length; i += 1) {
		const obj = safeJsonParse(lines[i]);
		if (!obj) continue;
		if (obj.type === "session") {
			summary.header = { id: obj.id, cwd: obj.cwd, timestamp: obj.timestamp };
		} else if (obj.type === "model_change") {
			summary.modelChanges.push({ provider: obj.provider, modelId: obj.modelId, timestamp: obj.timestamp });
		} else if (obj.type === "message") {
			const msg = obj.message ?? {};
			const role = msg.role;
			const parts = Array.isArray(msg.content) ? msg.content : typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [];
			if (role === "user") {
				const text = parts
					.filter((p) => p.type === "text")
					.map((p) => p.text ?? "")
					.join("\n");
				currentTurn = {
					line: i + 1,
					timestamp: obj.timestamp,
					userChars: text.length,
					hasStartupEvidence: text.includes("[Current worker startup evidence]"),
					hasWorkbenchRef: text.includes("[PA workbench reference for this turn]"),
					userPreview: truncate(text.replace(/\[Current worker startup evidence\][\s\S]*?\[\/Current worker startup evidence\]\s*/u, ""), 240, full),
					toolCalls: [],
					toolResults: [],
					assistantChars: 0,
				};
				summary.turns.push(currentTurn);
			} else if (role === "assistant") {
				if (!currentTurn) {
					currentTurn = { line: i + 1, timestamp: obj.timestamp, toolCalls: [], toolResults: [], assistantChars: 0 };
					summary.turns.push(currentTurn);
				}
				for (const part of parts) {
					if (part.type === "toolCall") {
						currentTurn.toolCalls.push({
							id: part.id,
							name: part.name,
							args: truncate(JSON.stringify(part.arguments ?? {}), 240, full),
						});
					} else if (part.type === "text") {
						currentTurn.assistantChars += (part.text ?? "").length;
					}
				}
			} else if (role === "toolResult") {
				const text = parts
					.filter((p) => p.type === "text")
					.map((p) => p.text ?? "")
					.join("\n");
				if (currentTurn) {
					currentTurn.toolResults.push({
						toolName: msg.toolName,
						isError: Boolean(msg.isError),
						chars: text.length,
						preview: truncate(text, 280, full),
					});
				}
			}
		}
	}
	return summary;
}

function buildTurnsTimeline(data, full) {
	const userMessages = data.userMessages ?? [];
	const notices = data.noticeMessages ?? [];
	const collab = data.internalCollabMessages ?? [];

	const turns = [];
	const byUserMsgId = new Map();
	for (const msg of userMessages) {
		if (msg.senderType === "user") {
			const turn = {
				userMessageId: msg.id,
				createdAt: msg.createdAt,
				author: msg.metadata?.authorName || msg.senderName || msg.senderId,
				targetMemberId: msg.metadata?.targetMemberId ?? null,
				decisionSource: msg.metadata?.conversationDecisionSource ?? null,
				content: truncate(msg.content, 600, full),
				runtimeReady: [],
				toolCalls: [],
				usage: [],
				collabMessages: [],
				replies: [],
				otherNotices: [],
			};
			turns.push(turn);
			byUserMsgId.set(msg.id, turn);
		}
	}

	const orphanReplies = [];
	for (const msg of userMessages) {
		if (msg.senderType !== "user") {
			const srcId = msg.metadata?.sourceUserMessageId;
			const target = srcId ? byUserMsgId.get(srcId) : turns.at(-1);
			const reply = {
				id: msg.id,
				senderId: msg.senderId,
				createdAt: msg.createdAt,
				toolsUsed: msg.metadata?.toolsUsed ?? [],
				workbenchHelpTopic: msg.metadata?.workbenchHelpTopic ?? null,
				aborted: Boolean(msg.metadata?.aborted),
				elapsedSeconds: msg.metadata?.progressSnapshot?.elapsedSeconds ?? null,
				content: truncate(msg.content, 800, full),
			};
			if (target) target.replies.push(reply);
			else orphanReplies.push(reply);
		}
	}

	for (const msg of collab) {
		const srcId = msg.metadata?.sourceUserMessageId;
		const target = srcId ? byUserMsgId.get(srcId) : turns.at(-1);
		const entry = {
			id: msg.id,
			senderId: msg.senderId,
			createdAt: msg.createdAt,
			kind: msg.metadata?.kind ?? msg.metadata?.delegationKind ?? null,
			content: truncate(msg.content, 400, full),
		};
		if (target) target.collabMessages.push(entry);
	}

	for (const n of notices) {
		const srcId = n.metadata?.sourceUserMessageId ?? safeJsonParse(n.content)?.sourceUserMessageId;
		const target = srcId ? byUserMsgId.get(srcId) : turns.at(-1);
		if (!target) continue;
		const payload = safeJsonParse(n.content);
		if (payload?.method === "runtime_ready") {
			target.runtimeReady.push({
				memberId: n.senderId,
				sessionMode: payload.sessionMode,
				discussionMode: payload.discussionMode,
				resourcePolicy: payload.resourcePolicy,
				resumed: payload.resumed,
				model: payload.model,
				toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
				tools: payload.tools ?? [],
				skills: payload.skills ?? [],
				piSessionId: payload.piSessionId,
			});
		} else if (payload?.type === "tool_execution_start") {
			target.toolCalls.push({
				toolCallId: payload.toolCallId,
				memberId: n.senderId,
				toolName: payload.toolName,
				args: payload.args ? truncate(JSON.stringify(payload.args), 220, full) : null,
				status: "started",
				isError: null,
			});
		} else if (payload?.type === "tool_execution_end") {
			const match = target.toolCalls.find((c) => c.toolCallId === payload.toolCallId);
			if (match) {
				match.status = "ended";
				match.isError = Boolean(payload.isError);
			} else {
				target.toolCalls.push({
					toolCallId: payload.toolCallId,
					memberId: n.senderId,
					toolName: payload.toolName,
					args: null,
					status: "ended_without_start",
					isError: Boolean(payload.isError),
				});
			}
		} else if (payload?.method === "runtime_model_usage") {
			target.usage.push({
				memberId: n.senderId,
				resumed: payload.resumed,
				requests: payload.requests,
				firstInput: payload.firstRequest?.input ?? null,
				firstCacheRead: payload.firstRequest?.cacheRead ?? null,
				totalInput: payload.totals?.input ?? null,
				totalCacheRead: payload.totals?.cacheRead ?? null,
			});
		} else {
			target.otherNotices.push({
				id: n.id,
				senderId: n.senderId,
				createdAt: n.createdAt,
				content: truncate(n.content, 300, full),
			});
		}
	}

	return { turns, orphanReplies };
}

function renderRecentMarkdown(items, sourceInfo) {
	const lines = [
		`# Recent Matters (${items.length})`,
		"",
		`- Source: \`${sourceInfo.source}\`${sourceInfo.note ? ` (${sourceInfo.note})` : ""}`,
		`- Repo HEAD: \`${sourceInfo.repoHead ?? "unknown"}\``,
		"",
		"| Updated | Matter ID | Title | Lead | Workspace | Status | User Msgs |",
		"| --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const m of items) {
		const id = m.id;
		const title = (m.title ?? "").replace(/\|/gu, "\\|").slice(0, 50);
		const lead = m.lead_member_id ?? m.leadMemberId ?? "-";
		const ws = m.workspace_name ?? m.workspaceId ?? "-";
		const updated = m.updated_at ?? m.updatedAt ?? "-";
		const count = m.user_msg_count ?? "-";
		lines.push(`| ${updated} | \`${id}\` | ${title} | ${lead} | ${ws} | ${m.status} | ${count} |`);
	}
	return lines.join("\n");
}

function renderReportMarkdown(report) {
	const { sourceInfo, runtime, data, sessionGroups, timeline, piSessions } = report;
	const m = data.matter;
	const lines = [
		`# Matter Retrospective Snapshot: \`${m.id}\``,
		"",
		"## 1. Data Source & Runtime",
		`- Data source: \`${sourceInfo.source}\`${sourceInfo.httpFallbackReason ? ` (HTTP fallback: ${sourceInfo.httpFallbackReason})` : ""}`,
		`- Workbench URL: \`${sourceInfo.baseUrl}\``,
		`- Local DB: \`${sourceInfo.dbPath}\``,
		`- Repo HEAD: \`${sourceInfo.repoHead ?? "unknown"}\``,
	];

	if (runtime?.base) {
		lines.push(
			`- Live /api/runtime: Pi CLI \`${runtime.base.version ?? "unknown"}\`, Node \`${runtime.base.nodeVersion ?? "unknown"}\`, platform \`${runtime.base.platform ?? "unknown"}\`, webAccess \`${runtime.base.webAccess?.installedVersion ?? "none"}\` (provider: \`${runtime.base.webAccess?.effectiveProvider ?? "none"}\`), systemOne \`${String(runtime.base.systemOne?.enabled ?? false)}\``,
		);
	} else if (data.platformSettings) {
		lines.push(
			`- DB platform_settings (live /api/runtime unavailable): registrationMode=\`${data.platformSettings.registrationMode}\`, allowLocalWorkspacePath=\`${data.platformSettings.allowLocalWorkspacePath}\`, systemOneEnabled=\`${data.platformSettings.systemOneEnabled}\`, webSearchProvider=\`${data.platformSettings.webSearchProvider}\``,
		);
	}

	lines.push(
		"",
		"## 2. Matter Overview",
		`- Title: ${m.title}`,
		`- Status: \`${m.status}\` | Visibility: \`${m.visibility ?? m.visibilityScope ?? "unknown"}\` | Created: ${m.createdAt} | Updated: ${m.updatedAt}`,
		`- Org: \`${m.orgId ?? "none"}\`${data.organization ? ` (${data.organization.name})` : ""}`,
		`- Workspace: \`${m.workspaceId ?? "none"}\`${data.workspace ? ` (${data.workspace.name}, path=\`${data.workspace.repo_path}\`, source=\`${data.workspace.source_type}\`)` : ""}`,
		`- Lead: \`${m.leadMemberId ?? "none"}\` | AI roster: \`${JSON.stringify(m.aiMemberIds ?? [])}\` | Consult: \`${JSON.stringify(m.consultMemberIds ?? null)}\` | Observers: \`${m.observersEnabled ? JSON.stringify(m.observerMemberIds ?? []) : "disabled"}\``,
		`- Model override: \`${JSON.stringify(m.modelSelection ?? null)}\` | Space docs: ${(data.spaceDocuments ?? []).length}`,
	);

	if ((data.workspaceFolders ?? []).length > 0) {
		lines.push("- Workspace folders:");
		for (const f of data.workspaceFolders) {
			lines.push(
				`  - [${f.role}] \`${f.label}\`: \`${f.path}\` (rules=${Boolean(f.load_rules)}, skills=${Boolean(f.load_skills)})`,
			);
		}
	}

	if (sessionGroups.length > 0) {
		lines.push("", "## 3. Worker Sessions");
		for (const s of sessionGroups) {
			lines.push(
				`- \`${s.memberId}\` | piSession=\`${s.piSessionId}\` | rows=${s.recordCount} | fileExists=${s.fileExists} | contextKey=\`${s.contextKey}\``,
			);
			lines.push(`  - file: \`${s.sessionFile}\``);
		}
	}

	lines.push("", `## 4. Turns Timeline (${timeline.turns.length} turns)`);
	timeline.turns.forEach((turn, idx) => {
		lines.push(
			"",
			`### Turn ${idx + 1} (${turn.createdAt}) — \`${turn.userMessageId}\``,
			`- User (${turn.author}, route=\`${turn.decisionSource ?? "unknown"}\` → \`${turn.targetMemberId ?? "unknown"}\`): ${turn.content}`,
		);
		for (const rr of turn.runtimeReady) {
			lines.push(
				`- Startup [\`${rr.memberId}\`]: mode=\`${rr.sessionMode}\`, policy=\`${rr.resourcePolicy}\`, resumed=\`${rr.resumed}\`, model=\`${rr.model?.provider}/${rr.model?.model}\` (thinking=\`${rr.model?.thinkingLevel ?? "default"}\`), tools=${rr.toolCount}, skills=${rr.skills.length}`,
			);
		}
		if (turn.toolCalls.length > 0) {
			lines.push("- Tool calls:");
			for (const tc of turn.toolCalls) {
				lines.push(
					`  - \`${tc.toolName}\` (${tc.memberId}) status=\`${tc.status}\` isError=\`${tc.isError}\`${tc.args ? ` args=${tc.args}` : ""}`,
				);
			}
		} else {
			lines.push("- Tool calls: none");
		}
		if (turn.collabMessages.length > 0) {
			lines.push(`- Internal collab (${turn.collabMessages.length}):`);
			for (const c of turn.collabMessages) {
				lines.push(`  - [${c.senderId}] ${c.content}`);
			}
		}
		for (const u of turn.usage) {
			lines.push(
				`- Usage [\`${u.memberId}\`]: requests=${u.requests}, firstInput=${u.firstInput}, firstCacheRead=${u.firstCacheRead}, totalInput=${u.totalInput}, totalCacheRead=${u.totalCacheRead}`,
			);
		}
		for (const r of turn.replies) {
			lines.push(
				`- Reply [\`${r.senderId}\`] (${r.elapsedSeconds ?? "?"}s, toolsUsed=\`${JSON.stringify(r.toolsUsed)}\`${r.workbenchHelpTopic ? `, helpTopic=\`${r.workbenchHelpTopic}\`` : ""}${r.aborted ? ", ABORTED" : ""}):`,
			);
			lines.push(`  > ${r.content.replace(/\n/gu, "\n  > ")}`);
		}
		if (turn.otherNotices.length > 0) {
			lines.push(`- Other notices (${turn.otherNotices.length}):`);
			for (const on of turn.otherNotices) {
				lines.push(`  - [${on.senderId}] ${on.content}`);
			}
		}
	});

	if (piSessions.length > 0) {
		lines.push("", "## 5. Pi Session JSONL Inspection (read-only)");
		for (const ps of piSessions) {
			lines.push(`### Session: \`${ps.sessionFile}\` (exists=${ps.exists}, lines=${ps.lineCount ?? 0})`);
			if (!ps.exists) continue;
			for (let i = 0; i < ps.turns.length; i += 1) {
				const t = ps.turns[i];
				lines.push(
					`- Pi Turn ${i + 1} (line ${t.line}, ${t.timestamp}): userChars=${t.userChars}, startupEvidence=${t.hasStartupEvidence}, workbenchRef=${t.hasWorkbenchRef}, toolCalls=${t.toolCalls.length}, assistantChars=${t.assistantChars}`,
				);
				for (const tc of t.toolCalls) {
					lines.push(`  - call \`${tc.name}\` ${tc.args}`);
				}
				for (const tr of t.toolResults) {
					lines.push(`  - result \`${tr.toolName}\` isError=${tr.isError} chars=${tr.chars}: ${tr.preview}`);
				}
			}
		}
	}

	return lines.join("\n");
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help || (!opts.target && opts.recent === null)) {
		printHelp();
		process.exit(opts.help ? 0 : 1);
	}

	const parsed = parseTarget(opts.target);
	const baseUrl = (opts.baseUrl || resolveDefaultBaseUrl(parsed.origin)).replace(/\/+$/u, "");
	const dbPath = opts.dbPath ? resolve(opts.dbPath) : resolveDefaultDbPath();
	const repoHead = getRepoGitHead();

	let activeToken = opts.token;
	let tempLoginToken = null;
	let loginFailureReason = null;
	if (opts.source !== "db" && !activeToken && opts.email && opts.password) {
		const loginRes = await loginWithCredentials(baseUrl, opts.email, opts.password);
		if (loginRes.ok) {
			activeToken = loginRes.token;
			tempLoginToken = loginRes.token;
		} else {
			loginFailureReason = loginRes.reason;
			if (opts.source === "api") {
				throw new Error(`Authenticated login failed: ${loginRes.reason}`);
			}
		}
	}

	try {
		if (opts.recent !== null) {
			let items = null;
			let source = null;
			let note = null;
			if (opts.source !== "db" && !loginFailureReason) {
				const res = await fetchJson(`${baseUrl}/api/bootstrap`, activeToken);
				if (res.ok && Array.isArray(res.body?.matters)) {
					items = res.body.matters.slice(0, opts.recent);
					source = "http-api";
				} else if (opts.source === "api") {
					throw new Error(`HTTP /api/bootstrap failed (${res.status || res.error}): ${JSON.stringify(res.body)}`);
				} else {
					note = `HTTP /api/bootstrap ${res.status || res.error}, fell back to SQLite read-only`;
				}
			} else if (loginFailureReason) {
				note = `${loginFailureReason}, fell back to SQLite read-only`;
			}
			if (!items) {
				items = queryRecentFromDb(dbPath, opts.recent);
				source = "sqlite-readonly";
			}
			if (opts.json) {
				console.log(JSON.stringify({ source, note, repoHead, matters: items }, null, 2));
			} else {
				console.log(renderRecentMarkdown(items, { source, note, repoHead }));
			}
			return;
		}

		if (!parsed.matterId) {
			throw new Error(`Could not extract matter ID from: ${opts.target}`);
		}

		let data = null;
		let runtime = null;
		let source = null;
		let httpFallbackReason = loginFailureReason;

		if (opts.source !== "db" && !loginFailureReason) {
			const [matterRes, runtimeRes] = await Promise.all([
				fetchJson(`${baseUrl}/api/matters/${encodeURIComponent(parsed.matterId)}`, activeToken),
				fetchJson(`${baseUrl}/api/runtime`, activeToken),
			]);
			if (runtimeRes.ok) runtime = runtimeRes.body;
			if (matterRes.ok && matterRes.body?.matter) {
				source = "http-api";
				data = matterRes.body;
				// Supplement worker_sessions / workspace_folders from local DB (read-only) if present.
				if (existsSync(dbPath)) {
					const dbSupplement = queryMatterFromDb(dbPath, parsed.matterId);
					if (dbSupplement) {
						data.organization = dbSupplement.organization;
						data.workspace = dbSupplement.workspace;
						data.workspaceFolders = dbSupplement.workspaceFolders;
						data.workerSessions = dbSupplement.workerSessions;
						data.platformSettings = dbSupplement.platformSettings;
					}
				}
			} else if (opts.source === "api") {
				throw new Error(
					`HTTP GET /api/matters/${parsed.matterId} failed (${matterRes.status || matterRes.error}): ${JSON.stringify(matterRes.body)}`,
				);
			} else {
				httpFallbackReason = matterRes.status
					? `HTTP ${matterRes.status}${matterRes.body?.error ? ` (${matterRes.body.error})` : ""}`
					: matterRes.error || "unreachable";
			}
		}

		if (!data) {
			data = queryMatterFromDb(dbPath, parsed.matterId);
			if (!data) {
				throw new Error(`Matter not found in ${dbPath}: ${parsed.matterId}`);
			}
			source = "sqlite-readonly";
		}

		const sessionGroups = summarizeWorkerSessions(data.workerSessions);
		const timeline = buildTurnsTimeline(data, opts.full);
		const piSessions = opts.sessions
			? sessionGroups.map((s) => inspectPiSessionFile(s.sessionFile, opts.full))
			: [];
		let insights = null;
		if (opts.insights) {
			if (source === "http-api") {
				const insightsRes = await fetchJson(
					`${baseUrl}/api/runtime/insights?matterId=${encodeURIComponent(parsed.matterId)}`,
					activeToken,
				);
				if (insightsRes.ok) insights = insightsRes.body;
			}
			if (!insights) {
				const cliPath = resolve(REPO_ROOT, "pa-extensions/self-inspect/skills/pa-self-inspection/scripts/session-insights.mjs");
				if (existsSync(cliPath) && existsSync(dbPath)) {
					try {
						const raw = execFileSync(process.execPath, [cliPath, "--matter", parsed.matterId, "--db", dbPath, "--json"], {
							encoding: "utf8",
							timeout: 15_000,
						});
						insights = JSON.parse(raw);
					} catch {
						// Ignore local insights fallback failure
					}
				}
			}
		}

		const report = {
			sourceInfo: { source, httpFallbackReason, baseUrl, dbPath, repoHead },
			runtime,
			data,
			sessionGroups,
			timeline,
			piSessions,
			...(insights ? { insights } : {}),
		};

		if (opts.json) {
			console.log(JSON.stringify(report, null, 2));
		} else {
			let md = renderReportMarkdown(report);
			if (insights) {
				const usage = insights.usage ?? insights;
				const findings = Array.isArray(insights.findings) ? insights.findings : [];
				const lines = [
					"",
					"## 确定性会话洞察（Session Insights）",
					`- 覆盖范围：${usage.sessions ?? 0} 个 Pi 会话 · ${usage.turns ?? 0} 轮 · ${usage.toolCalls ?? 0} 次工具调用（失败 ${usage.toolErrors ?? 0} 次） · Pi 记录成本 $${Number(usage.totalCostUsd ?? 0).toFixed(4)}`,
				];
				if (findings.length === 0) {
					lines.push("- 异常发现：无高风险规则命中。");
				} else {
					for (const f of findings) {
						const icon = f.severity === "error" ? "✗" : f.severity === "warn" ? "!" : "·";
						const tag = f.suggestSkillCapture ? " [建议沉淀为 Skill]" : "";
						lines.push(`- ${icon} **${f.title}**${tag}：${f.detail ?? ""}`);
					}
				}
				md += `\n${lines.join("\n")}`;
			}
			console.log(md);
		}
	} finally {
		if (tempLoginToken) {
			await logoutSession(baseUrl, tempLoginToken);
		}
	}
}

main().catch((error) => {
	console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
