import type { ToolExecutionRecord } from "../rpc/pi-rpc-worker.ts";
import type { readPstackResource } from "./pstack-fixture.ts";

/** Match full actual source and its hash, whether loaded via `load_available_skill` or read directly via `read`. */
export function hasPstackReadEvidence(
	tools: ToolExecutionRecord[],
	expected: Pick<Awaited<ReturnType<typeof readPstackResource>>, "sha256" | "text">,
): boolean {
	const trimmedExpected = expected.text.trim();
	return tools.some((tool) => {
		if ((tool.toolName !== "load_available_skill" && tool.toolName !== "read") || tool.isError) return false;
		const result = tool.result;
		if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content))
			return false;
		return result.content.some((block: unknown) => {
			if (!block || typeof block !== "object" || !("text" in block) || typeof block.text !== "string") return false;
			if (tool.toolName === "load_available_skill") {
				return block.text.includes(expected.sha256) && block.text.includes(expected.text);
			}
			return block.text.includes(trimmedExpected);
		});
	});
}
