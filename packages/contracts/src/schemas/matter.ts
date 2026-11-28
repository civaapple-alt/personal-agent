import * as v from "valibot";
import { nonEmptyString } from "./common.ts";

export const MatterVisibilitySchema = v.picklist(["org", "private"]);
export const MatterCollaborationModeSchema = v.picklist(["lead", "board"]);
export const MatterSendModeSchema = v.picklist(["conversation", "discussion", "dispatch", "ai_request"]);

export const DialogRespondSchema = v.pipe(
	v.object({
		cancelled: v.optional(v.boolean()),
		confirmed: v.optional(v.boolean()),
		value: v.optional(v.string()),
	}),
	v.check(
		(input) => input.cancelled === true || typeof input.confirmed === "boolean" || typeof input.value === "string",
		"Expected confirmed, value, or cancelled",
	),
);

export const HumanDecisionSchema = v.pipe(
	v.object({
		action: v.picklist(["answer", "assign", "resume"], "action must be answer, assign, or resume"),
		revision: v.optional(v.number()),
		answer: v.optional(v.string()),
		assignedUserId: v.optional(v.string()),
	}),
	v.check((input) => {
		if (input.action === "answer") return typeof input.answer === "string" && input.answer.trim().length > 0;
		if (input.action === "assign") {
			return typeof input.assignedUserId === "string" && input.assignedUserId.trim().length > 0;
		}
		return true;
	}, "Invalid human decision payload"),
);

export const AssessMatterSchema = v.object({
	text: v.optional(v.string()),
	workspaceId: v.optional(v.nullable(v.string())),
	orgId: v.optional(v.nullable(v.string())),
	hasFiles: v.optional(v.boolean()),
	mode: v.optional(v.picklist(["rules", "model"])),
	readRepo: v.optional(v.boolean()),
});

export const UpdateMatterSchema = v.object({
	title: v.optional(v.string()),
	status: v.optional(v.picklist(["open", "waiting_user", "archived"])),
	summary: v.optional(v.string()),
	visibility: v.optional(MatterVisibilitySchema),
	collaborationMode: v.optional(MatterCollaborationModeSchema),
	coordinatorMemberId: v.optional(v.nullable(v.string())),
});

export const UpdateMatterWorkspaceSchema = v.object({
	workspaceId: v.optional(v.nullable(v.string())),
});

export const UpdateMatterCollaboratorsSchema = v.object({
	collaboratorIds: v.optional(v.array(v.string())),
	visibility: v.optional(MatterVisibilitySchema),
});

export const UpdateMatterMembersSchema = v.object({
	leadMemberId: v.optional(v.nullable(v.string())),
	aiMemberIds: v.optional(v.nullable(v.array(v.string()))),
	consultMemberIds: v.optional(v.nullable(v.array(v.string()))),
	observersEnabled: v.optional(v.boolean()),
	observerMemberIds: v.optional(v.array(v.string())),
	discussionAiEnabled: v.optional(v.boolean()),
	collaborationMode: v.optional(MatterCollaborationModeSchema),
	coordinatorMemberId: v.optional(v.nullable(v.string())),
});

export const UpdateMatterModelSchema = v.object({
	modelSelection: v.optional(v.unknown()),
});

export const CreateMatterSchema = v.looseObject({
	title: v.optional(v.string()),
	text: v.optional(v.string()),
	workspaceId: v.optional(v.nullable(v.string())),
	orgId: v.optional(v.nullable(v.string())),
	leadMemberId: v.optional(v.nullable(v.string())),
	visibility: v.optional(MatterVisibilitySchema),
	mode: v.optional(MatterSendModeSchema),
	collaborationMode: v.optional(MatterCollaborationModeSchema),
	coordinatorMemberId: v.optional(v.nullable(v.string())),
});

export const PostMatterMessageSchema = v.looseObject({
	text: v.optional(v.string()),
	mode: v.optional(MatterSendModeSchema),
});

export const MatterRequestActionSchema = v.object({
	action: nonEmptyString("action is required"),
});
