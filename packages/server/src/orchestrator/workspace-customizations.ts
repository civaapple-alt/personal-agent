import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { WorkspaceFolder } from "../storage/repos/workspace-folder-repo.ts";

export const DEFAULT_RULES_BUDGET_TOKENS = 20_000;
export const DEFAULT_SKILLS_BUDGET_TOKENS = 20_000;

// Matches native Pi DefaultResourceLoader candidate priority.
const ROOT_RULE_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

export interface DiscoveredRuleItem {
	id: string;
	folderId: string;
	folderLabel: string;
	folderRole: "primary" | "attached";
	fileName: string;
	filePath: string;
	tokens: number;
	preview: string;
	content: string;
	mode: "full" | "pointer" | "disabled";
}

export interface DiscoveredSkillItem {
	id: string;
	name: string;
	description: string;
	folderId: string;
	folderLabel: string;
	folderRole: "primary" | "attached";
	skillDir: string;
	filePath: string;
	tokens: number;
	excluded: boolean;
}

export interface WorkspaceCustomizationsReport {
	rulesBudgetTokens: number;
	skillsBudgetTokens: number;
	rulesTokensUsed: number;
	rulesTotalTokens: number;
	skillsTokensUsed: number;
	skillsTotalTokens: number;
	rules: DiscoveredRuleItem[];
	skills: DiscoveredSkillItem[];
}

/** Lightweight, zero-dependency token estimate handling both CJK and Latin/code text. */
export function estimateTextTokens(text: string): number {
	if (!text) return 0;
	let cjkCount = 0;
	let otherCount = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (
			(code >= 0x4e00 && code <= 0x9fff) ||
			(code >= 0x3400 && code <= 0x4dbf) ||
			(code >= 0x3000 && code <= 0x303f) ||
			(code >= 0xff00 && code <= 0xffef)
		) {
			cjkCount += 1;
		} else {
			otherCount += 1;
		}
	}
	return Math.max(1, Math.ceil(cjkCount * 0.75 + otherCount / 4));
}

function isInsideRealRoot(realRoot: string, candidatePath: string): string | null {
	try {
		const realTarget = realpathSync(candidatePath);
		const rel = relative(realRoot, realTarget);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
		return realTarget;
	} catch {
		return null;
	}
}

function buildPreview(content: string, maxChars = 180): string {
	const compact = content.replace(/\s+/g, " ").trim();
	if (compact.length <= maxChars) return compact;
	return `${compact.slice(0, maxChars - 1)}…`;
}

function parseSkillFrontmatter(raw: string, fallbackName: string): { name: string; description: string } {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) {
		return { name: fallbackName, description: buildPreview(raw, 160) };
	}
	const yaml = match[1] ?? "";
	const nameMatch = yaml.match(/^name:\s*["']?([^"'\r\n]+)["']?/m);
	const descMatch = yaml.match(/^description:\s*["']?([^"'\r\n]+)["']?/m);
	return {
		name: nameMatch?.[1]?.trim() || fallbackName,
		description: descMatch?.[1]?.trim() || buildPreview(raw.slice(match[0].length), 160),
	};
}

function discoverFolderRules(folder: WorkspaceFolder): DiscoveredRuleItem[] {
	if (!existsSync(folder.path)) return [];
	let realRoot: string;
	try {
		realRoot = realpathSync(folder.path);
	} catch {
		return [];
	}

	const items: DiscoveredRuleItem[] = [];
	for (const candidate of ROOT_RULE_CANDIDATES) {
		const fullPath = join(folder.path, candidate);
		if (!existsSync(fullPath)) continue;
		const realFile = isInsideRealRoot(realRoot, fullPath);
		if (!realFile) continue;
		try {
			const stat = statSync(realFile);
			if (!stat.isFile() || stat.size > 512_000) continue;
			const content = readFileSync(realFile, "utf8");
			items.push({
				id: `${folder.id}:${candidate}`,
				folderId: folder.id,
				folderLabel: folder.label,
				folderRole: folder.role,
				fileName: candidate,
				filePath: realFile,
				tokens: estimateTextTokens(content),
				preview: buildPreview(content),
				content,
				mode: folder.loadRules ? "full" : "disabled",
			});
			// Match Pi's behavior: pick first matching root rule file per folder.
			break;
		} catch {
			// Skip unreadable rule files.
		}
	}
	return items;
}

