import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { THINKING_LEVELS, type ThinkingLevel } from "@pa/contracts";

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

export interface LiveModelProfile {
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
	verifier?: {
		provider: string;
		model: string;
	};
}

export interface LiveE2eConfigFile {
	defaultProfile?: string;
	allowedProviders?: string[];
	profiles?: Record<string, LiveModelProfile>;
}

export interface ResolveLiveModelConfigInput {
	rootDir: string;
	configPath?: string;
	profile?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	verifierProvider?: string;
	verifierModel?: string;
	allowProviders?: string;
	env?: NodeJS.ProcessEnv;
}

export interface ResolvedLiveModelConfig {
	configPath: string | null;
	profileName: string | null;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	verifierProvider?: string;
	verifierModel?: string;
	allowedProviders: string[] | null;
}

function parseProviderList(raw: string | undefined): string[] | null {
	if (!raw || !raw.trim()) return null;
	const parsed = [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))];
	return parsed.length > 0 ? parsed : null;
}

function parseThinkingLevel(raw: string | undefined, source: string): ThinkingLevel | undefined {
	const value = raw?.trim();
	if (!value) return undefined;
	if (!THINKING_LEVEL_SET.has(value)) {
		throw new Error(`Invalid thinking level "${value}" from ${source}. Expected: ${THINKING_LEVELS.join(", ")}`);
	}
	return value as ThinkingLevel;
}

function assertNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`Invalid ${field}: expected a non-empty string`);
	}
	return value.trim();
}

