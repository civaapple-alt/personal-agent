import type { readPstackResource } from "../../pi-extensions/pstack-methods/methods.js";
import type { ToolExecutionRecord } from "../rpc/pi-rpc-worker.ts";

/** Match full actual source and its hash, whether directly read or bundled as a dependency. */
export function hasPstackReadEvidence(
	tools: ToolExecutionRecord[],
	expected: Pick<Awaited<ReturnType<typeof readPstackResource>>, "sha256" | "text">,
): boolean {
	return tools.some((tool) => {
		if (!["load_pstack_skill", "load_available_skill"].includes(tool.toolName) || tool.isError) return false;
		const result = tool.result;
		if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content))
			return false;
		return result.content.some((block: unknown) =>
			Boolean(
				block &&
					typeof block === "object" &&
					"text" in block &&
					typeof block.text === "string" &&
					block.text.includes(expected.sha256) &&
					block.text.includes(expected.text),
			),
		);
	});
}
