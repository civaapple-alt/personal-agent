import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

interface SkillCommand {
	name: string;
	description?: string;
	source: string;
	sourceInfo?: { path?: string; source?: string; scope?: string };
}

interface SkillCatalogApi {
	getCommands(): SkillCommand[];
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: object;
		execute(
			callId: string,
			args: unknown,
			signal?: AbortSignal,
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: unknown;
		}>;
	}): void;
}

function skills(pi: SkillCatalogApi) {
	return pi.getCommands().flatMap((command) => {
		const path = command.sourceInfo?.path;
		if (command.source !== "skill" || !command.name.startsWith("skill:") || !path || !isAbsolute(path)) return [];
		return [
			{
				name: command.name.slice(6),
				description: command.description ?? "",
				path,
				source: command.sourceInfo?.source,
				scope: command.sourceInfo?.scope,
			},
		];
	});
}

/** Use Pi's own enabled skill commands as the catalogue, including manually invoked skills. */
export default function registerSkillCatalog(pi: SkillCatalogApi): void {
	pi.registerTool({
		name: "list_available_skills",
		label: "查看可用 Skills",
		description:
			"List the Skills currently discovered by Pi, including slash-invoked Skills. Choose relevant methods for the task, then use load_available_skill to read the full instructions. The list does not imply a method was applied.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		async execute(_id, _args, signal) {
			signal?.throwIfAborted();
			const catalog = skills(pi);
			return { content: [{ type: "text", text: JSON.stringify(catalog) }], details: { count: catalog.length } };
		},
	});
	pi.registerTool({
		name: "load_available_skill",
		label: "读取 Skill",
		description:
			"Read the complete SKILL.md of a Skill from list_available_skills. Select by name and use the listed path to disambiguate duplicate names. Follow relevant instructions subject to the user's request and host rules.",
		parameters: {
			type: "object",
			properties: { name: { type: "string" }, path: { type: "string" } },
			required: ["name"],
			additionalProperties: false,
		},
		async execute(_id, args, signal) {
			signal?.throwIfAborted();
			if (!args || typeof args !== "object" || !("name" in args) || typeof args.name !== "string")
				throw new Error("Expected a skill name");
			const path = "path" in args ? args.path : undefined;
			if (path !== undefined && typeof path !== "string") throw new Error("Invalid skill path");
			const matches = skills(pi).filter(
				(skill) => skill.name === args.name && (path === undefined || skill.path === path),
			);
			if (matches.length !== 1)
				throw new Error(
					matches.length
						? "Ambiguous skill name; specify its listed path"
						: "Skill not found in Pi's current catalogue",
				);
			const selected = matches[0]!;
			const file = await open(selected.path, "r");
			try {
				const info = await file.stat();
				if (!info.isFile() || info.size > 256 * 1024)
					throw new Error("Skill must be a file no larger than 256 KiB");
				const bytes = Buffer.alloc(256 * 1024 + 1);
				let offset = 0;
				while (offset < bytes.length) {
					const result = await file.read(bytes, offset, bytes.length - offset, offset);
					if (!result.bytesRead) break;
					offset += result.bytesRead;
				}
				if (offset > 256 * 1024) throw new Error("Skill exceeds 256 KiB");
				signal?.throwIfAborted();
				const sha256 = createHash("sha256").update(bytes.subarray(0, offset)).digest("hex");
				return {
					content: [
						{
							type: "text",
							text: `Skill: ${selected.name}\nSource: ${selected.path}\nSHA256: ${sha256}\n\n${bytes.subarray(0, offset).toString("utf8")}`,
						},
					],
					details: { ...selected, sha256 },
				};
			} finally {
				await file.close();
			}
		},
	});
}
