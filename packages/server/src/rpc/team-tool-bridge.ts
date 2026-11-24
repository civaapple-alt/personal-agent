import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Clarification } from "@pa/contracts/human-decision";
import {
	isSkillStorageTarget,
	SKILL_PROPOSAL_NAME_RE,
	SKILL_SCRIPT_PATH_RE,
	type SkillScriptFile,
	type SkillStorageTarget,
} from "@pa/contracts/skill-proposal";
import type { SpaceDocumentType, SpaceEntryKind } from "../storage/repos/space-repo.ts";
import type { VerificationRequest } from "./team-verification.ts";

export type TeamToolCall =
	| { tool: "read_space"; callId: string; pageId?: string; docType?: SpaceDocumentType; subPath?: string }
	| ({
			tool: "save_space_page";
			callId: string;
			title: string;
			docType?: SpaceDocumentType;
			entryKind?: SpaceEntryKind;
			subPath?: string;
			files?: Array<{ path: string; content: string }>;
			pageId?: string;
			revision?: number;
			type: "document" | "artifact" | "prototype_image" | "service_url";
			summary?: string;
			changeNote?: string;
	  } & (
			| { content: string; sourcePath?: never }
			| { sourcePath: string; content?: never }
			| { content?: undefined; sourcePath?: undefined; files: Array<{ path: string; content: string }> }
	  ))
	| ({ tool: "request_clarification"; callId: string; sourceAssignmentNumber?: number } & Clarification)
	| { tool: "delegate_to_member"; callId: string; memberId: string; task: string; verification?: VerificationRequest }
	| {
			tool: "propose_skill";
			callId: string;
			name: string;
			description: string;
			body: string;
			storageScope: SkillStorageTarget;
			rationale: string;
			scripts?: SkillScriptFile[];
	  };

function requiredString(value: unknown, name: string, max = 64_000): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) {
		throw new Error(`${name} must be nonempty text (max ${max} characters)`);
	}
	return value.trim();
}

function parseVerification(value: unknown): VerificationRequest {
	if (!value || typeof value !== "object" || !("target" in value) || !("criteria" in value)) {
		throw new Error("Verification requires a target and acceptance criteria");
	}
	const target = value.target;
	if (!target || typeof target !== "object" || !("kind" in target) || !("reference" in target)) {
		throw new Error("Expected a verification target");
	}
	const { kind, reference } = target;
	if (kind !== "file" && kind !== "commit" && kind !== "draft") throw new Error("Unsupported verification target");
	const assignmentNumber = "assignmentNumber" in value ? value.assignmentNumber : undefined;
	if (
		assignmentNumber !== undefined &&
		(typeof assignmentNumber !== "number" || !Number.isSafeInteger(assignmentNumber) || assignmentNumber < 1)
	) {
		throw new Error("assignmentNumber must be a positive integer");
	}
	return {
		assignmentNumber,
		target: { kind, reference: requiredString(reference, "verification.target.reference", 4096) },
		criteria: requiredString(value.criteria, "verification.criteria", 4000),
	};
}

function parseOptionalDocType(value: unknown): SpaceDocumentType | undefined {
	if (value === undefined) return undefined;
	if (value === "plan" || value === "spec" || value === "decision" || value === "rule" || value === "note") {
		return value;
	}
	throw new Error("Unsupported space docType (expected plan, spec, decision, rule, or note)");
}

function parseOptionalEntryKind(value: unknown): SpaceEntryKind | undefined {
	if (value === undefined) return undefined;
	if (value === "file" || value === "folder") return value;
	throw new Error("Unsupported space entryKind (expected file or folder)");
}

function parseOptionalFiles(value: unknown): Array<{ path: string; content: string }> | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
		throw new Error("files must be an array of 1 to 50 { path, content } entries");
	}
	return value.map((item, idx) => {
		if (!item || typeof item !== "object" || !("path" in item) || !("content" in item)) {
			throw new Error(`files[${idx}] must include path and content`);
		}
		const path = requiredString((item as { path: unknown }).path, `files[${idx}].path`, 512);
		const rawContent = (item as { content: unknown }).content;
		if (typeof rawContent !== "string" || rawContent.length > 64_000) {
			throw new Error(`files[${idx}].content must be a string (max 64000 characters)`);
		}
		return { path, content: rawContent };
	});
}

