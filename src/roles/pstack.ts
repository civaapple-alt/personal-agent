import { createHash } from "node:crypto";
import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_METHOD_BYTES = 256 * 1024;
const METHOD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface PstackRuntime {
	root: string;
	version: string;
	modePath: string;
	modeSha256: string;
	skills: Array<{ name: string; description: string }>;
}

/** Reads bounded Markdown resources only. This never installs packages or executes their scripts. */
export async function readPstackResource(root: string, name: string, resource = "SKILL.md") {
	if (!METHOD_ID.test(name)) throw new Error("Invalid pstack skill name");
	if (isAbsolute(resource) || !resource.endsWith(".md"))
		throw new Error("Only relative Markdown resources are supported");
	const skillsRoot = await realpath(resolve(root, "skills"));
	const path = await realpath(resolve(skillsRoot, name, resource));
	const local = relative(skillsRoot, path);
	if (!local || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) {
		throw new Error("pstack resource must remain inside the configured skills directory");
	}
	const file = await open(path, "r");
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > MAX_METHOD_BYTES) throw new Error("pstack method must be a bounded file");
		const buffer = Buffer.alloc(MAX_METHOD_BYTES + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		if (offset > MAX_METHOD_BYTES) throw new Error("pstack method is too large");
		const bytes = buffer.subarray(0, offset);
		return {
			name,
			resource,
			path,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			text: bytes.toString("utf8"),
		};
	} finally {
		await file.close();
	}
}

/** Requires the complete pack: the curated ChatGPT subset has no poteto-mode. */
export async function preparePstackRuntime(directory: string): Promise<PstackRuntime> {
	const root = await realpath(directory);
	const mode = await readPstackResource(root, "poteto-mode");
	const entries = await readdir(resolve(root, "skills"), { withFileTypes: true });
	const skills = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if ((!entry.isDirectory() && !entry.isSymbolicLink()) || !METHOD_ID.test(entry.name)) continue;
		const method = await readPstackResource(root, entry.name);
		const description = method.text
			.match(/^description:[ \t]*(.+)$/m)?.[1]
			?.trim()
			.replace(/^["']|["']$/g, "");
		if (description) skills.push({ name: entry.name, description });
	}
	const manifestFile = await open(resolve(root, "plugin.json"), "r");
	let manifest: unknown;
	try {
		if ((await manifestFile.stat()).size > 64 * 1024) throw new Error("pstack manifest is too large");
		manifest = JSON.parse(await manifestFile.readFile("utf8"));
	} finally {
		await manifestFile.close();
	}
	if (
		!manifest ||
		typeof manifest !== "object" ||
		!("name" in manifest) ||
		manifest.name !== "pstack" ||
		!("version" in manifest) ||
		typeof manifest.version !== "string" ||
		!manifest.version.trim()
	) {
		throw new Error("Expected a versioned pstack plugin.json");
	}
	return { root, version: manifest.version, modePath: mode.path, modeSha256: mode.sha256, skills };
}

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
