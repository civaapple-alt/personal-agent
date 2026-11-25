import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { SKILL_PROPOSAL_NAME_RE } from "@pa/contracts/skill-proposal";
import {
	isValidSkillTrustLevel,
	isValidSkillTrustScope,
	type ManagedSkillDetailDto,
	type ManagedSkillEntryDto,
	type ManagedSkillScriptDetailDto,
	type PiNativeSkillDetailDto,
	type PiNativeSkillDto,
	type SkillTrustPolicyRecord,
	type SkillTrustScope,
	skillTrustPolicyKey,
} from "@pa/contracts/skill-trust";
import { canAccessOrganization, canAccessWorkspace, canManageOrganization } from "../acl.ts";
import { isSuperAdminActor, type RequestActor } from "../auth.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";
import { auditActorAction, type RouteRequest, type ServerRouteContext } from "./context.ts";

const MAX_SKILL_PREVIEW_CHARS = 64 * 1024;
const MAX_SKILL_PREVIEW_FILES = 40;
const MAX_SKILL_SCAN_DEPTH = 4;
const IGNORED_SKILL_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "dist", "build"]);
const BINARY_FILE_EXTS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".pdf",
	".zip",
	".tar",
	".gz",
	".tgz",
	".wasm",
	".pyc",
	".so",
	".dylib",
	".dll",
	".exe",
	".bin",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".mp3",
	".mp4",
	".mov",
]);

function isLikelyBinaryFile(filePath: string): boolean {
	if (BINARY_FILE_EXTS.has(extname(filePath).toLowerCase())) return true;
	try {
		const buf = readFileSync(filePath);
		const probeLen = Math.min(buf.length, 4096);
		for (let i = 0; i < probeLen; i++) {
			if (buf[i] === 0) return true;
		}
		return false;
	} catch {
		return true;
	}
}

function listSkillDirFiles(skillDir: string): string[] {
	if (!existsSync(skillDir)) return [];
	let canonicalRoot: string;
	try {
		canonicalRoot = realpathSync(skillDir);
	} catch {
		return [];
	}
	const collected: string[] = [];
	const walk = (currentDir: string, depth: number) => {
		if (depth > MAX_SKILL_SCAN_DEPTH || collected.length >= MAX_SKILL_PREVIEW_FILES) return;
		const entries = (() => {
			try {
				return readdirSync(currentDir, { withFileTypes: true });
			} catch {
				return [];
			}
		})();
		for (const entry of entries) {
			if (collected.length >= MAX_SKILL_PREVIEW_FILES) break;
			if (entry.name.startsWith(".") || IGNORED_SKILL_DIRS.has(entry.name)) continue;
			const full = join(currentDir, entry.name);
			let realFull: string;
			try {
				realFull = realpathSync(full);
			} catch {
				continue;
			}
			if (realFull !== canonicalRoot && !realFull.startsWith(`${canonicalRoot}${sep}`)) continue;
			if (entry.isDirectory()) {
				walk(full, depth + 1);
			} else if (entry.isFile()) {
				const rel = relative(skillDir, full).replace(/\\/g, "/");
				if (rel === "SKILL.md") continue;
				if (isLikelyBinaryFile(full)) continue;
				collected.push(rel);
			}
		}
	};
	walk(skillDir, 0);
	const groupRank = (rel: string) => {
		if (rel.startsWith("scripts/")) return 0;
		if (rel.startsWith("references/") || rel.startsWith("reference/")) return 1;
		if (rel.startsWith("assets/")) return 2;
		return 3;
	};
	return collected.sort((a, b) => {
		const ra = groupRank(a);
		const rb = groupRank(b);
		return ra !== rb ? ra - rb : a.localeCompare(b);
	});
}

function readSkillFilesDetail(skillDir: string, relPaths: string[]): ManagedSkillScriptDetailDto[] {
	return relPaths.map((relPath) => {
		const full = resolve(skillDir, relPath);
		const read = readBoundedUtf8(full);
		return {
			path: relPath,
			content: read.content,
			...(read.truncated ? { truncated: true } : {}),
		};
	});
}

