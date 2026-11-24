import type { ModelSelection, PiModelCatalog } from "./model-selection.ts";
import { PiRpcWorker } from "./pi-rpc-worker.ts";
import { THINKING_LEVELS } from "./types.ts";

/** Probe Pi in the service account without applying repository resources or issuing a prompt. */
export async function readPiModelCatalog(cwd: string, selection?: ModelSelection): Promise<PiModelCatalog> {
	const worker = new PiRpcWorker({
		cwd,
		provider: selection?.provider,
		model: selection?.model,
		noSession: true,
		commandTimeoutMs: 5_000,
		args: ["--offline", "--no-approve", "--no-tools", "--no-context-files", "--no-extensions", "--no-skills"],
	});
	try {
		await worker.start();
		const [state, models] = await Promise.all([worker.getState(), worker.getAvailableModels()]);
		return {
			defaultModel: state.model
				? { provider: state.model.provider, model: state.model.id, thinkingLevel: state.thinkingLevel }
				: null,
			models: models.map((model) => ({
				provider: model.provider,
				model: model.id,
				name: model.name || model.id,
				thinkingLevels: model.reasoning
					? THINKING_LEVELS.filter((level) => {
							const mapped = model.thinkingLevelMap?.[level];
							return mapped !== null && (mapped !== undefined || (level !== "xhigh" && level !== "max"));
						})
					: ["off"],
			})),
		};
	} finally {
		await worker.stop();
	}
}
