import { readPiModelCatalog } from "../rpc/model-catalog.ts";
import type { ModelSelection } from "../rpc/model-selection.ts";
import type { ThinkingLevel } from "../rpc/types.ts";

export async function selectDemoModel(
	cwd: string,
	options: { provider?: string; model?: string; thinkingLevel?: ThinkingLevel } = {},
): Promise<ModelSelection> {
	const { defaultModel, models } = await readPiModelCatalog(cwd);
	const { provider, model } = options;
	const candidates = models.filter(
		(item) => (!provider || item.provider === provider) && (!model || item.model === model),
	);
	const selected =
		candidates.find((item) => item.provider === defaultModel?.provider && item.model === defaultModel.model) ??
		(candidates.length === 1 ? candidates[0] : null);
	if (!selected) throw new Error("Configure a Pi default model or pass both --provider and --model");
	const thinkingLevel =
		options.thinkingLevel && selected.thinkingLevels.includes(options.thinkingLevel)
			? options.thinkingLevel
			: undefined;
	return { provider: selected.provider, model: selected.model, thinkingLevel };
}
