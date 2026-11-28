import * as v from "valibot";

export * from "./admin.ts";
export * from "./board.ts";
export * from "./common.ts";
export * from "./matter.ts";
export * from "./organization.ts";
export * from "./skill-trust.ts";
export * from "./space.ts";

export { v };
export type InferSchemaOutput<TSchema extends v.GenericSchema> = v.InferOutput<TSchema>;
