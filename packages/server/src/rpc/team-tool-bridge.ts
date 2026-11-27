import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { BoardPostArtifacts, BoardPostKind, BoardPostVerification, BoardRole } from "@pa/contracts/board";
import type { Clarification } from "@pa/contracts/human-decision";
import {
	isSkillStorageTarget,
	SKILL_PROPOSAL_NAME_RE,
	SKILL_SCRIPT_PATH_RE,
	type SkillScriptFile,
	type SkillStorageTarget,
} from "@pa/contracts/skill-proposal";
import {
	isValidSkillTrustLevel,
	isValidSkillTrustScope,
	type SkillTrustLevel,
	type SkillTrustScope,
} from "@pa/contracts/skill-trust";
import type { SpaceDocumentType, SpaceEntryKind } from "../storage/repos/space-repo.ts";
import { type ModelSelection, parseModelSelection } from "./model-selection.ts";
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
			sourceDir?: string;
			pageId?: string;
			revision?: number;
			type: "document" | "artifact" | "prototype_image" | "service_url";
			summary?: string;
			changeNote?: string;
	  } & (
			| { content: string; sourcePath?: never }
			| { sourcePath: string; content?: never }
			| { content?: undefined; sourcePath?: undefined; files: Array<{ path: string; content: string }> }
			| { content?: string; sourcePath?: undefined; sourceDir: string }
	  ))
	| ({ tool: "request_clarification"; callId: string; sourceAssignmentNumber?: number } & Clarification)
	| {
			tool: "delegate_to_member";
			callId: string;
			memberId: string;
			task: string;
			handoffDocumentIds?: string[];
			verification?: VerificationRequest;
	  }
	| {
			tool: "spawn_board_agent";
			callId: string;
			agentId: string;
			boardRole: BoardRole;
			displayName?: string;
			sourceMemberId?: string;
			brief: string;
			skills?: string[];
			ownedScope?: string[];
			acceptanceCriteria?: string;
			modelOverride?: ModelSelection;
	  }
	| {
			tool: "post_to_board";
			callId: string;
			kind: BoardPostKind;
			mentions: string[];
			refPostNos?: number[];
			summary: string;
			body?: string;
			artifacts?: BoardPostArtifacts | null;
			verification?: BoardPostVerification | null;
	  }
	| {
			tool: "read_board_post";
			callId: string;
			postNo: number;
	  }
	| {
			tool: "propose_skill";
			callId: string;
			name: string;
			description: string;
			body: string;
			storageScope: SkillStorageTarget;
			rationale: string;
			scripts?: SkillScriptFile[];
	  }
	| {
			tool: "record_skill_run";
			callId: string;
			scope: SkillTrustScope;
			scopeId: string;
			skillName: string;
			outcome: string;
	  }
	| {
			tool: "promote_skill_trust";
			callId: string;
			scope: SkillTrustScope;
			scopeId: string;
			skillName: string;
			trustLevel: SkillTrustLevel;
	  }
	| {
			tool: "read_team_roles";
			callId: string;
			includeCapabilities?: boolean;
			includeHealthEvidence?: boolean;
	  }
	| {
			tool: "propose_role";
			callId: string;
			action: "create";
			id?: string;
			name?: string;
			title?: string;
			oneJob: string;
			antiJobs?: string[];
			quietWhen?: string;
			interactionStyle?: "lead_direct" | "consult_specialist" | "risk_observer" | "mixed";
			workflowRules?: string;
			communicationStyle?: string;
			verificationPlan?: string;
			skills?: string[];
			mcpDependencies?: string[];
			newSkills?: Array<{
				name: string;
				description: string;
				body: string;
				storageScope?: "role_local" | "org" | "personal" | "global";
			}>;
			rationale: string;
	  }
	| {
			tool: "propose_role";
			callId: string;
			action: "update";
			memberId: string;
			addAntiJobs?: string[];
			workflowNote?: string;
			rationale: string;
	  };

