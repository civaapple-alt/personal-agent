import * as v from "valibot";
import { nonEmptyString } from "./common.ts";

export const OrgMemberRoleSchema = v.picklist(["org_owner", "org_admin", "org_member", "org_viewer"]);
export const WorkspaceVisibilitySchema = v.picklist(["org", "restricted"]);

export const CreateOrgSchema = v.object({
	name: nonEmptyString("组织名称不能为空"),
	gitEmailDomain: v.optional(v.string()),
	useRoleGitIdentity: v.optional(v.boolean()),
	description: v.optional(v.string()),
});

export const UpdateOrgSchema = v.object({
	name: v.optional(v.string()),
	gitEmailDomain: v.optional(v.string()),
	useRoleGitIdentity: v.optional(v.boolean()),
	description: v.optional(v.string()),
});

export const AddOrgMemberSchema = v.object({
	email: v.optional(v.string()),
	userId: v.optional(v.string()),
	orgRole: v.optional(OrgMemberRoleSchema),
	roleTitle: v.optional(v.string()),
});

export const UpdateOrgMemberSchema = v.object({
	orgRole: v.optional(OrgMemberRoleSchema),
	roleTitle: v.optional(v.string()),
});

export const CreateOrgInviteSchema = v.object({
	orgRole: v.optional(OrgMemberRoleSchema),
	maxUses: v.optional(v.number()),
	expiresInHours: v.optional(v.number()),
});

export const JoinOrgSchema = v.object({
	inviteToken: nonEmptyString("inviteToken is required"),
});

export const UpdateOrgAiRolesSchema = v.looseObject({
	primaryMemberId: v.optional(v.nullable(v.string())),
	useRoleGitIdentity: v.optional(v.boolean()),
	roles: v.optional(v.array(v.looseObject({ memberId: nonEmptyString("memberId is required") }))),
});

export const CreateWorkspaceSchema = v.looseObject({
	name: v.optional(v.string()),
	sourceType: v.optional(v.picklist(["local", "clone", "cloned"])),
	repoPath: v.optional(v.string()),
	cloneUrl: v.optional(v.nullable(v.string())),
	defaultBranch: v.optional(v.string()),
	description: v.optional(v.string()),
	orgId: v.optional(v.nullable(v.string())),
	visibility: v.optional(WorkspaceVisibilitySchema),
	allowedUserIds: v.optional(v.array(v.string())),
});

export const UpdateWorkspaceSchema = v.looseObject({
	orgId: v.optional(v.nullable(v.string())),
	visibility: v.optional(WorkspaceVisibilitySchema),
	allowedUserIds: v.optional(v.array(v.string())),
	description: v.optional(v.string()),
	defaultBranch: v.optional(v.string()),
});

export const AddWorkspaceFolderSchema = v.object({
	path: nonEmptyString("目录路径不能为空"),
	label: v.optional(v.string()),
	loadRules: v.optional(v.boolean()),
	loadSkills: v.optional(v.boolean()),
});

export const UpdateWorkspaceFolderSchema = v.object({
	setPrimary: v.optional(v.boolean()),
	label: v.optional(v.string()),
	loadRules: v.optional(v.boolean()),
	loadSkills: v.optional(v.boolean()),
});

export const UpdateWorkspacePiTrustSchema = v.object({
	trusted: v.union([v.boolean(), v.null()], "trusted 字段必须为 true、false 或 null"),
});
