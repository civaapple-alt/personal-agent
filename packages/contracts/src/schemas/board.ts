import * as v from "valibot";
import { TrimmedStringSchema } from "./common.ts";

export const BoardPostKindSchema = v.picklist([
	"assign",
	"progress",
	"handoff",
	"verify_pass",
	"verify_rework",
	"escalate",
	"clarification",
	"summary",
]);

export const BoardMemberStatusSchema = v.picklist(["working", "waiting", "blocked_human", "stopped", "retired"]);

export const CreateBoardPostSchema = v.pipe(
	v.object({
		kind: v.optional(BoardPostKindSchema),
		mentions: v.optional(v.array(v.string())),
		refPostNos: v.optional(v.array(v.number())),
		summary: v.optional(TrimmedStringSchema),
		body: v.optional(v.string()),
		artifacts: v.optional(v.nullable(v.record(v.string(), v.unknown()))),
		verification: v.optional(v.nullable(v.record(v.string(), v.unknown()))),
		autoResume: v.optional(v.boolean()),
	}),
	v.check(
		(input) => Boolean((typeof input.summary === "string" && input.summary.trim()) || input.body?.trim()),
		"summary or body is required",
	),
);

export const UpdateBoardMemberSchema = v.object({
	action: v.optional(v.picklist(["pause", "resume"])),
	status: v.optional(BoardMemberStatusSchema),
	modelOverride: v.optional(v.unknown()),
});