const VALID_BOARD_POST_KINDS = new Set<BoardPostKind>([
	"assign",
	"progress",
	"handoff",
	"verify_pass",
	"verify_rework",
	"escalate",
	"clarification",
	"summary",
]);

function parseOptionalStringList(raw: unknown, field: string, maxItems = 16, maxLen = 400): string[] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw) || raw.length > maxItems) {
		throw new Error(`${field} must be an array of at most ${maxItems} strings`);
	}
	const list = raw.map((item) => (typeof item === "string" ? item.trim().slice(0, maxLen) : "")).filter(Boolean);
	return list.length > 0 ? list : undefined;
}

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

export function parseCall(value: unknown): TeamToolCall {
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
		const hasSourceDir = "sourceDir" in args && args.sourceDir !== undefined;
		const files = "files" in args ? parseOptionalFiles(args.files) : undefined;
		if (hasContent && hasSourcePath) throw new Error("Provide at most one of content or sourcePath");
		if (hasSourceDir && (hasSourcePath || files)) {
			throw new Error("sourceDir cannot be combined with sourcePath or files");
		}
		if (!hasContent && !hasSourcePath && !hasSourceDir && !files) {
			throw new Error("Provide content, sourcePath, sourceDir, or files");
		}
		const type = "type" in args ? args.type : "document";
		if (type !== "document" && type !== "artifact" && type !== "prototype_image" && type !== "service_url")
			throw new Error("Unsupported space item type");
		const docType = "docType" in args ? parseOptionalDocType(args.docType) : undefined;
		const entryKind = "entryKind" in args ? parseOptionalEntryKind(args.entryKind) : undefined;
		const subPath = "subPath" in args ? requiredString(args.subPath, "subPath", 512) : undefined;
		if (type !== "document" && (hasSourcePath || hasSourceDir)) {
			throw new Error("sourcePath/sourceDir is only supported for document items");
		}
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
		if (hasSourceDir) {
			return {
				...base,
				sourceDir: requiredString(args.sourceDir, "sourceDir", 4096),
				...(hasContent ? { content: requiredString(args.content, "content", 64_000) } : {}),
			};
		}
		if (hasSourcePath) {
			return { ...base, sourcePath: requiredString(args.sourcePath, "sourcePath", 4096) };
		}
		if (hasContent) {
			return { ...base, content: requiredString(args.content, "content", 64_000) };
		}
		return { ...base, files: files! };
	}
	if (value.tool === "delegate_to_member" && "memberId" in args && "task" in args) {
		let handoffDocumentIds: string[] | undefined;
		if ("handoffDocumentIds" in args && args.handoffDocumentIds !== undefined) {
			if (!Array.isArray(args.handoffDocumentIds) || args.handoffDocumentIds.length > 5) {
				throw new Error("handoffDocumentIds must be an array of at most 5 document IDs");
			}
			const parsed = [
				...new Set(args.handoffDocumentIds.map((id, idx) => requiredString(id, `handoffDocumentIds[${idx}]`, 128))),
			];
			if (parsed.length > 0) handoffDocumentIds = parsed;
		}
		return {
			tool: value.tool,
			callId,
			memberId: requiredString(args.memberId, "memberId", 256),
			task: requiredString(args.task, "task", 16_000),
			...(handoffDocumentIds ? { handoffDocumentIds } : {}),
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
	if (value.tool === "record_skill_run" && "scope" in args && "skillName" in args && "outcome" in args) {
		if (!isValidSkillTrustScope(args.scope)) throw new Error("Invalid skill trust scope");
		const skillName = requiredString(args.skillName, "skillName", 80);
		if (!SKILL_PROPOSAL_NAME_RE.test(skillName)) throw new Error("Invalid skillName");
		const rawScopeId = "scopeId" in args ? args.scopeId : "";
		const scopeId = typeof rawScopeId === "string" ? rawScopeId.trim().slice(0, 120) : "";
		return {
			tool: value.tool,
			callId,
			scope: args.scope,
			scopeId,
			skillName,
			outcome: requiredString(args.outcome, "outcome", 120),
		};
	}
	if (value.tool === "promote_skill_trust" && "scope" in args && "skillName" in args && "trustLevel" in args) {
		if (!isValidSkillTrustScope(args.scope)) throw new Error("Invalid skill trust scope");
		if (!isValidSkillTrustLevel(args.trustLevel)) throw new Error("Invalid skill trustLevel");
		const skillName = requiredString(args.skillName, "skillName", 80);
		if (!SKILL_PROPOSAL_NAME_RE.test(skillName)) throw new Error("Invalid skillName");
		const rawScopeId = "scopeId" in args ? args.scopeId : "";
		const scopeId = typeof rawScopeId === "string" ? rawScopeId.trim().slice(0, 120) : "";
		return {
			tool: value.tool,
			callId,
			scope: args.scope,
			scopeId,
			skillName,
			trustLevel: args.trustLevel,
		};
	}
	if (value.tool === "read_team_roles") {
		const includeCapabilities =
			"includeCapabilities" in args && args.includeCapabilities !== undefined
				? Boolean(args.includeCapabilities)
				: undefined;
		const includeHealthEvidence =
			"includeHealthEvidence" in args && args.includeHealthEvidence !== undefined
				? Boolean(args.includeHealthEvidence)
				: undefined;
		return {
			tool: "read_team_roles",
			callId,
			...(includeCapabilities !== undefined ? { includeCapabilities } : {}),
			...(includeHealthEvidence !== undefined ? { includeHealthEvidence } : {}),
		};
	}
	if (value.tool === "propose_role" && "action" in args && "rationale" in args) {
		const rationale = requiredString(args.rationale, "rationale", 2000);
		const parseStringArray = (raw: unknown, field: string, maxItems = 12, maxLen = 400): string[] | undefined => {
			if (raw === undefined) return undefined;
			if (!Array.isArray(raw) || raw.length > maxItems) {
				throw new Error(`${field} must be an array of at most ${maxItems} strings`);
			}
			const list = raw.map((item) => (typeof item === "string" ? item.trim().slice(0, maxLen) : "")).filter(Boolean);
			return list.length > 0 ? list : undefined;
		};
		if (args.action === "create") {
			if (!("oneJob" in args)) throw new Error("propose_role(create) requires oneJob");
			const oneJob = requiredString(args.oneJob, "oneJob", 2000);
			const interactionStyle =
				"interactionStyle" in args &&
				(args.interactionStyle === "lead_direct" ||
					args.interactionStyle === "consult_specialist" ||
					args.interactionStyle === "risk_observer" ||
					args.interactionStyle === "mixed")
					? args.interactionStyle
					: undefined;
			let newSkills:
				| Array<{
						name: string;
						description: string;
						body: string;
						storageScope?: "role_local" | "org" | "personal" | "global";
				  }>
				| undefined;
			if ("newSkills" in args && args.newSkills !== undefined) {
				if (!Array.isArray(args.newSkills) || args.newSkills.length > 5) {
					throw new Error("newSkills must be an array of at most 5 skill drafts");
				}
				newSkills = args.newSkills.map((raw, idx) => {
					if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
						throw new Error(`newSkills[${idx}] must be an object`);
					}
					const rec = raw as Record<string, unknown>;
					const storageScope =
						rec.storageScope === "role_local" ||
						rec.storageScope === "org" ||
						rec.storageScope === "personal" ||
						rec.storageScope === "global"
							? rec.storageScope
							: undefined;
					return {
						name: requiredString(rec.name, `newSkills[${idx}].name`, 64),
						description: requiredString(rec.description, `newSkills[${idx}].description`, 500),
						body: requiredString(rec.body, `newSkills[${idx}].body`, 16_000),
						...(storageScope ? { storageScope } : {}),
					};
				});
			}
			const optString = (key: string, max: number) =>
				key in args && typeof (args as Record<string, unknown>)[key] === "string"
					? (args as Record<string, unknown>)[key]?.toString().trim().slice(0, max) || undefined
					: undefined;
			const antiJobs = "antiJobs" in args ? parseStringArray(args.antiJobs, "antiJobs", 12, 400) : undefined;
			const skills = "skills" in args ? parseStringArray(args.skills, "skills", 16, 120) : undefined;
			const mcpDependencies =
				"mcpDependencies" in args ? parseStringArray(args.mcpDependencies, "mcpDependencies", 12, 120) : undefined;
			return {
				tool: "propose_role",
				callId,
				action: "create",
				oneJob,
				rationale,
				...(optString("id", 80) ? { id: optString("id", 80) } : {}),
				...(optString("name", 80) ? { name: optString("name", 80) } : {}),
				...(optString("title", 120) ? { title: optString("title", 120) } : {}),
				...(optString("quietWhen", 500) ? { quietWhen: optString("quietWhen", 500) } : {}),
				...(interactionStyle ? { interactionStyle } : {}),
				...(optString("workflowRules", 4000) ? { workflowRules: optString("workflowRules", 4000) } : {}),
				...(optString("communicationStyle", 1000)
					? { communicationStyle: optString("communicationStyle", 1000) }
					: {}),
				...(optString("verificationPlan", 2000) ? { verificationPlan: optString("verificationPlan", 2000) } : {}),
				...(antiJobs ? { antiJobs } : {}),
				...(skills ? { skills } : {}),
				...(mcpDependencies ? { mcpDependencies } : {}),
				...(newSkills && newSkills.length > 0 ? { newSkills } : {}),
			};
		}
		if (args.action === "update") {
			if (!("memberId" in args)) throw new Error("propose_role(update) requires memberId");
			const memberId = requiredString(args.memberId, "memberId", 160);
			const addAntiJobs =
				"addAntiJobs" in args ? parseStringArray(args.addAntiJobs, "addAntiJobs", 12, 400) : undefined;
			const workflowNote =
				"workflowNote" in args && typeof args.workflowNote === "string"
					? args.workflowNote.trim().slice(0, 2000) || undefined
					: undefined;
			if (!addAntiJobs && !workflowNote) {
				throw new Error("propose_role(update) requires addAntiJobs or workflowNote");
			}
			return {
				tool: "propose_role",
				callId,
				action: "update",
				memberId,
				rationale,
				...(addAntiJobs ? { addAntiJobs } : {}),
				...(workflowNote ? { workflowNote } : {}),
			};
		}
		throw new Error("propose_role action must be 'create' or 'update'");
	}
	if (value.tool === "spawn_board_agent") {
		if (!("agentId" in args) || !("boardRole" in args) || !("brief" in args)) {
			throw new Error("spawn_board_agent requires agentId, boardRole, and brief");
		}
		const agentId = requiredString(args.agentId, "agentId", 120).replace(/^@+/, "");
		const boardRole = args.boardRole;
		if (boardRole !== "builder" && boardRole !== "verifier") {
			throw new Error("spawn_board_agent boardRole must be 'builder' or 'verifier'");
		}
		const brief = requiredString(args.brief, "brief", 16_000);
		const displayName =
			"displayName" in args && typeof args.displayName === "string" && args.displayName.trim()
				? args.displayName.trim().slice(0, 120)
				: undefined;
		const sourceMemberId =
			"sourceMemberId" in args && typeof args.sourceMemberId === "string" && args.sourceMemberId.trim()
				? args.sourceMemberId.trim().slice(0, 120)
				: undefined;
		const acceptanceCriteria =
			"acceptanceCriteria" in args && typeof args.acceptanceCriteria === "string" && args.acceptanceCriteria.trim()
				? args.acceptanceCriteria.trim().slice(0, 8000)
				: undefined;
		const skills = "skills" in args ? parseOptionalStringList(args.skills, "skills", 16, 120) : undefined;
		const ownedScope =
			"ownedScope" in args ? parseOptionalStringList(args.ownedScope, "ownedScope", 24, 300) : undefined;
		const modelOverride =
			"modelOverride" in args && args.modelOverride !== undefined && args.modelOverride !== null
				? (parseModelSelection(args.modelOverride) ?? undefined)
				: undefined;
		return {
			tool: "spawn_board_agent",
			callId,
			agentId,
			boardRole,
			brief,
			...(displayName ? { displayName } : {}),
			...(sourceMemberId ? { sourceMemberId } : {}),
			...(skills ? { skills } : {}),
			...(ownedScope ? { ownedScope } : {}),
			...(acceptanceCriteria ? { acceptanceCriteria } : {}),
			...(modelOverride ? { modelOverride } : {}),
		};
	}
	if (value.tool === "post_to_board") {
		if (!("kind" in args) || !("mentions" in args) || !("summary" in args)) {
			throw new Error("post_to_board requires kind, mentions, and summary");
		}
		const kind = args.kind;
		if (typeof kind !== "string" || !VALID_BOARD_POST_KINDS.has(kind as BoardPostKind)) {
			throw new Error("Unsupported board post kind");
		}
		if (!Array.isArray(args.mentions) || args.mentions.length > 20) {
			throw new Error("mentions must be an array of at most 20 strings");
		}
		const mentions = args.mentions
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim().replace(/^@+/, ""))
			.filter(Boolean);
		const summary = requiredString(args.summary, "summary", 1000);
		const body = "body" in args && typeof args.body === "string" ? args.body.slice(0, 64_000) : undefined;
		let refPostNos: number[] | undefined;
		if ("refPostNos" in args && args.refPostNos !== undefined) {
			if (!Array.isArray(args.refPostNos) || args.refPostNos.length > 20) {
				throw new Error("refPostNos must be an array of positive integers");
			}
			refPostNos = args.refPostNos.filter(
				(item): item is number => typeof item === "number" && Number.isInteger(item) && item > 0,
			);
		}
		const artifacts =
			"artifacts" in args && args.artifacts && typeof args.artifacts === "object" && !Array.isArray(args.artifacts)
				? (args.artifacts as BoardPostArtifacts)
				: undefined;
		let verification: BoardPostVerification | undefined;
		if ("verification" in args && args.verification !== undefined) {
			const raw = args.verification;
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
				throw new Error("verification must be an object");
			}
			const rec = raw as Record<string, unknown>;
			if (rec.verdict !== "pass" && rec.verdict !== "rework" && rec.verdict !== "pending") {
				throw new Error("verification.verdict must be 'pass', 'rework', or 'pending'");
			}
			verification = {
				target: requiredString(rec.target, "verification.target", 2000),
				verdict: rec.verdict,
				...(typeof rec.criteria === "string" && rec.criteria.trim()
					? { criteria: rec.criteria.trim().slice(0, 2000) }
					: {}),
				...(typeof rec.authorAgentId === "string" && rec.authorAgentId.trim()
					? { authorAgentId: rec.authorAgentId.trim().slice(0, 120) }
					: {}),
			};
		}
		return {
			tool: "post_to_board",
			callId,
			kind: kind as BoardPostKind,
			mentions,
			summary,
			...(refPostNos && refPostNos.length > 0 ? { refPostNos } : {}),
			...(body !== undefined ? { body } : {}),
			...(artifacts ? { artifacts } : {}),
			...(verification ? { verification } : {}),
		};
	}
	if (value.tool === "read_board_post") {
		if (!("postNo" in args) || typeof args.postNo !== "number" || !Number.isInteger(args.postNo) || args.postNo < 1) {
			throw new Error("read_board_post requires a positive integer postNo");
		}
		return {
			tool: "read_board_post",
			callId,
			postNo: args.postNo,
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
