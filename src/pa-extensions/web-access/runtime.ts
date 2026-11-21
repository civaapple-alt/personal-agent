import type { WorkerSessionMode } from "../../orchestrator/types.ts";
import { isArchitectRoleTemplate } from "../../roles/role-architect.ts";
import type { RoleTemplate } from "../../roles/types.ts";
import type { PersonalAgentStore } from "../../storage/repositories.ts";
import type { PlatformSettings, TeamMember } from "../../storage/types.ts";
import { findInstalledPiWebAccess } from "./package.ts";

export const PI_WEB_SEARCH_TOOLS = ["web_search", "get_search_content"] as const;
const WEB_ACCESS_TOOLS = new Set<string>([...PI_WEB_SEARCH_TOOLS, "web_enable", "source_check", "fetch_content"]);

export function isPiWebAccessTool(name: string): boolean {
	return WEB_ACCESS_TOOLS.has(name);
}

export function isWebAccessRole(member: TeamMember, template?: RoleTemplate): boolean {
	return !isArchitectRoleTemplate(template ?? { id: member.id });
}

export function hasWebAccessGrant(
	member: TeamMember,
	grants: PlatformSettings["webAccessRoleGrants"] | undefined,
): boolean {
	return grants?.[member.id] === member.createdAt;
}

export async function prepareWebAccessForWorker({
	store,
	member,
	template,
	sessionMode,
}: {
	store: Pick<PersonalAgentStore, "getPlatformSettings">;
	member: TeamMember;
	template: RoleTemplate | undefined;
	sessionMode: WorkerSessionMode;
}) {
	if (sessionMode === "observer" || sessionMode === "verifier" || !isWebAccessRole(member, template)) return null;
	if (!hasWebAccessGrant(member, store.getPlatformSettings().webAccessRoleGrants)) return null;

	const installed = await findInstalledPiWebAccess("pi");
	if (!installed) {
		throw new Error("此岗位已获网页检索权限，但 pi-web-access 安装不可用。请在设置的扩展插件页检查安装。");
	}
	return { entry: installed.entry, tools: PI_WEB_SEARCH_TOOLS };
}

/** Keep these Pi extension commands as matter text. Pi handles slash commands before the model. */
export function escapeWebAccessSlashCommand(prompt: string): string {
	return /^\s*\/(?:websearch|curator|search|google-account)(?:\s|$)/.test(prompt)
		? `User message:\n${prompt}`
		: prompt;
}
