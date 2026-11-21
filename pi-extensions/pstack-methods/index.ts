import { preparePstackRuntime, readPstackResource } from "./methods.js";

interface PstackExtensionApi {
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: object;
		execute(
			callId: string,
			args: unknown,
			signal?: AbortSignal,
		): Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;
	}): void;
}

/** A method reader for Pi, including roles without general filesystem tools. */
export async function registerPstackExtension(pi: PstackExtensionApi, directory: string): Promise<void> {
	const runtime = await preparePstackRuntime(directory);
	const names = new Set(runtime.skills.map((skill) => skill.name));
	const loaded = new Set<string>();
	pi.registerTool({
		name: "load_pstack_skill",
		label: "读取 pstack 方法",
		description:
			"Read actual pstack methods, principles and playbooks. Start with name=poteto-mode. Omit name to list methods. resource is a relative Markdown path within the named skill (default SKILL.md). This grants no business tools and executes no scripts.",
		parameters: {
			type: "object",
			properties: { name: { type: "string" }, resource: { type: "string" } },
			additionalProperties: false,
		},
		execute: async (_callId, raw, signal) => {
			signal?.throwIfAborted();
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected method arguments");
			const name = "name" in raw ? raw.name : undefined;
			const resource = "resource" in raw ? raw.resource : undefined;
			if (name === undefined && resource === undefined)
				return {
					content: [{ type: "text", text: JSON.stringify(runtime.skills) }],
					details: { version: runtime.version, kind: "catalog" },
				};
			if (typeof name !== "string" || !names.has(name) || (resource !== undefined && typeof resource !== "string")) {
				throw new Error("Unknown pstack skill or invalid resource");
			}
			let method: Awaited<ReturnType<typeof readPstackResource>>;
			try {
				method = await readPstackResource(runtime.root, name, resource);
			} catch (cause) {
				throw new Error(
					`Cannot read pstack ${name}/${resource ?? "SKILL.md"}. Load a sibling skill with {"name":"principle-fix-root-causes"}; load a mode playbook with {"name":"poteto-mode","resource":"playbooks/bug-fix.md"}. Use {} for the actual catalogue.`,
					{ cause },
				);
			}
			signal?.throwIfAborted();
			const resources = [method];
			// The observed bug-fix path skipped its applicable leaf methods. Resolve these
			// dependencies as real resources, not another request for the model to remember them.
			if (name === "poteto-mode" && resource === "playbooks/bug-fix.md") {
				for (const dependency of ["principle-fix-root-causes", "principle-prove-it-works"]) {
					resources.push(await readPstackResource(runtime.root, dependency));
					signal?.throwIfAborted();
				}
			}
			for (const item of resources) loaded.add(`${item.name}/${item.resource}`);
			const navigation = [
				"## Personal Agent method navigation",
				"Sibling skills are names, not files under poteto-mode. To read a principle use load_pstack_skill({name: 'principle-fix-root-causes'}) or load_pstack_skill({name: 'principle-prove-it-works'}). resource defaults to SKILL.md. For a playbook use name=poteto-mode, resource=playbooks/bug-fix.md. Use {} for other exact names.",
				`Successfully loaded in this worker: ${[...loaded].join(", ")}. This records reads only, not application or quality.`,
				"Before citing a named principle as a basis for your decision, read its actual leaf SKILL.md. Reading poteto-mode or its playbook alone does not read the principles they mention.",
			].join("\n");
			return {
				content: [
					{
						type: "text",
						text: `${resources.map((item) => `Source: ${item.path}\nSHA256: ${item.sha256}\n\n${item.text}`).join("\n\n")}\n\n${navigation}`,
					},
				],
				details: {
					name,
					resource: method.resource,
					path: method.path,
					sha256: method.sha256,
					version: runtime.version,
					resources: resources.map(({ name, resource, path, sha256 }) => ({ name, resource, path, sha256 })),
				},
			};
		},
	});
}

export default async function pstackExtension(pi: PstackExtensionApi): Promise<void> {
	const directory = process.env.PA_PSTACK_DIR?.trim();
	if (directory) await registerPstackExtension(pi, directory);
}