function parseCall(value: unknown): TeamToolCall {
	if (!value || typeof value !== "object") throw new Error("Expected a tool request");
	if (!("tool" in value) || !("callId" in value) || !("args" in value)) throw new Error("Invalid tool request");
	const callId = requiredString(value.callId, "callId", 256);
	const args = value.args;
	if (!args || typeof args !== "object") throw new Error("Expected tool arguments");
	if (value.tool === "read_space") {
		const docType = "docType" in args ? parseOptionalDocType(args.docType) : undefined;
		const subPath = "subPath" in args ? requiredString(args.subPath, "subPath", 512) : undefined;
		return {
			tool: value.tool,
			callId,
			...("pageId" in args ? { pageId: requiredString(args.pageId, "pageId", 256) } : {}),
			...(docType ? { docType } : {}),
			...(subPath ? { subPath } : {}),
		};
	}
	if (value.tool === "save_space_page" && "title" in args) {
		const pageId = "pageId" in args ? requiredString(args.pageId, "pageId", 256) : undefined;
		const revision = "revision" in args ? args.revision : undefined;
		if (
			(pageId === undefined) !== (revision === undefined) ||
			(revision !== undefined && (!Number.isSafeInteger(revision) || Number(revision) < 1))
		)
			throw new Error("Provide pageId and revision together");
		const hasContent = "content" in args && args.content !== undefined;
		const hasSourcePath = "sourcePath" in args && args.sourcePath !== undefined;
		const files = "files" in args ? parseOptionalFiles(args.files) : undefined;
		if (hasContent && hasSourcePath) throw new Error("Provide at most one of content or sourcePath");
		if (!hasContent && !hasSourcePath && !files) {
			throw new Error("Provide content, sourcePath, or files");
		}
		const type = "type" in args ? args.type : "document";
		if (type !== "document" && type !== "artifact" && type !== "prototype_image" && type !== "service_url")
			throw new Error("Unsupported space item type");
		const docType = "docType" in args ? parseOptionalDocType(args.docType) : undefined;
		const entryKind = "entryKind" in args ? parseOptionalEntryKind(args.entryKind) : undefined;
		const subPath = "subPath" in args ? requiredString(args.subPath, "subPath", 512) : undefined;
		if (type !== "document" && hasSourcePath) throw new Error("sourcePath is only supported for document items");
		const base = {
			tool: "save_space_page" as const,
			callId,
			title: requiredString(args.title, "title", 200),
			type: type as "document" | "artifact" | "prototype_image" | "service_url",
			...(docType ? { docType } : {}),
			...(entryKind ? { entryKind } : {}),
			...(subPath ? { subPath } : {}),
			...(files ? { files } : {}),
			...("summary" in args ? { summary: requiredString(args.summary, "summary", 1000) } : {}),
			...("changeNote" in args ? { changeNote: requiredString(args.changeNote, "changeNote", 2000) } : {}),
			...(pageId ? { pageId, revision: Number(revision) } : {}),
		};
		if (hasSourcePath) {
			return { ...base, sourcePath: requiredString(args.sourcePath, "sourcePath", 4096) };
		}
		if (hasContent) {
			return { ...base, content: requiredString(args.content, "content", 64_000) };
		}
		return { ...base, files: files! };
	}
	if (value.tool === "delegate_to_member" && "memberId" in args && "task" in args) {
		return {
			tool: value.tool,
			callId,
			memberId: requiredString(args.memberId, "memberId", 256),
			task: requiredString(args.task, "task", 16_000),
			...("verification" in args ? { verification: parseVerification(args.verification) } : {}),
		};
	}
	if (value.tool === "request_clarification" && "question" in args) {
		const options = "options" in args ? args.options : undefined;
		if (options !== undefined && (!Array.isArray(options) || options.length < 2 || options.length > 4)) {
			throw new Error("Provide two to four options, or omit options for free text");
		}
		const choices = options?.map((item) => requiredString(item, "options item", 240));
		if (choices && new Set(choices).size !== choices.length) throw new Error("Options must be distinct");
		const sourceAssignmentNumber = "sourceAssignmentNumber" in args ? args.sourceAssignmentNumber : undefined;
		if (
			sourceAssignmentNumber !== undefined &&
			(typeof sourceAssignmentNumber !== "number" ||
				!Number.isSafeInteger(sourceAssignmentNumber) ||
				sourceAssignmentNumber < 1)
		) {
			throw new Error("sourceAssignmentNumber must be a positive integer");
		}
		return {
			tool: value.tool,
			callId,
			question: requiredString(args.question, "question", 1000),
			context: "context" in args ? requiredString(args.context, "context", 3000) : undefined,
			options: choices,
			sourceAssignmentNumber,
		};
	}
	if (
		value.tool === "propose_skill" &&
		"name" in args &&
		"description" in args &&
		"body" in args &&
		"storageScope" in args &&
		"rationale" in args
	) {
		const name = requiredString(args.name, "name", 64);
		if (!SKILL_PROPOSAL_NAME_RE.test(name)) {
			throw new Error("Skill name must be lowercase kebab-case (e.g. 'release-preflight')");
		}
		if (!isSkillStorageTarget(args.storageScope)) {
			throw new Error("storageScope must be global, org, personal, or workspace");
		}
		let scripts: SkillScriptFile[] | undefined;
		if ("scripts" in args && args.scripts !== undefined) {
			if (!Array.isArray(args.scripts) || args.scripts.length > 8) {
				throw new Error("scripts must be an array of at most 8 files");
			}
			const seenPaths = new Set<string>();
			scripts = args.scripts.map((raw) => {
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
					throw new Error("Each script entry must be an object");
				}
				const rec = raw as Record<string, unknown>;
				const path = requiredString(rec.path, "scripts[].path", 140);
				if (!SKILL_SCRIPT_PATH_RE.test(path) || path.includes("..")) {
					throw new Error("Each script path must match scripts/<safe-filename>");
				}
				if (seenPaths.has(path)) throw new Error(`Duplicate script path: ${path}`);
				seenPaths.add(path);
				const content = requiredString(rec.content, "scripts[].content", 64_000);
				return { path, content, ...(rec.executable === true ? { executable: true } : {}) };
			});
		}
		return {
			tool: value.tool,
			callId,
			name,
			description: requiredString(args.description, "description", 500),
			body: requiredString(args.body, "body", 32_000),
			storageScope: args.storageScope,
			rationale: requiredString(args.rationale, "rationale", 1500),
			...(scripts && scripts.length > 0 ? { scripts } : {}),
		};
	}
	throw new Error("Unsupported tool or invalid arguments");
}

