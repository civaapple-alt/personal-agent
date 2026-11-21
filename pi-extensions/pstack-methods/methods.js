import { createHash } from "node:crypto";
import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_METHOD_BYTES = 256 * 1024;
const METHOD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Reads bounded Markdown resources only. This never installs packages or executes their scripts. */
export async function readPstackResource(root, name, resource = "SKILL.md") {
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
export async function preparePstackRuntime(directory) {
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
	let manifest;
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