/** Load `e2e/live.config.json` (or `PA_E2E_LIVE_CONFIG`); returns `null` when absent. */
export function loadLiveE2eConfig(
	rootDir: string,
	explicitPath?: string,
	env: NodeJS.ProcessEnv = process.env,
): { path: string; config: LiveE2eConfigFile } | null {
	const envPath = env.PA_E2E_LIVE_CONFIG?.trim();
	const candidate = explicitPath?.trim()
		? resolve(rootDir, explicitPath.trim())
		: envPath
			? resolve(rootDir, envPath)
			: resolve(rootDir, "e2e/live.config.json");

	if (!existsSync(candidate)) {
		if (explicitPath?.trim() || envPath) {
			throw new Error(`Live E2E config file not found: ${candidate}`);
		}
		return null;
	}

	let rawJson: unknown;
	try {
		rawJson = JSON.parse(readFileSync(candidate, "utf8"));
	} catch (err) {
		throw new Error(`Failed to parse JSON in ${candidate}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!rawJson || typeof rawJson !== "object" || Array.isArray(rawJson)) {
		throw new Error(`Invalid config object in ${candidate}`);
	}

	const obj = rawJson as Record<string, unknown>;
	const config: LiveE2eConfigFile = {};
	if (obj.defaultProfile !== undefined) {
		config.defaultProfile = assertNonEmptyString(obj.defaultProfile, "defaultProfile");
	}
	if (obj.allowedProviders !== undefined) {
		if (!Array.isArray(obj.allowedProviders)) {
			throw new Error("Invalid allowedProviders: expected string[]");
		}
		config.allowedProviders = [
			...new Set(obj.allowedProviders.map((item, idx) => assertNonEmptyString(item, `allowedProviders[${idx}]`))),
		];
	}
	if (obj.profiles !== undefined) {
		if (!obj.profiles || typeof obj.profiles !== "object" || Array.isArray(obj.profiles)) {
			throw new Error("Invalid profiles: expected object");
		}
		const profiles: Record<string, LiveModelProfile> = {};
		for (const [name, rawProfile] of Object.entries(obj.profiles as Record<string, unknown>)) {
			if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
				throw new Error(`Invalid profile "${name}": expected object`);
			}
			const entry = rawProfile as Record<string, unknown>;
			const profile: LiveModelProfile = {
				provider: assertNonEmptyString(entry.provider, `profiles.${name}.provider`),
				model: assertNonEmptyString(entry.model, `profiles.${name}.model`),
			};
			if (entry.thinkingLevel !== undefined) {
				profile.thinkingLevel = parseThinkingLevel(
					assertNonEmptyString(entry.thinkingLevel, `profiles.${name}.thinkingLevel`),
					`profiles.${name}.thinkingLevel`,
				);
			}
			if (entry.verifier !== undefined) {
				if (!entry.verifier || typeof entry.verifier !== "object" || Array.isArray(entry.verifier)) {
					throw new Error(`Invalid profiles.${name}.verifier: expected object`);
				}
				const v = entry.verifier as Record<string, unknown>;
				profile.verifier = {
					provider: assertNonEmptyString(v.provider, `profiles.${name}.verifier.provider`),
					model: assertNonEmptyString(v.model, `profiles.${name}.verifier.model`),
				};
			}
			profiles[name] = profile;
		}
		config.profiles = profiles;
	}

	return { path: candidate, config };
}

/** Resolve live model configuration with strict precedence: CLI > env > profile > Pi default. */
export function resolveLiveModelConfig(input: ResolveLiveModelConfigInput): ResolvedLiveModelConfig {
	const env = input.env ?? process.env;
	const loaded = loadLiveE2eConfig(input.rootDir, input.configPath, env);
	const config = loaded?.config;

	const requestedProfileName = input.profile?.trim() || env.PA_E2E_PROFILE?.trim() || null;
	const effectiveProfileName = requestedProfileName ?? config?.defaultProfile ?? null;

	let profile: LiveModelProfile | undefined;
	if (effectiveProfileName) {
		profile = config?.profiles?.[effectiveProfileName];
		if (!profile && (requestedProfileName || config?.defaultProfile)) {
			const available = Object.keys(config?.profiles ?? {});
			throw new Error(
				`Live model profile "${effectiveProfileName}" not found${available.length > 0 ? ` (available: ${available.join(", ")})` : ""}.`,
			);
		}
	}

	const cliProvider = input.provider?.trim() || undefined;
	const cliModel = input.model?.trim() || undefined;
	if ((cliProvider && !cliModel) || (!cliProvider && cliModel)) {
		throw new Error("Pass both --provider and --model together");
	}

	const envProvider = env.PA_E2E_PROVIDER?.trim() || undefined;
	const envModel = env.PA_E2E_MODEL?.trim() || undefined;
	if ((envProvider && !envModel) || (!envProvider && envModel)) {
		throw new Error("Set both PA_E2E_PROVIDER and PA_E2E_MODEL together");
	}

	const provider = cliProvider ?? envProvider ?? profile?.provider;
	const model = cliModel ?? envModel ?? profile?.model;

	const thinkingLevel =
		parseThinkingLevel(input.thinkingLevel, "--thinking") ??
		parseThinkingLevel(env.PA_E2E_THINKING, "PA_E2E_THINKING") ??
		profile?.thinkingLevel;

	const cliVerifierProvider = input.verifierProvider?.trim() || undefined;
	const cliVerifierModel = input.verifierModel?.trim() || undefined;
	if ((cliVerifierProvider && !cliVerifierModel) || (!cliVerifierProvider && cliVerifierModel)) {
		throw new Error("Pass both --verifier-provider and --verifier-model together");
	}

	const envVerifierProvider = env.PA_E2E_VERIFIER_PROVIDER?.trim() || undefined;
	const envVerifierModel = env.PA_E2E_VERIFIER_MODEL?.trim() || undefined;
	if ((envVerifierProvider && !envVerifierModel) || (!envVerifierProvider && envVerifierModel)) {
		throw new Error("Set both PA_E2E_VERIFIER_PROVIDER and PA_E2E_VERIFIER_MODEL together");
	}

	const verifierProvider = cliVerifierProvider ?? envVerifierProvider ?? profile?.verifier?.provider;
	const verifierModel = cliVerifierModel ?? envVerifierModel ?? profile?.verifier?.model;

	const allowedProviders =
		parseProviderList(input.allowProviders) ??
		parseProviderList(env.PA_E2E_ALLOWED_PROVIDERS) ??
		(config?.allowedProviders && config.allowedProviders.length > 0 ? [...config.allowedProviders] : null);

	if (allowedProviders) {
		if (provider && !allowedProviders.includes(provider)) {
			throw new Error(
				`Provider "${provider}" is blocked by cost allowlist [${allowedProviders.join(", ")}].`,
			);
		}
		if (verifierProvider && !allowedProviders.includes(verifierProvider)) {
			throw new Error(
				`Verifier provider "${verifierProvider}" is blocked by cost allowlist [${allowedProviders.join(", ")}].`,
			);
		}
	}

	return {
		configPath: loaded?.path ?? null,
		profileName: effectiveProfileName,
		...(provider ? { provider } : {}),
		...(model ? { model } : {}),
		...(thinkingLevel ? { thinkingLevel } : {}),
		...(verifierProvider ? { verifierProvider } : {}),
		...(verifierModel ? { verifierModel } : {}),
		allowedProviders,
	};
}

/** Build isolated child-process environment variables carrying resolved cost/model settings. */
export function buildLiveEnv(baseEnv: NodeJS.ProcessEnv, resolved: ResolvedLiveModelConfig): NodeJS.ProcessEnv {
	const next: NodeJS.ProcessEnv = { ...baseEnv };
	if (resolved.provider && resolved.model) {
		next.PA_E2E_PROVIDER = resolved.provider;
		next.PA_E2E_MODEL = resolved.model;
	} else {
		delete next.PA_E2E_PROVIDER;
		delete next.PA_E2E_MODEL;
	}
	if (resolved.thinkingLevel) {
		next.PA_E2E_THINKING = resolved.thinkingLevel;
	} else {
		delete next.PA_E2E_THINKING;
	}
	if (resolved.verifierProvider && resolved.verifierModel) {
		next.PA_E2E_VERIFIER_PROVIDER = resolved.verifierProvider;
		next.PA_E2E_VERIFIER_MODEL = resolved.verifierModel;
	} else {
		delete next.PA_E2E_VERIFIER_PROVIDER;
		delete next.PA_E2E_VERIFIER_MODEL;
	}
	if (resolved.allowedProviders && resolved.allowedProviders.length > 0) {
		next.PA_E2E_ALLOWED_PROVIDERS = resolved.allowedProviders.join(",");
	} else {
		delete next.PA_E2E_ALLOWED_PROVIDERS;
	}
	return next;
}
