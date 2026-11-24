import type { AgentMessage } from "./types.ts";

interface PromptUsage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Pi reports input separately from cache reads and writes. Use final assistant events, once per request. */
export function summarizePromptUsage(messages: AgentMessage[]) {
	const requests = messages.flatMap((message) => {
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") {
			return [];
		}
		if (!message.usage || typeof message.usage !== "object") return [];
		const { input, cacheRead, cacheWrite } = message.usage as Partial<PromptUsage>;
		if (typeof input !== "number" || typeof cacheRead !== "number" || typeof cacheWrite !== "number") return [];
		if (![input, cacheRead, cacheWrite].every((count) => Number.isFinite(count) && count >= 0)) return [];
		if (input + cacheRead + cacheWrite === 0) return [];
		return [
			{
				provider: typeof message.provider === "string" ? message.provider : null,
				model: typeof message.model === "string" ? message.model : null,
				input,
				cacheRead,
				cacheWrite,
			},
		];
	});
	const firstRequest = requests[0];
	if (!firstRequest) return undefined;
	const totals = requests.reduce(
		(acc, request) => ({
			input: acc.input + request.input,
			cacheRead: acc.cacheRead + request.cacheRead,
			cacheWrite: acc.cacheWrite + request.cacheWrite,
		}),
		{ input: 0, cacheRead: 0, cacheWrite: 0 },
	);
	return { firstRequest, totals, requests: requests.length };
}
