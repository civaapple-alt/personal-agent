import * as v from "valibot";
import { nonEmptyString } from "./common.ts";

export const SkillTrustScopeSchema = v.picklist(["global", "org", "personal", "workspace"]);
export const SkillTrustLevelSchema = v.picklist(["confirm", "autonomous", "disabled"]);

export const UpdateSkillTrustSchema = v.object({
	scope: SkillTrustScopeSchema,
	scopeId: v.string(),
	skillName: nonEmptyString("skillName is required"),
	trustLevel: SkillTrustLevelSchema,
});