function readBoundedUtf8(filePath: string): { content: string; truncated: boolean } {
	const raw = readFileSync(filePath, "utf8");
	if (raw.length <= MAX_SKILL_PREVIEW_CHARS) {
		return { content: raw, truncated: false };
	}
	return {
		content: `${raw.slice(0, MAX_SKILL_PREVIEW_CHARS)}\n\n…（内容超过 64KB，已截断预览）`,
		truncated: true,
	};
}

function parseSkillFrontmatter(filePath: string, fallbackName: string): { name: string; description: string } {
	try {
		const raw = readFileSync(filePath, "utf8");
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!match?.[1]) return { name: fallbackName, description: "" };
		let name = fallbackName;
		let description = "";
		for (const line of match[1].split(/\r?\n/)) {
			const idx = line.indexOf(":");
			if (idx <= 0) continue;
			const key = line.slice(0, idx).trim();
			const value = line
				.slice(idx + 1)
				.trim()
				.replace(/^["']|["']$/g, "");
			if (key === "name" && value) name = value;
			else if (key === "description" && value) description = value;
		}
		return { name, description };
	} catch {
		return { name: fallbackName, description: "" };
	}
}

function listSkillScripts(skillDir: string): string[] {
	const scriptsDir = join(skillDir, "scripts");
	if (!existsSync(scriptsDir)) return [];
	try {
		return readdirSync(scriptsDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && !entry.name.startsWith("."))
			.map((entry) => `scripts/${entry.name}`)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

function scanSkillRoot(params: {
	rootDir: string;
	scope: SkillTrustScope;
	scopeId: string;
	scopeLabel: string;
	canManage: boolean;
	policiesByKey: Map<string, SkillTrustPolicyRecord>;
}): ManagedSkillEntryDto[] {
	if (!existsSync(params.rootDir)) return [];
	let dirs: string[];
	try {
		dirs = readdirSync(params.rootDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
	const results: ManagedSkillEntryDto[] = [];
	for (const dirName of dirs) {
		const skillDir = join(params.rootDir, dirName);
		const skillMd = join(skillDir, "SKILL.md");
		if (!existsSync(skillMd)) continue;
		const meta = parseSkillFrontmatter(skillMd, dirName);
		const key = skillTrustPolicyKey(params.scope, params.scopeId, dirName);
		const policy = params.policiesByKey.get(key);
		results.push({
			scope: params.scope,
			scopeId: params.scopeId,
			scopeLabel: params.scopeLabel,
			name: dirName,
			description: meta.description || meta.name,
			filePath: skillMd,
			scripts: listSkillScripts(skillDir),
			trustLevel: policy?.trustLevel ?? "confirm",
			runCount: policy?.runCount ?? 0,
			lastRunAt: policy?.lastRunAt ?? null,
			lastOutcome: policy?.lastOutcome ?? null,
			updatedAt: policy?.updatedAt ?? null,
			canManage: params.canManage,
		});
	}
	return results;
}

function canManageSkillScope(
	ctx: ServerRouteContext,
	actor: RequestActor | null,
	scope: SkillTrustScope,
	scopeId: string,
): boolean {
	if (!actor) return false;
	if (scope === "global") {
		return isSuperAdminActor(actor);
	}
	if (scope === "personal") {
		const actorUserId = actor.user?.id ?? actor.collaborator?.id ?? null;
		return Boolean(actorUserId && actorUserId === scopeId);
	}
	if (scope === "org") {
		return canManageOrganization(ctx.store, actor, scopeId);
	}
	if (scope === "workspace") {
		const ws = ctx.store.getWorkspace(scopeId);
		if (!ws) return false;
		if (isSuperAdminActor(actor)) return true;
		return Boolean(ws.orgId && canManageOrganization(ctx.store, actor, ws.orgId));
	}
	return false;
}

function canViewSkillScope(
	ctx: ServerRouteContext,
	actor: RequestActor | null,
	scope: SkillTrustScope,
	scopeId: string,
): boolean {
	if (!actor) return false;
	if (scope === "global") return true;
	if (scope === "personal") {
		const actorUserId = actor.user?.id ?? actor.collaborator?.id ?? null;
		return Boolean(actorUserId && actorUserId === scopeId);
	}
	if (scope === "org") {
		return canAccessOrganization(ctx.store, actor, scopeId);
	}
	if (scope === "workspace") {
		const ws = ctx.store.getWorkspace(scopeId);
		return Boolean(ws && canAccessWorkspace(ctx.store, actor, ws));
	}
	return false;
}

function resolveSkillScopeRoots(ctx: ServerRouteContext, scope: SkillTrustScope, scopeId: string): string[] {
	if (scope === "workspace") {
		const ws = ctx.store.getWorkspace(scopeId);
		if (!ws) return [];
		const folders = ctx.store.workspaceFolders
			.listFolders(ws.id)
			.filter((folder) => folder.loadSkills)
			.sort((a, b) => (a.role === "primary" ? -1 : b.role === "primary" ? 1 : a.path.localeCompare(b.path)));
		const baseDirs = folders.length > 0 ? folders.map((f) => f.path) : [ws.repoPath];
		const roots: string[] = [];
		const seen = new Set<string>();
		for (const dir of baseDirs) {
			for (const rel of [".agents/skills", ".pi/skills"]) {
				const candidate = resolve(dir, rel);
				if (!seen.has(candidate)) {
					seen.add(candidate);
					roots.push(candidate);
				}
			}
		}
		return roots;
	}
	if (!ctx.skillsDir) return [];
	if (scope === "global") return [resolve(ctx.skillsDir, "global")];
	if (scope === "personal") return scopeId ? [resolve(ctx.skillsDir, "users", scopeId)] : [];
	if (scope === "org") return scopeId ? [resolve(ctx.skillsDir, "orgs", scopeId)] : [];
	return [];
}

/** Handles `GET /api/skills/trust`, `GET /api/skills/trust/detail`, and `PATCH /api/skills/trust` for Four-Step Trust skill management. */
export async function handleSkillTrustRoutes(
	ctx: ServerRouteContext,
	{ req, res, method, pathname, actor }: RouteRequest,
) {
	if (
		pathname !== "/api/skills/trust" &&
		pathname !== "/api/skills/trust/detail" &&
		pathname !== "/api/skills/trust/native-detail"
	) {
		return false;
	}
	if (!actor) {
		sendError(res, 401, "未认证");
		return true;
	}

	if (pathname === "/api/skills/trust/detail" && method === "GET") {
		const parsedUrl = new URL(req.url ?? pathname, "http://127.0.0.1");
		const scope = parsedUrl.searchParams.get("scope");
		const scopeId = (parsedUrl.searchParams.get("scopeId") ?? "").trim();
		const skillName = (parsedUrl.searchParams.get("skillName") ?? "").trim();
		if (!isValidSkillTrustScope(scope)) {
			sendError(res, 400, "scope 必须为 global、org、personal 或 workspace");
			return true;
		}
		if (!skillName || !SKILL_PROPOSAL_NAME_RE.test(skillName)) {
			sendError(res, 400, "skillName 格式无效");
			return true;
		}
		if (!canViewSkillScope(ctx, actor, scope, scopeId)) {
			sendError(res, 403, "无权查看该作用域下的 Skill 内容");
			return true;
		}
		const rootDirs = resolveSkillScopeRoots(ctx, scope, scopeId);
		if (rootDirs.length === 0) {
			sendError(res, 404, "未找到对应的 Skill 根目录");
			return true;
		}
		let matchedSkillDir: string | null = null;
		let matchedSkillMd: string | null = null;
		for (const rootDir of rootDirs) {
			const candidateDir = resolve(rootDir, skillName);
			if (candidateDir !== rootDir && !candidateDir.startsWith(`${rootDir}${sep}`)) {
				sendError(res, 400, "skillName 路径无效");
				return true;
			}
			const candidateMd = join(candidateDir, "SKILL.md");
			if (existsSync(candidateMd)) {
				matchedSkillDir = candidateDir;
				matchedSkillMd = candidateMd;
				break;
			}
		}
		if (!matchedSkillDir || !matchedSkillMd) {
			sendError(res, 404, "未找到该 Skill 的 SKILL.md");
			return true;
		}
		const md = readBoundedUtf8(matchedSkillMd);
		const scripts = readSkillFilesDetail(matchedSkillDir, listSkillScripts(matchedSkillDir));
		const files = readSkillFilesDetail(matchedSkillDir, listSkillDirFiles(matchedSkillDir));
		const detail: ManagedSkillDetailDto = {
			scope,
			scopeId,
			name: skillName,
			filePath: matchedSkillMd,
			content: md.content,
			...(md.truncated ? { truncated: true } : {}),
			scripts,
			files,
		};
		sendJson(res, 200, { detail });
		return true;
	}

	if (pathname === "/api/skills/trust/native-detail" && method === "GET") {
		const parsedUrl = new URL(req.url ?? pathname, "http://127.0.0.1");
		const skillName = (parsedUrl.searchParams.get("name") ?? "").trim();
		const source = (parsedUrl.searchParams.get("source") ?? "").trim();
		if (!skillName || !source) {
			sendError(res, 400, "必须提供 name 与 source");
			return true;
		}
		if (!ctx.readPiNativeSkills) {
			sendError(res, 404, "当前运行环境不支持读取 Pi 原生技能详情");
			return true;
		}
		const runtimeConfig = ctx.getServerRuntimeConfig?.();
		const inheritLocalPiResources = Boolean(runtimeConfig?.inheritLocalPiResources);
		const isOwner = isSuperAdminActor(actor) || actor.authKind === "loopback";
		const discovered = await ctx.readPiNativeSkills({ inheritLocalPiResources, refresh: false });
		const matched = discovered.find((item) => item.name === skillName && item.source === source);
		if (!matched?.filePath || !existsSync(matched.filePath)) {
			sendError(res, 404, "未找到对应的 Pi 原生技能文件");
			return true;
		}
		const matchedSkillDir = dirname(matched.filePath);
		const md = readBoundedUtf8(matched.filePath);
		const files = readSkillFilesDetail(matchedSkillDir, listSkillDirFiles(matchedSkillDir));
		const detail: PiNativeSkillDetailDto = {
			name: matched.name,
			source: matched.source,
			filePath: isOwner ? matched.filePath : basename(matched.filePath),
			content: md.content,
			...(md.truncated ? { truncated: true } : {}),
			files,
		};
		sendJson(res, 200, { detail });
		return true;
	}

	if (pathname !== "/api/skills/trust") return false;

	if (method === "GET") {
		const policiesByKey = new Map(
			ctx.store.skillTrust
				.listPolicies()
				.map((policy) => [skillTrustPolicyKey(policy.scope, policy.scopeId, policy.skillName), policy]),
		);
		const skills: ManagedSkillEntryDto[] = [];
		const actorUserId = actor.user?.id ?? actor.collaborator?.id ?? null;

		if (ctx.skillsDir) {
			if (actorUserId) {
				skills.push(
					...scanSkillRoot({
						rootDir: resolve(ctx.skillsDir, "users", actorUserId),
						scope: "personal",
						scopeId: actorUserId,
						scopeLabel: "个人技能",
						canManage: true,
						policiesByKey,
					}),
				);
			}
			const visibleOrgs = ctx.store
				.listOrganizations()
				.filter((org) => canAccessOrganization(ctx.store, actor, org.id));
			for (const org of visibleOrgs) {
				skills.push(
					...scanSkillRoot({
						rootDir: resolve(ctx.skillsDir, "orgs", org.id),
						scope: "org",
						scopeId: org.id,
						scopeLabel: `组织 · ${org.name}`,
						canManage: canManageSkillScope(ctx, actor, "org", org.id),
						policiesByKey,
					}),
				);
			}
			skills.push(
				...scanSkillRoot({
					rootDir: resolve(ctx.skillsDir, "global"),
					scope: "global",
					scopeId: "",
					scopeLabel: "平台全局",
					canManage: canManageSkillScope(ctx, actor, "global", ""),
					policiesByKey,
				}),
			);
		}

		for (const ws of ctx.store.listWorkspaces()) {
			if (!canAccessWorkspace(ctx.store, actor, ws)) continue;
			const canManage = canManageSkillScope(ctx, actor, "workspace", ws.id);
			const seenInWs = new Set<string>();
			for (const rootDir of resolveSkillScopeRoots(ctx, "workspace", ws.id)) {
				const found = scanSkillRoot({
					rootDir,
					scope: "workspace",
					scopeId: ws.id,
					scopeLabel: `工作区 · ${ws.name}`,
					canManage,
					policiesByKey,
				});
				for (const item of found) {
					if (seenInWs.has(item.name)) continue;
					seenInWs.add(item.name);
					skills.push(item);
				}
			}
		}

		const parsedUrl = new URL(req.url ?? pathname, "http://127.0.0.1");
		const refresh = parsedUrl.searchParams.get("refresh") === "1";
		const runtimeConfig = ctx.getServerRuntimeConfig?.();
		const inheritLocalPiResources = Boolean(runtimeConfig?.inheritLocalPiResources);
		const isOwner = isSuperAdminActor(actor) || actor.authKind === "loopback";
		let piNativeSkills: PiNativeSkillDto[] = [];
		let piNativeSkillsError: string | null = null;
		if (ctx.readPiNativeSkills) {
			try {
				const raw = await ctx.readPiNativeSkills({ inheritLocalPiResources, refresh });
				piNativeSkills = raw.map((item) => ({
					...item,
					filePath: item.filePath ? (isOwner ? item.filePath : basename(item.filePath)) : null,
				}));
			} catch (err: unknown) {
				piNativeSkillsError = err instanceof Error ? err.message : String(err);
			}
		}

		sendJson(res, 200, { skills, piNativeSkills, piNativeSkillsError });
		return true;
	}

	if (method === "PATCH") {
		const body = (await readJsonBody(req)) as Record<string, unknown>;
		const scope = body.scope;
		const scopeId = typeof body.scopeId === "string" ? body.scopeId.trim() : "";
		const skillName = typeof body.skillName === "string" ? body.skillName.trim() : "";
		const trustLevel = body.trustLevel;

		if (!isValidSkillTrustScope(scope)) {
			sendError(res, 400, "scope 必须为 global、org、personal 或 workspace");
			return true;
		}
		if (!skillName || !SKILL_PROPOSAL_NAME_RE.test(skillName)) {
			sendError(res, 400, "skillName 格式无效");
			return true;
		}
		if (!isValidSkillTrustLevel(trustLevel)) {
			sendError(res, 400, "trustLevel 必须为 confirm、autonomous 或 disabled");
			return true;
		}
		if (!canManageSkillScope(ctx, actor, scope, scopeId)) {
			sendError(res, 403, "无权修改该作用域下的 Skill 信任策略");
			return true;
		}

		const policy = ctx.store.skillTrust.upsertPolicy({
			scope,
			scopeId,
			skillName,
			trustLevel,
			updatedByUserId: actor.user?.id ?? actor.collaborator?.id ?? null,
		});
		auditActorAction(ctx, req, actor, {
			action: "skill_trust.updated",
			targetType: "skill",
			targetId: skillTrustPolicyKey(scope, scopeId, skillName),
			orgId: scope === "org" ? scopeId : null,
			detail: { scope, scopeId, skillName, trustLevel },
		});
		sendJson(res, 200, { ok: true, policy });
		return true;
	}

	return false;
}
