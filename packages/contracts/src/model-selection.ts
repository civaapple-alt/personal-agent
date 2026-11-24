import { THINKING_LEVELS, type ThinkingLevel } from "./thinking-levels.ts";

/** An explicit model and an optional reasoning override. Null delegates selection to the next scope. */
export interface ModelSelection {
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
}

export interface SelectableModel {
	provider: string;
	model: string;
	name: string;
	thinkingLevels: ThinkingLevel[];
}

export interface PiModelCatalog {
	defaultModel: ModelSelection | null;
	models: SelectableModel[];
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return THINKING_LEVELS.some((level) => level === value);
}

export function parseModelSelection(value: unknown): ModelSelection | null {
	if (value === null) return null;
	if (!value || typeof value !== "object" || !("provider" in value) || !("model" in value)) {
		throw new Error("请选择供应商和模型，或恢复默认配置");
	}
	const provider = typeof value.provider === "string" ? value.provider.trim() : "";
	const model = typeof value.model === "string" ? value.model.trim() : "";
	if (
		!provider ||
		!model ||
		provider.startsWith("-") ||
		model.startsWith("-") ||
		/[\r\n\0]/.test(provider + model) ||
		provider.length > 128 ||
		model.length > 256
	) {
		throw new Error("供应商或模型 ID 无效");
	}
	const thinkingLevel = "thinkingLevel" in value ? value.thinkingLevel : undefined;
	if (thinkingLevel == null) return { provider, model };
	if (!isThinkingLevel(thinkingLevel)) throw new Error("推理等级无效");
	return { provider, model, thinkingLevel };
}

export function readStoredModelSelection(value: unknown): ModelSelection | null {
	try {
		return value == null ? null : parseModelSelection(value);
	} catch {
		return null;
	}
}
