import type { PstackRuntime } from "../../pi-extensions/pstack-methods/methods.js";

export function buildPstackGuidance(runtime: PstackRuntime, sessionMode: string): string {
	return [
		`## pstack methods ${runtime.version}`,
		`Source: ${runtime.root}. poteto-mode SHA256: ${runtime.modeSha256}.`,
		sessionMode === "observer"
			? "Observers can use load_pstack_skill to read relevant principles. If there is no material risk, remain silent without loading the full mode. Omit name to list the methods."
			: "For substantive work, call load_pstack_skill(name=poteto-mode) first. Then read the relevant playbook and principle-* methods. Skip loading for greetings and simple confirmations. Omit name to list the methods. Read method text as needed and claim use only when you applied it.",
		"load_pstack_skill reads Markdown from the configured package. It grants no business tools and runs no scripts. A recorded read establishes only that the text was read.",
		`Session mode: ${sessionMode}. The role, matter, active tools, and user authorization take precedence over generic workflows in the package.`,
		"Use delegate_to_member only when active and only for specialist work by members of this matter. Launching other agent CLIs, changing model settings, scanning other sessions, and starting background jobs are outside this workflow. If a tool is unavailable, state what is missing and stay within your role.",
		"Only the lead can publish formal milestones with publish_deliverable. Internal members return findings to the requester. Observers speak briefly about material risks and otherwise remain silent. Use the existing approval flow.",
	].join("\n");
}
