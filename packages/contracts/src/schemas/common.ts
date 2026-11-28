import * as v from "valibot";

/** Create a trimmed non-empty string schema with a custom validation error message. */
export function nonEmptyString(message: string) {
	return v.pipe(
		v.string(message),
		v.transform((value) => value.trim()),
		v.minLength(1, message),
	);
}

export const TrimmedStringSchema = v.pipe(
	v.string(),
	v.transform((value) => value.trim()),
);

export const ThinkingLevelSchema = v.picklist(["off", "minimal", "low", "medium", "high", "xhigh"]);

export const ModelSelectionSchema = v.object({
	provider: nonEmptyString("provider is required"),
	model: nonEmptyString("model is required"),
	thinkingLevel: v.optional(ThinkingLevelSchema),
});

export const StringArraySchema = v.array(v.string());
