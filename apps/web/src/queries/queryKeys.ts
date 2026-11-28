/** Hierarchical query key registry for workbench server-state caches. */
export const queryKeys = {
	admin: {
		all: ["admin"] as const,
		overview: () => ["admin", "overview"] as const,
	},
	runtime: {
		all: ["runtime"] as const,
		overview: () => ["runtime", "overview"] as const,
	},
	spaces: {
		all: ["spaces"] as const,
		list: () => ["spaces", "list"] as const,
		documents: (spaceId: string) => ["spaces", "documents", spaceId] as const,
		document: (docId: string) => ["spaces", "document", docId] as const,
		documentCommits: (docId: string) => ["spaces", "commits", docId] as const,
		commitDetail: (docId: string, hash: string) => ["spaces", "commitDetail", docId, hash] as const,
	},
	workspaces: {
		all: ["workspaces"] as const,
		customizations: (workspaceId: string, folderFilter?: string) =>
			["workspaces", "customizations", workspaceId, folderFilter ?? ""] as const,
	},
	team: {
		all: ["team"] as const,
		memberSkill: (memberId: string, skillRef: string) => ["team", "memberSkill", memberId, skillRef] as const,
	},
	organizations: {
		all: ["organizations"] as const,
		invites: (orgId: string) => ["organizations", "invites", orgId] as const,
	},
} as const;
