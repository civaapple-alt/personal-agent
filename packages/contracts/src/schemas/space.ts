import * as v from "valibot";
import { nonEmptyString } from "./common.ts";

export const SpaceDocTypeSchema = v.picklist(["plan", "spec", "decision", "rule", "note"]);
export const SpaceEntryKindSchema = v.picklist(["file", "folder"]);
export const SpaceVisibilitySchema = v.picklist(["org", "private"]);
export const FeedbackRatingSchema = v.picklist(["positive", "negative", "neutral"]);

export const CreateSpaceSchema = v.object({
	name: nonEmptyString("name is required"),
	description: v.optional(v.string()),
	orgId: v.optional(v.nullable(v.string())),
	visibility: v.optional(SpaceVisibilitySchema),
});

export const CreateSpaceDocumentSchema = v.looseObject({
	title: v.optional(v.string()),
	docType: v.optional(v.string()),
	entryKind: v.optional(v.string()),
	content: v.optional(v.string()),
	matterId: v.optional(v.nullable(v.string())),
	linkedOrgId: v.optional(v.nullable(v.string())),
	linkedWorkspaceId: v.optional(v.nullable(v.string())),
	linkedFilePath: v.optional(v.nullable(v.string())),
	commitMessage: v.optional(v.string()),
	extraFiles: v.optional(v.array(v.object({ path: v.string(), content: v.string() }))),
});

export const UpdateSpaceDocumentSchema = v.looseObject({
	revision: v.optional(v.number()),
	title: v.optional(v.string()),
	docType: v.optional(v.string()),
	content: v.optional(v.string()),
	linkedOrgId: v.optional(v.nullable(v.string())),
	linkedWorkspaceId: v.optional(v.nullable(v.string())),
	linkedFilePath: v.optional(v.nullable(v.string())),
	commitMessage: v.optional(v.string()),
});

export const SpaceFeedbackSchema = v.object({
	rating: v.optional(v.nullable(FeedbackRatingSchema)),
	feedback: v.optional(v.string()),
	commitHash: v.optional(v.string()),
});

export const SpaceFolderFileSchema = v.object({
	path: nonEmptyString("path is required"),
	content: v.optional(v.string()),
	commitMessage: v.optional(v.string()),
});
