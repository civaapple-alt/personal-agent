import { type ModelSelection, type PiModelCatalog, readStoredModelSelection } from "../rpc/model-selection.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { RpcWorkerLike } from "./types.ts";

export type ReadPiModels = (selection?: ModelSelection) => Promise<PiModelCatalog>;

export function resolveConfiguredModel(
	store: PersonalAgentStore,
	orgId?: string | null,
	memberId?: string,
	override?: ModelSelection | null,
): ModelSelection | null {
	if (override) return override;
	const platform = store.getPlatformSettings().defaultModelSelection;
	if (!orgId || !memberId) return platform;
	const role = store.listOrgAiRoleConfigs(orgId).find((config) => config.enabled && config.memberId === memberId);
	if (!role) return platform;
	return (
		readStoredModelSelection({
			provider: role.providerOverride,
			model: role.modelOverride,
			thinkingLevel: role.thinkingLevelOverride,
		}) ?? platform
	);
}

/** Apply the selected model to the existing Pi session before sending the first prompt of a turn. */
export async function applyWorkerModel(worker: RpcWorkerLike, selection: ModelSelection | null) {
	const state = await worker.getState();
	if (!selection) return state;
	if (worker.setModel && (state.model?.provider !== selection.provider || state.model.id !== selection.model)) {
		await worker.setModel(selection.provider, selection.model);
	}
	const level = selection.thinkingLevel;
	if (level !== undefined && worker.setThinkingLevel) {
		const available = await worker.getAvailableThinkingLevels?.();
		if (available && !available.includes(level)) {
			throw new Error(`${selection.provider}/${selection.model} 不支持推理等级 ${level}`);
		}
		await worker.setThinkingLevel(level);
	}
	if (!worker.setModel) return state;
	const effective = await worker.getState();
	if (effective.model?.provider !== selection.provider || effective.model.id !== selection.model) {
		throw new Error(`Pi 未采用所选模型 ${selection.provider}/${selection.model}`);
	}
	return effective;
}
