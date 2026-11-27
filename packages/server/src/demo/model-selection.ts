import { THINKING_LEVELS } from "@pa/contracts";
import { readPiModelCatalog } from "../rpc/model-catalog.ts";
import type { ModelSelection } from "../rpc/model-selection.ts";
import type { ThinkingLevel } from "../rpc/types.ts";

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

/** Parse a comma-separated provider allowlist (`PA_E2E_ALLOWED_PROVIDERS`); returns `null` when unrestricted. */
export function parseAllowedProviders(raw?: string): string[] | null {
	if (!raw || !raw.trim()) return null;
	const parsed = [
		...new Set(
			raw
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean),
		),
	];
	return parsed.length > 0 ? parsed : null;
}

/** Fail closed if an allowlist is configured and the target provider is not present. */
export function enforceAllowedProvider(provider: string, allowed: readonly string[] | null): void {
	if (!allowed || allowed.length === 0) return;
	if (!allowed.includes(provider)) {
		throw new Error(
			`Provider "${provider}" is blocked by cost allowlist [${allowed.join(", ")}] (PA_E2E_ALLOWED_PROVIDERS).`,
		);
	}
}

export function parseDemoThinkingLevel(raw?: string): ThinkingLevel | undefined {
	const normalized = raw?.trim();
	if (!normalized) return undefined;
	if (!THINKING_LEVEL_SET.has(normalized)) {
		throw new Error(`Invalid thinking level "${normalized}". Expected one of: ${THINKING_LEVELS.join(", ")}`);
	}
	return normalized as ThinkingLevel;
}

/** Resolve verifier provider/model from explicit options or `PA_E2E_VERIFIER_*` env, enforcing allowlist. */
export function resolveVerifierModelFromEnv(
	options: { verifierProvider?: string; verifierModel?: string } = {},
	env: NodeJS.ProcessEnv = process.env,
): { verifierProvider?: string; verifierModel?: string } {
	const verifierProvider = options.verifierProvider ?? (env.PA_E2E_VERIFIER_PROVIDER?.trim() || undefined);
	const verifierModel = options.verifierModel ?? (env.PA_E2E_VERIFIER_MODEL?.trim() || undefined);
	if ((verifierProvider && !verifierModel) || (!verifierProvider && verifierModel)) {
		throw new Error("Configure both verifier provider and verifier model together");
	}
	const allowed = parseAllowedProviders(env.PA_E2E_ALLOWED_PROVIDERS);
	if (verifierProvider) {
		enforceAllowedProvider(verifierProvider, allowed);
	}
	return verifierProvider && verifierModel ? { verifierProvider, verifierModel } : {};
}

export async function selectDemoModel(
	cwd: string,
	options: { provider?: string; model?: string; thinkingLevel?: ThinkingLevel } = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<ModelSelection> {
	const envProvider = env.PA_E2E_PROVIDER?.trim() || undefined;
	const envModel = env.PA_E2E_MODEL?.trim() || undefined;
	if ((envProvider && !envModel) || (!envProvider && envModel)) {
		throw new Error("Set both PA_E2E_PROVIDER and PA_E2E_MODEL together");
	}
	const provider = options.provider ?? envProvider;
	const model = options.model ?? envModel;
	if ((provider && !model) || (!provider && model)) {
		throw new Error("Pass both --provider and --model together");
	}

	const allowedProviders = parseAllowedProviders(env.PA_E2E_ALLOWED_PROVIDERS);
	if (provider) {
		enforceAllowedProvider(provider, allowedProviders);
	}

	const requestedThinking = parseDemoThinkingLevel(env.PA_E2E_THINKING) ?? options.thinkingLevel;

	const { defaultModel, models } = await readPiModelCatalog(cwd);
	const candidates = models.filter(
		(item) => (!provider || item.provider === provider) && (!model || item.model === model),
	);
	const selected =
		candidates.find((item) => item.provider === defaultModel?.provider && item.model === defaultModel.model) ??
		(candidates.length === 1 ? candidates[0] : null);
	if (!selected) throw new Error("Configure a Pi default model or pass both --provider and --model");

	enforceAllowedProvider(selected.provider, allowedProviders);

	const thinkingLevel =
		requestedThinking && selected.thinkingLevels.includes(requestedThinking) ? requestedThinking : undefined;
	return { provider: selected.provider, model: selected.model, thinkingLevel };
}
