export const PA_EXTENSION_SDK_API_VERSION = "1.0" as const;

export const INTERNAL_ONLY_SERVER_FIELDS = [
	"builtinPiEntry",
	"builtinSkillPackage",
	"workflowRule",
	"workflowSkillDir",
	"supersedesPackages",
] as const;

export interface ExternalExtensionManifest {
	readonly apiVersion: typeof PA_EXTENSION_SDK_API_VERSION;
	readonly name: string;
	readonly title: string;
	readonly description?: string;
	readonly server?: string;
	readonly web?: string;
}

export interface ManifestValidationResult {
	readonly ok: boolean;
	readonly errors: readonly string[];
}

const EXTENSION_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validate an external PA extension descriptor or manifest against the curated v1.0 SDK contract. */
export function validateExternalExtensionDescriptor(value: unknown): ManifestValidationResult {
	const errors: string[] = [];
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { ok: false, errors: ["Extension descriptor must be a plain object"] };
	}
	const record = value as Record<string, unknown>;
	if (record.apiVersion !== PA_EXTENSION_SDK_API_VERSION) {
		errors.push(`Unsupported apiVersion: expected "${PA_EXTENSION_SDK_API_VERSION}"`);
	}
	if (typeof record.name !== "string" || !EXTENSION_NAME_RE.test(record.name)) {
		errors.push("Invalid extension name: expected lowercase kebab-case");
	}
	if (typeof record.title !== "string" || !record.title.trim()) {
		errors.push("Extension title must be a non-empty string");
	}
	for (const forbidden of INTERNAL_ONLY_SERVER_FIELDS) {
		if (forbidden in record && record[forbidden] !== undefined) {
			errors.push(`Field "${forbidden}" is reserved for built-in PA extensions and not part of @pa/extension-sdk`);
		}
	}
	return { ok: errors.length === 0, errors };
}
