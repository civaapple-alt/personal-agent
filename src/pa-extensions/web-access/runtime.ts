import type { PersonalAgentStore } from "../../storage/repositories.ts";
import { readWebAccessEnvFromDotEnv, resolveEnvFilePath } from "../env-credentials.ts";
import { findInstalledPiWebAccess } from "./package.ts";

export const PI_WEB_SEARCH_TOOLS = ["web_search", "get_search_content", "fetch_content"] as const;

export type WebSearchProviderPreference = "auto" | "deepseek" | "exa" | "kimi";
export type ResolvedWebSearchProvider = "deepseek" | "exa" | "kimi";

/** Default auto-selection order when multiple web-access API keys are present. */
export const DEFAULT_WEB_SEARCH_PROVIDER_ORDER: readonly ResolvedWebSearchProvider[] = ["exa", "deepseek", "kimi"];

export function isWebSearchProviderPreference(value: unknown): value is WebSearchProviderPreference {
	return value === "auto" || value === "deepseek" || value === "exa" || value === "kimi";
}

/** Resolve which web_search provider PA should pass to pi-web-access based on preference and available keys. */
export function resolveEffectiveWebSearchProvider(
	preference: WebSearchProviderPreference | undefined,
	dotEnvWebAccess: Record<string, string>,
	processEnv: NodeJS.ProcessEnv = process.env,
): ResolvedWebSearchProvider | undefined {
	const pref = preference ?? "auto";
	if (pref !== "auto") return pref;
	const hasKey = (key: string) => Boolean(processEnv[key]?.trim() || dotEnvWebAccess[key]?.trim());
	const keyByProvider: Record<ResolvedWebSearchProvider, string> = {
		exa: "EXA_API_KEY",
		deepseek: "DEEPSEEK_API_KEY",
		kimi: "MOONSHOT_API_KEY",
	};
	for (const candidate of DEFAULT_WEB_SEARCH_PROVIDER_ORDER) {
		if (hasKey(keyByProvider[candidate])) return candidate;
	}
	return undefined;
}

export async function prepareWebAccessForWorker({
	store,
	envFilePath = resolveEnvFilePath(),
}: {
	store: Pick<PersonalAgentStore, "getPlatformSettings">;
	envFilePath?: string;
}) {
	const settings = store.getPlatformSettings();
	const installed = await findInstalledPiWebAccess("pi");
	if (!installed) {
		return null;
	}
	const env = await readWebAccessEnvFromDotEnv(envFilePath);
	const effectiveProvider = resolveEffectiveWebSearchProvider(settings.webSearchProvider, env);
	if (effectiveProvider) {
		env.PA_WEB_SEARCH_PROVIDER = effectiveProvider;
	}
	return { entry: installed.entry, tools: PI_WEB_SEARCH_TOOLS, env };
}

/** Keep these Pi extension commands as matter text. Pi handles slash commands before the model. */
export function escapeWebAccessSlashCommand(prompt: string): string {
	return /^\s*\/(?:websearch|curator|search|google-account)(?:\s|$)/.test(prompt)
		? `User message:\n${prompt}`
		: prompt;
}
