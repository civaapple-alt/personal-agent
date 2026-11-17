import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RoleCapabilityReport, RoleTemplate } from "./types.ts";

const skillsDir = fileURLToPath(new URL("../../skills/", import.meta.url));

export function resolveRoleSkillPath(name: string, template?: Pick<RoleTemplate, "sourcePath">): string {
	return isAbsolute(name)
		? name
		: name.includes("/")
			? resolve(template?.sourcePath ? dirname(template.sourcePath) : skillsDir, name)
			: resolve(skillsDir, name, "SKILL.md");
}

/** Only lists installed project methods; it never installs dependencies or probes external services. */
export async function listRoleSkillCatalog(): Promise<Array<{ name: string; description: string }>> {
	const entries = await readdir(skillsDir, { withFileTypes: true });
	const result: Array<{ name: string; description: string }> = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory()) continue;
		const content = await readFile(resolve(skillsDir, entry.name, "SKILL.md"), "utf8").catch(() => null);
		if (content === null) continue;
		result.push({
			name: entry.name,
			description: content.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? entry.name,
		});
	}
	return result;
}

export async function assessRoleCapabilities(template: RoleTemplate): Promise<RoleCapabilityReport> {
	const skills = await Promise.all(
		template.skills.map(async (name) => {
			const info = await stat(resolveRoleSkillPath(name, template)).catch(() => null);
			return { name, state: info?.isFile() ? ("file_present" as const) : ("missing" as const) };
		}),
	);
	return {
		skills,
		mcpDependencies: template.mcpDependencies.map((name) => ({ name, state: "runtime_check_required" })),
	};
}