function discoverFolderSkills(folder: WorkspaceFolder): DiscoveredSkillItem[] {
	if (!existsSync(folder.path)) return [];
	let realRoot: string;
	try {
		realRoot = realpathSync(folder.path);
	} catch {
		return [];
	}

	const skillRoots = [join(folder.path, ".agents", "skills"), join(folder.path, ".pi", "skills")];
	const discovered: DiscoveredSkillItem[] = [];
	const seenPaths = new Set<string>();

	for (const rootDir of skillRoots) {
		if (!existsSync(rootDir)) continue;
		let entries: string[];
		try {
			entries = readdirSync(rootDir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const skillDir = join(rootDir, entry);
			const skillFile = join(skillDir, "SKILL.md");
			if (!existsSync(skillFile)) continue;
			const realFile = isInsideRealRoot(realRoot, skillFile);
			if (!realFile || seenPaths.has(realFile)) continue;
			seenPaths.add(realFile);
			try {
				const stat = statSync(realFile);
				if (!stat.isFile() || stat.size > 256_000) continue;
				const raw = readFileSync(realFile, "utf8");
				const { name, description } = parseSkillFrontmatter(raw, entry);
				const indexLine = `- ${name} (${realFile}): ${description}`;
				discovered.push({
					id: `${folder.id}:${name}`,
					name,
					description,
					folderId: folder.id,
					folderLabel: folder.label,
					folderRole: folder.role,
					skillDir: resolve(skillDir),
					filePath: realFile,
					tokens: estimateTextTokens(indexLine),
					excluded: !folder.loadSkills,
				});
			} catch {
				// Skip unreadable skills.
			}
		}
	}
	return discovered;
}

/** Build a unified Rules + Skills report across all workspace folders with token budgets and pointer demotion. */
export function buildWorkspaceCustomizations(
	folders: WorkspaceFolder[],
	options?: {
		rulesBudgetTokens?: number;
		skillsBudgetTokens?: number;
	},
): WorkspaceCustomizationsReport {
	const rulesBudgetTokens = options?.rulesBudgetTokens ?? DEFAULT_RULES_BUDGET_TOKENS;
	const skillsBudgetTokens = options?.skillsBudgetTokens ?? DEFAULT_SKILLS_BUDGET_TOKENS;

	const orderedFolders = [...folders].sort((a, b) => {
		if (a.role !== b.role) return a.role === "primary" ? -1 : 1;
		return a.sortOrder - b.sortOrder;
	});

	const rules: DiscoveredRuleItem[] = [];
	const skills: DiscoveredSkillItem[] = [];
	const seenSkillNames = new Set<string>();

	for (const folder of orderedFolders) {
		rules.push(...discoverFolderRules(folder));
		for (const skill of discoverFolderSkills(folder)) {
			if (seenSkillNames.has(skill.name)) continue;
			seenSkillNames.add(skill.name);
			skills.push(skill);
		}
	}

	const enabledRules = rules.filter((r) => r.mode !== "disabled");
	let rulesUsed = enabledRules.reduce((sum, r) => sum + r.tokens, 0);

	// When exceeding budget, demote largest attached-folder rules first, then primary if still over budget.
	if (rulesUsed > rulesBudgetTokens) {
		const demotionCandidates = [...enabledRules].sort((a, b) => {
			if (a.folderRole !== b.folderRole) return a.folderRole === "attached" ? -1 : 1;
			return b.tokens - a.tokens;
		});
		for (const rule of demotionCandidates) {
			if (rulesUsed <= rulesBudgetTokens) break;
			const pointerTokens = estimateTextTokens(`Rule path pointer: ${rule.filePath} (${rule.preview})`);
			if (pointerTokens < rule.tokens) {
				rulesUsed = rulesUsed - rule.tokens + pointerTokens;
				rule.mode = "pointer";
			}
		}
	}

	const enabledSkills = skills.filter((s) => !s.excluded);
	let skillsUsed = enabledSkills.reduce((sum, s) => sum + s.tokens, 0);
	if (skillsUsed > skillsBudgetTokens) {
		const exclusionCandidates = [...enabledSkills].sort((a, b) => {
			if (a.folderRole !== b.folderRole) return a.folderRole === "attached" ? -1 : 1;
			return b.tokens - a.tokens;
		});
		for (const skill of exclusionCandidates) {
			if (skillsUsed <= skillsBudgetTokens) break;
			skillsUsed -= skill.tokens;
			skill.excluded = true;
		}
	}

	// Sort breakdowns by descending token cost for quick inspection (matching UI breakdown).
	const sortedRules = [...rules].sort((a, b) => b.tokens - a.tokens);
	const sortedSkills = [...skills].sort((a, b) => b.tokens - a.tokens);

	return {
		rulesBudgetTokens,
		skillsBudgetTokens,
		rulesTokensUsed: rulesUsed,
		rulesTotalTokens: enabledRules.reduce((sum, r) => sum + r.tokens, 0),
		skillsTokensUsed: skillsUsed,
		skillsTotalTokens: enabledSkills.reduce((sum, s) => sum + s.tokens, 0),
		rules: sortedRules,
		skills: sortedSkills,
	};
}

/** Build contextFiles payload for attached folders to merge into Pi's before_agent_start options.contextFiles. */
export function buildAttachedFolderContextFiles(
	report: WorkspaceCustomizationsReport,
): Array<{ path: string; content: string }> {
	return report.rules
		.filter((rule) => rule.folderRole === "attached" && rule.mode !== "disabled")
		.map((rule) => ({
			path: rule.filePath,
			content:
				rule.mode === "pointer"
					? `[Demoted to path pointer due to rules token budget]\nFolder: ${rule.folderLabel}\nPath: ${rule.filePath}\nSummary: ${rule.preview}\nUse the read tool on this path when you need the full rules.`
					: rule.content,
		}));
}

/** Extract enabled skill directories from attached folders to pass via Pi's --skill flag. */
export function extractAttachedSkillPaths(report: WorkspaceCustomizationsReport): string[] {
	return report.skills
		.filter((skill) => skill.folderRole === "attached" && !skill.excluded)
		.map((skill) => skill.filePath);
}
