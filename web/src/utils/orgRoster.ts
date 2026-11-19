import type { MemberMemoryDto, OrganizationAiRoleConfigDto, OrganizationDto, TeamMemberDto } from "../api.ts";

// UI projection helpers mirroring backend organization roster & Git identity rules
// (authoritative server logic lives in src/storage/repos/org-rbac-repo.ts and src/storage/repos/member-repo.ts).

const ASCII_PRINTABLE_RE = /^[\x20-\x7E]+$/;

export function defaultMemberGitName(member: { id: string; displayName?: string; roleTitle?: string }): string {
	const displayName = member.displayName?.trim() ?? "";
	if (displayName && ASCII_PRINTABLE_RE.test(displayName)) return displayName;
	const roleTitle = member.roleTitle?.trim() ?? "";
	if (roleTitle && ASCII_PRINTABLE_RE.test(roleTitle)) return roleTitle;
	return member.id.trim() || roleTitle || displayName || "team-member";
}

export function formatMemberGitIdentity(
	member: Pick<TeamMemberDto, "id" | "displayName" | "gitName" | "gitEmail"> & { roleTitle?: string },
	organization?: Pick<OrganizationDto, "gitEmailDomain"> | null,
): { gitName: string; gitEmail: string; formatted: string } {
	const gitName = (member.gitName || "").trim() || defaultMemberGitName(member);
	const rawEmail = (member.gitEmail || "").trim();
	const domain = organization?.gitEmailDomain?.trim().replace(/^@+/, "") ?? "";
	const isDefaultEmail = !rawEmail || rawEmail === `${member.id}@team.local`;
	const gitEmail = isDefaultEmail && domain ? `${member.id}@${domain}` : rawEmail || `${member.id}@team.local`;
	return { gitName, gitEmail, formatted: `${gitName} <${gitEmail}>` };
}

export function countMemberMemoriesByScope(memories: MemberMemoryDto[]): {
	totalActive: number;
	roleGeneral: number;
	companyPrivate: number;
	projectPrivate: number;
	pendingReview: number;
} {
	let roleGeneral = 0;
	let companyPrivate = 0;
	let projectPrivate = 0;
	let pendingReview = 0;
	for (const memory of memories) {
		if (memory.status === "rejected" || memory.status === "superseded") continue;
		if (memory.status === "candidate") pendingReview += 1;
		if (memory.scope === "role_general") roleGeneral += 1;
		else if (memory.scope === "company_private") companyPrivate += 1;
		else if (memory.scope === "project_private") projectPrivate += 1;
	}
	return {
		totalActive: roleGeneral + companyPrivate + projectPrivate,
		roleGeneral,
		companyPrivate,
		projectPrivate,
		pendingReview,
	};
}

/** Picks the first valid workspace id from ordered candidates, falling back to the first workspace. */
export function pickDefaultWorkspaceId(
	workspaces: Array<{ id: string }>,
	...candidates: Array<string | null | undefined>
): string {
	for (const candidate of candidates) {
		if (candidate && workspaces.some((ws) => ws.id === candidate)) {
			return candidate;
		}
	}
	return workspaces[0]?.id ?? "";
}

export interface OrgAiRolesRosterEntry {
	configured: boolean;
	configs: OrganizationAiRoleConfigDto[];
	effectiveMemberIds: string[];
}

/** Resolves the effective primary AI contact id for an organization (or global fallback). */
export function resolveEffectivePrimaryContactId(
	members: TeamMemberDto[],
	orgId: string | null | undefined,
	orgAiRolesByOrgId?: Record<string, OrgAiRolesRosterEntry>,
): string | null {
	const entry = orgId ? orgAiRolesByOrgId?.[orgId] : undefined;
	if (entry && (entry.configured || entry.configs.length > 0)) {
		const enabledIds =
			entry.effectiveMemberIds.length > 0
				? entry.effectiveMemberIds
				: entry.configs.filter((c) => c.enabled).map((c) => c.memberId);
		const enabledSet = new Set(enabledIds);
		const orgPrimary = entry.configs.find(
			(c) => c.enabled && c.isPrimaryContact && (enabledSet.size === 0 || enabledSet.has(c.memberId)),
		);
		if (orgPrimary) return orgPrimary.memberId;
		const globalPrimaryInOrg = members.find(
			(m) => (enabledSet.size === 0 || enabledSet.has(m.id)) && m.isPrimaryContact,
		);
		if (globalPrimaryInOrg) return globalPrimaryInOrg.id;
		if (enabledIds[0]) return enabledIds[0];
	}
	return (
		members.find((m) => m.roleScope !== "personal" && m.isPrimaryContact)?.id ??
		members.find((m) => m.isPrimaryContact)?.id ??
		members.find((m) => m.id !== "role-architect" && m.roleScope !== "personal")?.id ??
		members[0]?.id ??
		null
	);
}

/** Projects effective primary contact state onto a scoped member array for UI pickers. */
export function applyPrimaryContactToMembers(
	members: TeamMemberDto[],
	primaryMemberId: string | null | undefined,
): TeamMemberDto[] {
	if (!primaryMemberId) return members;
	return members.map((m) =>
		m.isPrimaryContact === (m.id === primaryMemberId) ? m : { ...m, isPrimaryContact: m.id === primaryMemberId },
	);
}

/** Applies per-organization AI role display/Git identity overrides onto member records. */
export function applyOrgAiRoleOverrides(
	members: TeamMemberDto[],
	orgId: string | null | undefined,
	orgAiRolesByOrgId?: Record<string, OrgAiRolesRosterEntry>,
): TeamMemberDto[] {
	const configs = orgId ? orgAiRolesByOrgId?.[orgId]?.configs : undefined;
	if (!configs || configs.length === 0) return members;
	const byId = new Map(configs.map((c) => [c.memberId, c]));
	return members.map((m) => {
		const cfg = byId.get(m.id);
		if (!cfg) return m;
		const nextGitName = cfg.gitNameOverride?.trim() || m.gitName;
		const nextGitEmail = cfg.gitEmailOverride?.trim() || m.gitEmail;
		const nextDisplayName = cfg.displayNameOverride?.trim() || m.displayName;
		const nextModel = cfg.modelOverride?.trim() || m.model;
		if (
			nextGitName === m.gitName &&
			nextGitEmail === m.gitEmail &&
			nextDisplayName === m.displayName &&
			nextModel === m.model
		) {
			return m;
		}
		return {
			...m,
			displayName: nextDisplayName,
			model: nextModel,
			gitName: nextGitName,
			gitEmail: nextGitEmail,
		};
	});
}
