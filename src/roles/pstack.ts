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
		`## pstack 内循环方法包 ${runtime.version}`,
		`来源：${runtime.root}；poteto-mode SHA256：${runtime.modeSha256}。`,
		sessionMode === "observer"
			? "旁听按需调用 load_pstack_skill 读取相关原则；无实质风险时无需装载完整模式，保持静默。省略 name 可查看方法目录。"
			: "处理实质任务时先调用 load_pstack_skill(name=poteto-mode) 读取完整工作模式，再按当前任务读取适用的 playbook 与 principle-*；仅问候或简单确认不必加载。省略 name 可查看方法目录。正文按需装载，不凭名称宣称已经应用。",
		"load_pstack_skill 只读取所配置方法包内的 Markdown，不执行脚本，不增加业务工具权限。方法读取记录不是判断质量提升的证明。",
		`当前模式为 ${sessionMode}。岗位职责、当前事项、工具权限及用户授权优先于方法包中的通用工作流。`,
		"Harness 映射：需要同事时只用实际可用的 delegate_to_member，并限定在当前事项成员；它是已有岗位的专业咨询，不是任意子代理或工作树启动器。不可自行启动其他 agent CLI、改模型配置、扫描其他会话或创建后台任务。工具不可用时保留本岗位边界，说明缺失能力。",
		"主责才可调用 publish_deliverable，正式阶段结果才归档；内部成员返回专业意见；旁听保持精简，无实质风险时静默。普通过程交流不新增审批。",
	].join("\n");
}
