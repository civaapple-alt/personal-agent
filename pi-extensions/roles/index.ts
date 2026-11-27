import { getBundledRolesDir, listRoleDefinitions } from "./loader.ts";

interface RolesUiContext {
	ui?: {
		notify?(message: string, level?: "info" | "warning" | "error"): void;
	};
}

export interface RolesExtensionApi {
	registerTool(definition: {
		name: string;
		label: string;
		description: string;
		parameters: object;
		execute(
			callId: string,
			args: unknown,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
	}): void;
	registerCommand?(
		name: string,
		definition: {
			description: string;
			handler(args: string, ctx?: RolesUiContext): Promise<string | undefined> | string | undefined;
		},
	): void;
}

export interface CreateRolesExtensionOptions {
	env?: Record<string, string | undefined>;
	cwd?: string;
}

function formatRoleSummaryText(roles: ReturnType<typeof listRoleDefinitions>): string {
	if (roles.length === 0) return "No role definitions found.";
	return roles
		.map(
			(role) =>
				`- ${role.id} (${role.title}) | skills: ${role.skills.join(", ") || "(none)"} | antiJobs: ${role.antiJobs.length} | source: ${role.sourcePath}`,
		)
		.join("\n");
}

export function createRolesExtension(options: CreateRolesExtensionOptions = {}) {
	return function configuredRolesExtension(pi: RolesExtensionApi): void {
		const env = options.env ?? process.env;
		if (env.PA_TEAM_BRIDGE_URL?.trim()) {
			return;
		}
		if (!process.env.PA_BUNDLED_ROLES_DIR) {
			process.env.PA_BUNDLED_ROLES_DIR = getBundledRolesDir();
		}
		const cwd = options.cwd ?? process.cwd();

		pi.registerTool({
			name: "list_roles",
			label: "查看可用岗位角色",
			description:
				"List bundled and local Personal Agent role definitions available for delegation and board collaboration.",
			parameters: {
				type: "object",
				properties: {
					includeBody: {
						type: "boolean",
						description: "When true, include each role's full Markdown instructions and boundaries.",
					},
				},
				additionalProperties: false,
			},
			async execute(_callId, rawArgs) {
				const includeBody = Boolean(
					rawArgs && typeof rawArgs === "object" && (rawArgs as { includeBody?: unknown }).includeBody,
				);
				const roles = listRoleDefinitions({ cwd, env }).map((role) => ({
					id: role.id,
					name: role.name,
					title: role.title,
					tools: role.tools,
					skills: role.skills,
					antiJobs: role.antiJobs,
					sourcePath: role.sourcePath,
					...(includeBody ? { body: role.body } : {}),
				}));
				return {
					content: [{ type: "text", text: JSON.stringify({ roles }) }],
					details: { roles },
				};
			},
		});

		pi.registerCommand?.("roles", {
			description: "List available PA role definitions (/roles)",
			async handler(_rawArgs, ctx) {
				const summary = formatRoleSummaryText(listRoleDefinitions({ cwd, env }));
				ctx?.ui?.notify?.(summary, "info");
				return summary;
			},
		});
	};
}

export default function rolesExtension(pi: RolesExtensionApi): void {
	createRolesExtension()(pi);
}
