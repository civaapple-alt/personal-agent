import * as v from "valibot";
import { nonEmptyString } from "./common.ts";

export const AuthLoginSchema = v.object({
	email: nonEmptyString("请输入邮箱和密码"),
	password: nonEmptyString("请输入邮箱和密码"),
	inviteToken: v.optional(v.string()),
});

export const AuthRegisterSchema = v.object({
	email: nonEmptyString("请输入有效的邮箱和密码"),
	password: v.string("请输入有效的邮箱和密码"),
	displayName: v.optional(v.string()),
	inviteToken: v.optional(v.string()),
});

export const AuthSetupAdminSchema = v.object({
	email: nonEmptyString("请输入管理员邮箱、姓名和密码"),
	password: v.string("请输入管理员邮箱、姓名和密码"),
	displayName: v.optional(v.string()),
});

export const AuthChangePasswordSchema = v.object({
	currentPassword: v.optional(v.string()),
	newPassword: v.string("新密码长度至少 8 位"),
});

export const UpdateAdminSettingsSchema = v.looseObject({
	registrationMode: v.optional(v.picklist(["open_auto", "open_review", "invite_only"])),
	workspacesRoot: v.optional(v.string()),
	allowLocalWorkspacePath: v.optional(v.boolean()),
	localWorkspaceAllowlist: v.optional(v.union([v.string(), v.array(v.string())])),
	allowCommandPreviews: v.optional(v.boolean()),
	systemOneEnabled: v.optional(v.boolean()),
	defaultMaxOrgs: v.optional(v.number()),
	defaultMaxActiveDispatches: v.optional(v.number()),
	defaultMaxPersonalRoles: v.optional(v.number()),
	webSearchProvider: v.optional(v.picklist(["auto", "deepseek", "exa", "kimi"])),
	defaultModelSelection: v.optional(v.unknown()),
});

export const UpdateAdminUserSchema = v.looseObject({
	status: v.optional(v.picklist(["active", "pending_review", "disabled"])),
	platformRole: v.optional(v.picklist(["super_admin", "user"])),
	canDispatchAi: v.optional(v.boolean()),
	maxOrgs: v.optional(v.number()),
	maxActiveDispatches: v.optional(v.number()),
	maxPersonalRoles: v.optional(v.number()),
});
