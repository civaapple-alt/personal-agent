import { type PstackRuntime, preparePstackRuntime } from "../../../pi-extensions/pstack-methods/methods.js";
import type { WorkerSessionMode } from "../../orchestrator/types.ts";
import { resolveBuiltinExtensionPath } from "../builtin-paths.ts";

export const PSTACK_TOOL_NAME = "load_pstack_skill";

function buildPstackGuidance(runtime: PstackRuntime, sessionMode: WorkerSessionMode): string {
	return [
		`## pstack methods ${runtime.version}`,
		`Source: ${runtime.root}. poteto-mode SHA256: ${runtime.modeSha256}.`,
		sessionMode === "observer"
			? "Observers can use load_pstack_skill to read relevant principles. If there is no material risk, remain silent without loading the full mode. Omit name to list the methods."
			: "When helpful, discover available Skills and choose relevant methods for this task. The pstack methods tool can also list and read the configured pack. Read method text as needed and claim use only when you applied it.",
		"load_pstack_skill reads Markdown from the configured package. It grants no business tools and runs no scripts. A recorded read establishes only that the text was read.",
		`Session mode: ${sessionMode}. The role, matter, active tools, and user authorization take precedence over generic workflows in the package.`,
		"Use delegate_to_member only when active and only for specialist work by members of this matter. Launching other agent CLIs, changing model settings, scanning other sessions, and starting background jobs are outside this workflow. If a tool is unavailable, state what is missing and stay within your role.",
		"The lead can save plans, notes and results to the matter space using save_space_page. Internal members return findings to the requester. Observers speak briefly about material risks and otherwise remain silent.",
	].join("\n");
}

export async function preparePstackForWorker(pstackDir: string | undefined, sessionMode: WorkerSessionMode) {
	if (!pstackDir) return undefined;

	const runtime = await preparePstackRuntime(pstackDir);
	return {
		args: ["--skill", `${runtime.root}/skills`, "--extension", resolveBuiltinExtensionPath("pstack-extension")],
		tools: [PSTACK_TOOL_NAME],
		env: { PA_PSTACK_DIR: runtime.root },
		systemPrompt: buildPstackGuidance(runtime, sessionMode),
		readyDetails: {
			version: runtime.version,
			root: runtime.root,
			modeSha256: runtime.modeSha256,
			availableSkillCount: runtime.skills.length,
		},
	};
}
