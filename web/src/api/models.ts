import type { ModelSelection, PiModelCatalog } from "../../../src/rpc/model-selection.ts";
import { requestJson } from "./client.ts";

export type { ModelSelection };

export interface ModelCatalogDto extends PiModelCatalog {
	platformDefault: ModelSelection | null;
}

export function fetchModels(signal?: AbortSignal): Promise<ModelCatalogDto> {
	return requestJson("/api/models", { signal });
}

export async function fetchModelDefault(provider: string, model: string, signal: AbortSignal) {
	const query = new URLSearchParams({ provider, model });
	const response = await requestJson<Pick<ModelCatalogDto, "defaultModel">>(`/api/models?${query}`, { signal });
	return response.defaultModel;
}
