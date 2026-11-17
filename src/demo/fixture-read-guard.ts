import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Demo-only read boundary: recall must not inspect the operator's real sessions. */
export async function fixtureReadAllowed(path: string, cwd: string, roots: string[]): Promise<boolean> {
	const expanded = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);
	let probe = expanded;
	let actual = await realpath(probe).catch(() => null);
	// Let the normal read tool report ENOENT inside an approved root. A missing
	// fixture is not evidence that the caller tried to read a private project.
	while (!actual) {
		const parent = dirname(probe);
		if (parent === probe) return false;
		probe = parent;
		actual = await realpath(probe).catch(() => null);
	}
	for (const root of roots) {
		const allowed = await realpath(root).catch(() => null);
		if (!allowed) continue;
		const local = relative(allowed, actual);
		if (!local || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`))) return true;
	}
	return false;
}

export default function fixtureReadGuard(pi: {
	on(
		event: "tool_call",
		handler: (event: { toolName: string; input: unknown }) => Promise<{ block: true; reason: string } | undefined>,
	): void;
}): void {
	const raw: unknown = JSON.parse(process.env.PA_FIXTURE_READ_ROOTS ?? "null");
	if (!Array.isArray(raw) || !raw.every((root): root is string => typeof root === "string"))
		throw new Error("Invalid fixture read roots");
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "read") return;
		const input = event.input;
		if (
			!input ||
			typeof input !== "object" ||
			!("path" in input) ||
			typeof input.path !== "string" ||
			!(await fixtureReadAllowed(input.path, process.cwd(), raw))
		) {
			return {
				block: true,
				reason:
					"This read-only workspace permits only its project, its own session directory, and approved method files. Use the current conversation and repository records; no operator/private sessions are accessible.",
			};
		}
	});
}