/** Abort host waits even when the external dialog/transport promise has not completed. */
export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/** Per-worker loopback transport. The caller identity and scope are bound by the host, never model arguments. */
export async function createTeamToolBridge(
	handle: (call: TeamToolCall, signal: AbortSignal) => Promise<unknown>,
	signal: AbortSignal,
) {
	const token = randomBytes(32).toString("hex");
	const operations = new Set<Promise<void>>();
	const calls = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
	let readyResolve!: (tools: string[]) => void;
	const ready = new Promise<string[]>((resolve) => {
		readyResolve = resolve;
	});
	const server = createServer((req, res) => {
		req.setTimeout(0);
		res.setTimeout(0);
		const operation = (async () => {
			const controller = new AbortController();
			res.on("close", () => {
				if (!res.writableEnded) controller.abort(new Error("Tool connection closed"));
			});
			try {
				if (req.method !== "POST" || req.headers.authorization !== `Bearer ${token}`) {
					res.writeHead(403).end();
					return;
				}
				const buffers: Buffer[] = [];
				let size = 0;
				for await (const chunk of req) {
					size += chunk.length;
					if (size > 262_144) throw new Error("Tool request too large");
					buffers.push(chunk);
				}
				const value: unknown = JSON.parse(Buffer.concat(buffers).toString("utf8"));
				const requestSignal = AbortSignal.any([signal, controller.signal]);
				requestSignal.throwIfAborted();
				let result: unknown;
				if (req.url === "/ready") {
					if (!Array.isArray(value) || !value.every((name) => typeof name === "string"))
						throw new Error("Invalid tool manifest");
					readyResolve(value);
					result = { ready: true };
				} else if (req.url === "/tool") {
					const call = parseCall(value);
					const fingerprint = JSON.stringify(call);
					const prior = calls.get(call.callId);
					if (prior && prior.fingerprint !== fingerprint)
						throw new Error("Tool call ID reused with different arguments");
					const pending = prior?.result ?? handle(call, requestSignal);
					calls.set(call.callId, { fingerprint, result: pending });
					result = await pending;
				} else {
					throw new Error("Unknown bridge route");
				}
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ result }));
			} catch (error) {
				res.writeHead(400, { "Content-Type": "application/json" }).end(
					JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
				);
			}
		})();
		operations.add(operation);
		void operation.finally(() => operations.delete(operation));
	});
	server.requestTimeout = 0;
	server.headersTimeout = 0;
	server.keepAliveTimeout = 0;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing bridge address");
	return {
		env: { PA_TEAM_BRIDGE_URL: `http://127.0.0.1:${address.port}`, PA_TEAM_BRIDGE_TOKEN: token },
		async waitReady(): Promise<string[]> {
			return await abortable(ready, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
		},
		async close(): Promise<void> {
			const closed = new Promise<void>((resolve) => server.close(() => resolve()));
			server.closeAllConnections();
			await Promise.allSettled([...operations]);
			await closed;
		},
	};
}
